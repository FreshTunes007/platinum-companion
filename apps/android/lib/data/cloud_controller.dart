import 'artwork_cache.dart';
import 'journey_repository.dart';
import 'companion_repository.dart';

import 'dart:convert';
import 'dart:async';

import 'package:flutter/foundation.dart';

import 'cloud_api.dart';
import 'cloud_auth.dart';
import 'snapshot_repository.dart';
import 'library_entry.dart';
import 'models.dart';

class CloudController extends ChangeNotifier {
  CloudController({
    required this.repository,
    required this.auth,
    required this.transport,
    this.libraryStorage,
    this.artworkCache,
    this.journeyRepository,
    this.companionRepository,
  });
  final TrophyRepository repository;
  final CompanionAuth auth;
  final CloudTransport transport;
  final SnapshotStorage? libraryStorage;
  final ArtworkCache? artworkCache;
  final JourneyRepository? journeyRepository;
  final CompanionRepository? companionRepository;
  late final companions =
      companionRepository ??
      CompanionRepository(
        request: journeyRequest,
        storage: const NativeConversationStorage(),
        journeys: journeys,
      );
  late final journeys =
      journeyRepository ??
      JourneyRepository(
        request: journeyRequest,
        storage: const NativeJourneyStorage(),
      );
  Future<Map<String, dynamic>> journeyRequest(
    String path, {
    String method = 'GET',
    Map<String, dynamic>? body,
  }) async {
    final data = await _request(path, method: method, body: body);
    if (_indexOwner == null || data['ownerId'] != _indexOwner) {
      throw const CloudFailure('owner_mismatch');
    }
    return data;
  }

  List<LibraryEntry> library = [];
  Map<String, dynamic>? libraryTotals, initialImport;
  String? _indexOwner;
  CloudConfiguration? configuration;
  bool busy = false, requiresLogin = false;
  String? error, notice;
  int? revision;
  Map<String, dynamic>? syncStatus;
  List<Map<String, dynamic>> devices = [];
  DateTime? _lastCheck;
  Timer? _importPoll;
  @override
  void dispose() {
    _importPoll?.cancel();
    super.dispose();
  }

  bool get connected => configuration != null && !requiresLogin;

  Future<void> initialize() async {
    await _operation(() async {
      if (libraryStorage != null) {
        try {
          final text = await libraryStorage!.read();
          if (text != null) {
            final index = jsonDecode(text) as Map<String, dynamic>;
            final owner = index['ownerId'];
            if (owner is! String ||
                !RegExp(r'^[a-f0-9]{64}$').hasMatch(owner)) {
              throw const FormatException('invalid_library_owner');
            }
            _indexOwner = owner;
            library = (index['games'] as List).map(LibraryEntry.parse).toList();
            libraryTotals = index['totals'] as Map<String, dynamic>?;
            initialImport = index['initialImport'] as Map<String, dynamic>?;
          }
        } catch (_) {
          library = [];
        }
      }
      configuration = await auth.restore();
      if (configuration != null) await _fetch();
    });
  }

  Future<void> _operation(Future<void> Function() action) async {
    if (busy) return;
    busy = true;
    error = null;
    notice = null;
    notifyListeners();
    try {
      await action();
    } catch (e) {
      if (e is CloudFailure && e.code == 'login_required') requiresLogin = true;
      error = switch (e) {
        CloudFailure(code: 'login_required') => 'Войдите снова: сеанс истёк или доступ отозван. Офлайн-библиотека сохранена.',
        CloudFailure(code: 'https_origin_required') =>
          'Нужен адрес HTTPS-сервера без пути, параметров и пароля.',
        CloudFailure(code: 'owner_mismatch') => 'Аккаунт не совпадает с владельцем библиотеки. Смешивание данных заблокировано.',
        CloudFailure(code: 'snapshot_rejected') =>
          repository.error ?? 'Снимок отклонён. Библиотека сохранена.',
        _ => 'Облако недоступно или ответ не прошёл проверку. Сохранённые данные доступны офлайн.',
      };
    } finally {
      busy = false;
      notifyListeners();
    }
  }

  Future<Map<String, dynamic>> _request(
    String path, {
    String method = 'GET',
    Map<String, dynamic>? body,
  }) async {
    final config = configuration;
    if (config == null) throw const CloudFailure('login_required');
    final token = await auth.accessToken();
    return transport.request(
      config.origin.resolve(path),
      method: method,
      token: token,
      body: body,
    );
  }

  Future<void> connect(String origin) => _operation(() async {
    final base = secureOrigin(origin);
    final config = CloudConfiguration.parse(
      base,
      await transport.request(base.resolve('/.well-known/platinum-companion')),
    );
    // Check the discovered issuer before giving it control of authorization.
    final discovery = await transport.request(
      Uri.parse(
        '${config.issuer.replaceAll(RegExp(r'/$'), '')}/.well-known/openid-configuration',
      ),
    );
    if (discovery['issuer'] != config.issuer ||
        !['authorization_endpoint', 'token_endpoint'].every((k) {
          final uri = Uri.tryParse(
            discovery[k] is String ? discovery[k] as String : '',
          );
          return uri != null &&
              uri.scheme == 'https' &&
              uri.host.isNotEmpty &&
              uri.userInfo.isEmpty;
        })) {
      throw const CloudFailure('invalid_configuration');
    }
    await auth.login(config);
    configuration = config;
    requiresLogin = false;
    revision = null;
    await _fetch();
  });

  Future<void> _fetch() async {
    final me = await _request('/api/v1/me');
    final owner = me['ownerId'];
    if (owner is! String ||
        !RegExp(r'^[a-f0-9]{64}$').hasMatch(owner) ||
        repository.ownerId != null && repository.ownerId != owner) {
      throw const CloudFailure('owner_mismatch');
    }
    syncStatus = await _request('/api/v1/status');
    if (syncStatus!['ownerId'] != owner) {
      throw const CloudFailure('owner_mismatch');
    }
    // Revision is accepted only after the whole validated snapshot is durable.
    if (libraryStorage != null) {
      await _fetchIndex(owner);
      revision = me['revision'] as int;
    } else if (revision != me['revision'] || repository.snapshot == null) {
      final value = await _request('/api/v1/snapshot');
      if (value['ownerId'] != owner ||
          value['revision'] is! int ||
          value['revision'] < 0) {
        throw const CloudFailure('invalid_response');
      }
      final imported = await repository.importJson(
        jsonEncode(value['snapshot']),
        cloudOwnerId: owner,
      );
      if (imported == null) throw const CloudFailure('snapshot_rejected');
      if (imported.retainedConfirmed > 0) {
        notice =
            'Снимок сервера получен. Для ${imported.retainedConfirmed} игр сохранены подтверждённые данные PSN на телефоне: импортированная копия их не заменяет. Свежая синхронизация PSN не выполнялась.';
      }
      revision = value['revision'] as int;
    }
    _lastCheck = DateTime.now();
    requiresLogin = false;
  }

  Future<void> _fetchIndex(String owner) async {
    if (_indexOwner != null && _indexOwner != owner) {
      throw const CloudFailure('owner_mismatch');
    }
    final incoming = <LibraryEntry>[];
    Map<String, dynamic>? first;
    int? offset = 0;
    for (var page = 0; offset != null && page < 100; page++) {
      final data = await _request('/api/v2/library?offset=$offset&limit=100');
      if (data['ownerId'] != owner || data['games'] is! List) {
        throw const CloudFailure('invalid_response');
      }
      first ??= data;
      incoming.addAll((data['games'] as List).map(LibraryEntry.parse));
      final next = data['nextOffset'];
      if (next != null && (next is! int || next <= offset)) {
        throw const CloudFailure('invalid_response');
      }
      offset = next as int?;
    }
    if (offset != null ||
        incoming.map((e) => e.gameId).toSet().length != incoming.length ||
        incoming.length != first?['total']) {
      throw const CloudFailure('invalid_response');
    }
    final index = {
      'ownerId': owner,
      'games': incoming.map((e) => e.value).toList(),
      'totals': first?['totals'],
      'initialImport': first?['initialImport'],
    };
    await libraryStorage!.write(jsonEncode(index));
    library = incoming;
    final priority = [
      ...incoming.where((e) => e.active),
      ...incoming.where((e) => !e.active),
    ];
    if (artworkCache != null) {
      unawaited(
        artworkCache!.prefetch(
          priority.take(12).map((e) => e.artwork?.preferred),
        ),
      );
    }
    libraryTotals = first?['totals'] as Map<String, dynamic>?;
    initialImport = first?['initialImport'] as Map<String, dynamic>?;
    _indexOwner = owner;
    _importPoll?.cancel();
    if (initialImport?['status'] != 'complete' && connected) {
      _importPoll = Timer(const Duration(seconds: 60), () {
        if (!busy && connected) refresh();
      });
    }
  }

  Future<GameRecord?> loadGame(LibraryEntry entry) async {
    GameRecord? cached;
    for (final game in repository.games) {
      if (game.id == entry.id) cached = game;
    }
    if (!connected) return cached?.withArtwork(entry.artwork);
    GameRecord? fetched;
    await _operation(() async {
      final data = await _request(
        '/api/v2/games/${entry.gameId}?neutralGroups=true',
      );
      if (data['ownerId'] != _indexOwner) {
        throw const CloudFailure('owner_mismatch');
      }
      final imported = await repository.importJson(
        jsonEncode(data['snapshot']),
        cloudOwnerId: _indexOwner,
        allowGroupReclassification:
            data['groupSemantics'] == 'source_supported',
      );
      if (imported == null) throw const CloudFailure('snapshot_rejected');
      fetched = repository.games.singleWhere((g) => g.id == entry.id);
    });
    return (fetched ?? cached)?.withArtwork(entry.artwork);
  }

  Future<void> setActive(LibraryEntry entry, bool active) =>
      _operation(() async {
        await _request(
          '/api/v2/games/${entry.gameId}/active',
          method: 'PUT',
          body: {'active': active},
        );
        await _fetch();
      });
  Future<void> checkOnResume() async {
    if (!connected ||
        busy ||
        _lastCheck != null &&
            DateTime.now().difference(_lastCheck!).inSeconds < 30) {
      return;
    }
    await refresh();
  }

  Future<void> refresh({bool requestPsn = false}) => _operation(() async {
    if (requestPsn) {
      final result = await _request('/api/v1/sync', method: 'POST');
      if (result['status'] == 'cooldown') {
        notice = 'Обновление PSN пока на паузе. Загружен последний сохранённый снимок.';
      } else if (['accepted', 'in_progress'].contains(result['status'])) {
        notice = 'Запрос PSN принят. Проверяем результат…';
        notifyListeners();
        for (var i = 0; i < 20; i++) {
          await Future<void>.delayed(const Duration(seconds: 2));
          final status = await _request('/api/v1/status');
          if (status['running'] == false) break;
        }
        notice =
            'Проверен сохранённый снимок. Результат запроса PSN указан ниже.';
      }
    }
    await _fetch();
  });

  Future<void> loadDevices() => _operation(() async {
    final value = await _request('/api/v1/devices');
    final list = value['devices'];
    if (list is! List || list.length > 1000) {
      throw const CloudFailure('invalid_response');
    }
    devices = list.map((e) => Map<String, dynamic>.from(e as Map)).toList();
  });
  Future<void> revoke(String id) => _operation(() async {
    if (!RegExp(r'^[a-f0-9]{64}$').hasMatch(id)) {
      throw const CloudFailure('invalid_response');
    }
    await _request('/api/v1/devices/$id', method: 'DELETE');
    if (devices.any((d) => d['id'] == id && d['current'] == true)) {
      await auth.clear();
      configuration = null;
      devices = [];
      revision = null;
    } else {
      devices = devices.where((d) => d['id'] != id).toList();
    }
  });
  Future<void> disconnect() => _operation(() async {
    var revoked = false;
    try {
      final me = await _request('/api/v1/me');
      final id = me['deviceId'];
      if (id is String && RegExp(r'^[a-f0-9]{64}$').hasMatch(id)) {
        await _request('/api/v1/devices/$id', method: 'DELETE');
        revoked = true;
      }
    } catch (_) {
      /* Local logout still works without a network. */
    }
    await auth.clear();
    configuration = null;
    revision = null;
    devices = [];
    requiresLogin = false;
    notice = revoked ? 'Доступ устройства отозван. Библиотека сохранена.' : 'Локальный вход удалён. Серверный отзыв не подтверждён: при необходимости отзовите этот сеанс с другого устройства.';
  });
}
