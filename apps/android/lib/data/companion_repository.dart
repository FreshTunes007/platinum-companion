import 'dart:convert';
import 'dart:math';

import 'package:flutter/services.dart';

import 'cloud_api.dart';
import 'journey_repository.dart';
import 'snapshot_repository.dart';

/// Conversation text and confirmed proposals stay on this device. Image bytes
/// are transient and are deliberately excluded from durable storage.
class NativeConversationStorage implements SnapshotStorage {
  const NativeConversationStorage();
  static const channel = MethodChannel('platinum_companion/files');
  @override
  Future<String?> read() => channel.invokeMethod<String>('readConversations');
  @override
  Future<void> write(String json) =>
      channel.invokeMethod<void>('writeConversations', {'json': json});
  @override
  Future<void> clear() => write('{}');
}

class CompanionImage {
  const CompanionImage({
    required this.mimeType,
    required this.bytes,
    required this.width,
    required this.height,
  });
  final String mimeType;
  final Uint8List bytes;
  final int width, height;
  Map<String, dynamic> toRequest() => {
    'mimeType': mimeType,
    'dataBase64': base64Encode(bytes),
  };
}

abstract interface class GameImagePicker {
  Future<List<CompanionImage>> pick();
}

/// Android's document picker gives temporary access to selected images only.
/// Native code checks the decoder, pixel/byte budgets and strips metadata.
class NativeGameImagePicker implements GameImagePicker {
  const NativeGameImagePicker();
  @override
  Future<List<CompanionImage>> pick() async {
    final raw = await NativeConversationStorage.channel
        .invokeListMethod<dynamic>('pickGameImages');
    if (raw == null) return [];
    if (raw.length > 3) throw const FormatException('image_limit');
    return raw.map((value) {
      final image = Map<String, dynamic>.from(value as Map);
      final bytes = base64Decode(image['dataBase64'] as String);
      final mime = image['mimeType'];
      final width = image['width'], height = image['height'];
      if (!['image/jpeg', 'image/png'].contains(mime) ||
          bytes.isEmpty ||
          bytes.length > 3 * 1024 * 1024 ||
          width is! int ||
          height is! int ||
          width <= 0 ||
          height <= 0 ||
          width * height > 12000000) {
        throw const FormatException('invalid_image');
      }
      return CompanionImage(
        mimeType: mime as String,
        bytes: bytes,
        width: width,
        height: height,
      );
    }).toList();
  }
}

class CompanionRepository {
  CompanionRepository({
    required this.request,
    required this.storage,
    this.picker = const NativeGameImagePicker(),
    this.journeys,
  });
  final JourneyRequest request;
  final SnapshotStorage storage;
  final GameImagePicker picker;
  final JourneyRepository? journeys;
  static const maxStorageBytes = 4 * 1024 * 1024;
  Map<String, dynamic> _cache = {}, _pending = {};
  final Map<String, Map<String, dynamic>> _transientCommands = {};
  String? _owner;
  bool _loaded = false, _mutating = false;
  bool offline = false;
  bool externalTransferConsent = false;
  String? error;
  String _key(String id, bool reveal) => '$id:${reveal ? 'full' : 'safe'}';

  Future<void> initialize() async {
    if (_loaded) return;
    try {
      final raw = await storage.read();
      if (raw != null && raw != '{}') {
        if (utf8.encode(raw).length > maxStorageBytes) {
          throw const FormatException('conversation_storage_limit');
        }
        final d = jsonDecode(raw) as Map<String, dynamic>;
        if (d['storageVersion'] != 1 ||
            d['ownerId'] is! String ||
            d['contexts'] is! Map ||
            d['pending'] is! Map) {
          throw const FormatException('conversation_storage_format');
        }
        _owner = d['ownerId'] as String;
        _cache = Map<String, dynamic>.from(d['contexts'] as Map);
        _pending = Map<String, dynamic>.from(d['pending'] as Map);
        externalTransferConsent = d['externalTransferConsent'] == true;
      }
    } catch (_) {
      error =
          'Историю на устройстве не удалось прочитать. Исходный файл сохранён.';
    }
    _loaded = true;
  }

  Future<void> setExternalTransferConsent(bool value) async {
    await initialize();
    externalTransferConsent = value;
    if (_owner != null) await _save();
  }

  Future<void> _save() async {
    Map<String, dynamic> envelope() => {
      'storageVersion': 1,
      'ownerId': _owner,
      'contexts': _cache,
      'pending': _pending,
      'externalTransferConsent': externalTransferConsent,
    };
    var json = jsonEncode(envelope());
    // Preserve unresolved commands; evict oldest cached game projections only.
    while (utf8.encode(json).length > maxStorageBytes && _cache.length > 1) {
      _cache.remove(_cache.keys.first);
      json = jsonEncode(envelope());
    }
    if (utf8.encode(json).length > maxStorageBytes) {
      throw const FormatException('conversation_storage_limit');
    }
    await storage.write(json);
  }

  Map<String, dynamic>? cached(String id, {bool reveal = false}) =>
      _cache[_key(id, reveal)] as Map<String, dynamic>?;
  bool pending(String id) => _pending.containsKey(id);
  bool pendingImagesNeedReselection(String id) =>
      (_pending[id] as Map?)?['requiresImages'] == true &&
      !_transientCommands.containsKey(id);
  bool canRetry(String id) => pending(id) && !pendingImagesNeedReselection(id);

  void _validate(String id, bool reveal, Map<String, dynamic> data) {
    if (data['schemaVersion'] != 1 ||
        data['gameId'] != id ||
        data['ownerId'] is! String ||
        (_owner != null && data['ownerId'] != _owner) ||
        data['revision'] is! int ||
        data['revision'] < 0 ||
        data['messages'] is! List ||
        (data['messages'] as List).length > 200 ||
        data['proposals'] is! List ||
        (data['proposals'] as List).length > 100 ||
        data['provider'] is! Map ||
        data['fields'] is! Map ||
        data['currentRunFacts'] is! Map ||
        (data.containsKey('revealed') && data['revealed'] != reveal)) {
      throw const CloudFailure('invalid_companion_response');
    }
    for (final value in data['messages'] as List) {
      if (value is! Map ||
          value['text'] is! String ||
          value['role'] is! String) {
        throw const CloudFailure('invalid_companion_response');
      }
    }
    for (final value in data['proposals'] as List) {
      if (value is! Map || value['id'] is! String || value['items'] is! List) {
        throw const CloudFailure('invalid_companion_response');
      }
    }
  }

  Future<void> _accept(
    String id,
    bool reveal,
    Map<String, dynamic> data,
  ) async {
    _validate(id, reveal, data);
    final current = cached(id, reveal: reveal);
    if (current?['revision'] is int &&
        current!['revision'] > data['revision']) {
      return;
    }
    _owner = data['ownerId'] as String;
    final key = _key(id, reveal);
    _cache.remove(key);
    _cache[key] = data;
    final other = _key(id, !reveal);
    if ((_cache[other] as Map?)?['revision'] != data['revision']) {
      _cache.remove(other);
    }
    await _save();
  }

  Future<void> _cacheJourney(
    String id,
    bool reveal,
    Map<String, dynamic> data,
  ) async {
    final journeyRepository = journeys;
    if (journeyRepository == null) return;
    final current = journeyRepository.cached(id, reveal: reveal);
    if (current?['revision'] is int &&
        current!['revision'] >= data['revision']) {
      return;
    }
    if (data['journey'] is Map &&
        data['journey']['ownerId'] == data['ownerId']) {
      await journeyRepository.acceptExternalContext(
        id,
        Map<String, dynamic>.from(data['journey'] as Map),
        reveal: reveal,
      );
    } else {
      // GET the authoritative compact route, never fabricate it from chat fields.
      await journeyRepository.load(id, reveal: reveal);
    }
  }

  Future<Map<String, dynamic>?> load(String id, {bool reveal = false}) async {
    await initialize();
    error = null;
    try {
      final data = await request(
        '/api/v2/games/$id/companion?reveal=$reveal',
        method: 'GET',
      );
      await _accept(id, reveal, data);
      await _cacheJourney(id, reveal, data);
      final receipt = (_pending[id] as Map?)?['requestId'];
      final applied = data['appliedRequestIds'] as List? ?? [];
      // A visible processing message is not a completed receipt. Only the
      // server's completed request collection can settle an uncertain result.
      if (receipt != null && applied.contains(receipt)) {
        _pending.remove(id);
        _transientCommands.remove(id);
        await _save();
      }
      offline = false;
    } catch (_) {
      offline = true;
      error = 'Компаньон недоступен по сети. Сохранённая история доступна; отправка и подтверждение требуют подключения.';
    }
    return cached(id, reveal: reveal);
  }

  Future<Map<String, dynamic>?> sendMessage(
    String id,
    String text, {
    List<CompanionImage> images = const [],
    bool reveal = false,
  }) => _submit(id, {
    'type': 'message',
    'text': text.trim(),
    if (images.isNotEmpty) 'images': images.map((i) => i.toRequest()).toList(),
    'consentExternal': externalTransferConsent,
    'reveal': reveal,
  }, reveal: reveal);

  Future<Map<String, dynamic>?> manualProposal(
    String id,
    List<Map<String, dynamic>> items, {
    String? text,
    bool reveal = false,
  }) => _submit(id, {
    'type': 'manual',
    'items': items,
    if (text != null && text.trim().isNotEmpty) 'text': text.trim(),
    'reveal': reveal,
  }, reveal: reveal);

  Future<Map<String, dynamic>?> resolve(
    String id,
    String proposalId,
    List<Map<String, dynamic>> decisions, {
    bool reveal = false,
  }) => _submit(id, {
    'type': 'resolve',
    'proposalId': proposalId,
    'decisions': decisions,
    'reveal': reveal,
  }, reveal: reveal);

  Future<Map<String, dynamic>?> retry(String id, {bool reveal = false}) async {
    if (pendingImagesNeedReselection(id)) {
      await load(id, reveal: reveal);
      if (pending(id)) {
        error = 'Исходная отправка ещё не подтверждена. Изображения удалены из памяти после закрытия приложения. Обновите историю позже; повторно не отправляйте сообщение, пока результат неизвестен.';
      }
      return cached(id, reveal: reveal);
    }
    return _submit(id, {}, reveal: reveal);
  }

  Future<Map<String, dynamic>?> _submit(
    String id,
    Map<String, dynamic> command, {
    required bool reveal,
  }) async {
    await initialize();
    if (_mutating) return cached(id, reveal: reveal);
    _mutating = true;
    error = null;
    try {
      if (!pending(id)) {
        if (_owner == null || cached(id, reveal: reveal) == null) {
          throw const CloudFailure('login_required');
        }
        final bytes = List.generate(18, (_) => Random.secure().nextInt(256));
        final body = {
          ...command,
          'requestId': base64UrlEncode(bytes),
          'expectedRevision': cached(id, reveal: reveal)?['revision'] ?? 0,
        };
        _transientCommands[id] = body;
        final durable = Map<String, dynamic>.from(body);
        if (durable.remove('images') != null) durable['requiresImages'] = true;
        _pending[id] = durable;
        await _save();
      }
      final body =
          _transientCommands[id] ??
          Map<String, dynamic>.from(_pending[id] as Map);
      if (body['requiresImages'] == true) {
        throw const CloudFailure('images_not_retained');
      }
      final data = await request(
        '/api/v2/games/$id/companion?reveal=$reveal',
        method: 'POST',
        body: body,
      );
      await _accept(id, reveal, data);
      if (!(data['appliedRequestIds'] as List? ?? []).contains(
        body['requestId'],
      )) {
        offline = false;
        error = 'Обработка ещё выполняется. Подтверждение не получено; проверьте отправку позже. Повтор использует прежний идентификатор.';
        return cached(id, reveal: reveal);
      }
      _pending.remove(id);
      _transientCommands.remove(id);
      await _save();
      await _cacheJourney(id, reveal, data);
      offline = false;
    } on CloudFailure catch (e) {
      if ([
        'journey_conflict',
        'companion_conflict',
        'companion_revision_conflict',
        'journey_revision_conflict',
      ].contains(e.code)) {
        _pending.remove(id);
        _transientCommands.remove(id);
        await _save();
        await load(id, reveal: reveal);
        error = 'Прохождение изменилось на другом устройстве. Сведения обновлены; проверьте предложения перед новым подтверждением.';
      } else if (e.code.startsWith('invalid_companion_') ||
          e.code.startsWith('invalid_journey_') ||
          [
            'invalid_request',
            'consent_required',
            'run_required',
            'companion_consent_required',
            'journey_not_started',
            'companion_item_not_pending',
            'companion_proposal_not_found',
            'request_too_large',
            'active_game_required',
          ].contains(e.code)) {
        _pending.remove(id);
        _transientCommands.remove(id);
        await _save();
        error =
            ['consent_required', 'companion_consent_required'].contains(e.code)
            ? 'Для внешнего AI нужно ваше согласие на передачу текста и выбранных изображений.'
            : ['run_required', 'journey_not_started'].contains(e.code)
            ? 'Сначала начните вести прохождение на экране пути к платине.'
            : e.code == 'invalid_companion_images' ||
                  e.code == 'request_too_large'
            ? 'Изображения не приняты. Выберите до 3 JPEG/PNG, каждый до 3 МБ и 12 мегапикселей.'
            : 'Предложенные значения не подходят этому полю. Проверьте их и повторите.';
      } else {
        offline = true;
        error = 'Ответ не получен. Проверьте отправку: повтор использует прежний идентификатор и не создаёт дубликат.';
      }
    } catch (_) {
      offline = true;
      error = 'Ответ не получен. Сохранена безопасная повторная отправка; прежний подтверждённый контекст сохранён.';
    } finally {
      _mutating = false;
    }
    return cached(id, reveal: reveal);
  }
}
