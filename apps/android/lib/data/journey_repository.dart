import 'dart:convert';
import 'dart:math';

import 'package:flutter/services.dart';

import 'snapshot_repository.dart';
import 'cloud_api.dart';

typedef JourneyRequest = Future<Map<String, dynamic>> Function(
  String path, {
  String method,
  Map<String, dynamic>? body,
});

class NativeJourneyStorage implements SnapshotStorage {
  const NativeJourneyStorage();
  static const channel = MethodChannel('platinum_companion/files');
  @override
  Future<String?> read() => channel.invokeMethod<String>('readJourneys');
  @override
  Future<void> write(String json) =>
      channel.invokeMethod<void>('writeJourneys', {'json': json});
  @override
  Future<void> clear() => write('{}');
}

class JourneyRepository {
  JourneyRepository({required this.request, required this.storage});
  final JourneyRequest request;
  final SnapshotStorage storage;
  Map<String, dynamic> _cache = {}, _pending = {};
  String? _owner;
  bool _loaded = false, _mutating = false;
  bool offline = false;
  String? error;
  String _key(String id, bool reveal) => '$id:${reveal ? 'full' : 'safe'}';
  Future<void> initialize() async {
    if (_loaded) return;
    final raw = await storage.read();
    if (raw != null) {
      final d = jsonDecode(raw) as Map<String, dynamic>;
      _owner = d['ownerId'] as String?;
      _cache = d['contexts'] as Map<String, dynamic>? ?? {};
      _pending = d['pending'] as Map<String, dynamic>? ?? {};
    }
    _loaded = true;
  }

  Future<void> _save() => storage.write(
    jsonEncode({'ownerId': _owner, 'contexts': _cache, 'pending': _pending}),
  );
  Map<String, dynamic>? cached(String id, {bool reveal = false}) =>
      _cache[_key(id, reveal)] as Map<String, dynamic>?;
  bool pending(String id) => _pending.containsKey(id);

  /// A confirmed chat response may supply the same complete route projection.
  /// Partial chat objects are never accepted as routes; older replies cannot
  /// downgrade a route already observed on this device.
  Future<bool> acceptExternalContext(
    String id,
    Map<String, dynamic> data, {
    bool reveal = false,
  }) async {
    await initialize();
    final accepted = await _accept(id, reveal, data);
    offline = false;
    error = null;
    return accepted;
  }

  Future<bool> _accept(
    String id,
    bool reveal,
    Map<String, dynamic> data,
  ) async {
    if (data['schemaVersion'] != 1 ||
        data['gameId'] != id ||
        data['revealed'] != reveal ||
        data['revision'] is! int ||
        data['actions'] is! List ||
        data['currentRunFacts'] is! Map ||
        data['updateRequests'] is! List ||
        data['history'] is! List ||
        data['ownerId'] is! String ||
        (_owner != null && data['ownerId'] != _owner)) {
      throw const CloudFailure('invalid_journey_response');
    }
    final run = data['run'];
    if (run != null && (run is! Map || run['id'] is! String)) {
      throw const CloudFailure('invalid_journey_response');
    }
    // Applies to ordinary GET/POST replies too: a delayed request must not
    // overwrite a newer route confirmed through chat or the other projection.
    for (final projection in [cached(id), cached(id, reveal: true)]) {
      if (projection == null) continue;
      final previousRun = projection['run'];
      if (previousRun is Map && previousRun['id'] != run?['id']) {
        throw const CloudFailure('invalid_journey_response');
      }
      if (projection['revision'] is int &&
          data['revision'] < projection['revision']) {
        return false;
      }
    }
    _owner = data['ownerId'] as String;
    _cache[_key(id, reveal)] = data;
    // A newly confirmed revision invalidates the other spoiler projection.
    final other = _key(id, !reveal);
    if ((_cache[other] as Map?)?['revision'] != data['revision']) {
      _cache.remove(other);
    }
    await _save();
    return true;
  }

  Future<Map<String, dynamic>?> load(String id, {bool reveal = false}) async {
    await initialize();
    error = null;
    try {
      final data = await request(
        '/api/v2/games/$id/journey?reveal=$reveal',
        method: 'GET',
      );
      await _accept(id, reveal, data);
      offline = false;
    } catch (_) {
      offline = true;
      error = 'Сервер недоступен. Показан сохранённый путь; изменения требуют подключения.';
    }
    return cached(id, reveal: reveal);
  }

  Future<Map<String, dynamic>?> confirm(
    String id,
    Map<String, dynamic> change, {
    bool reveal = false,
  }) async {
    await initialize();
    if (_mutating) return cached(id, reveal: reveal);
    _mutating = true;
    error = null;
    try {
      if (!pending(id)) {
        final bytes = List.generate(18, (_) => Random.secure().nextInt(256));
        _pending[id] = {
          ...change,
          'requestId': base64UrlEncode(bytes),
          'expectedRevision': cached(id, reveal: reveal)?['revision'] ?? 0,
        };
        await _save(); // Persist before sending: uncertain outcomes replay exactly once.
      }
      final data = await request(
        '/api/v2/games/$id/journey?reveal=$reveal',
        method: 'POST',
        body: Map<String, dynamic>.from(_pending[id] as Map),
      );
      await _accept(id, reveal, data);
      _pending.remove(id);
      await _save();
      offline = false;
    } on CloudFailure catch (e) {
      if (e.code.startsWith('invalid_journey_') ||
          e.code == 'request_rejected' ||
          e.code == 'request_too_large') {
        _pending.remove(id);
        await _save();
        error = 'Изменение отклонено. Проверьте значение и допустимый диапазон; подтверждённое состояние сохранено.';
      } else if (e.code == 'journey_conflict') {
        _pending.remove(id);
        await _save();
        await load(id, reveal: reveal);
        error = 'Состояние изменилось на другом устройстве. Проверьте обновлённые сведения и повторите подтверждение.';
      } else {
        offline = true;
        error = 'Подтверждение не получено. Нажмите «Проверить отправку»: повтор не создаст дубликат.';
      }
    } catch (_) {
      offline = true;
      error =
          'Подтверждение не получено. Сохранена безопасная повторная отправка.';
    } finally {
      _mutating = false;
    }
    return cached(id, reveal: reveal);
  }
}
