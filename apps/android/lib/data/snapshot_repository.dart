import 'dart:convert';

import 'package:flutter/foundation.dart';

import 'models.dart';
import 'snapshot_codec.dart';

/// Storage must replace its file atomically, or leave the previous file intact.
abstract interface class SnapshotStorage {
  Future<String?> read();
  Future<void> write(String json);
  Future<void> clear();
}

abstract interface class SnapshotFilePicker {
  /// Returns null when the user cancels the system file picker.
  Future<String?> pickSnapshot();
}

/// A future authenticated API adapter supplies the same normalized contract.
/// The UI never depends on Sony credentials or on a specific transport.
abstract interface class SnapshotDataSource {
  String get id;
  String get label;
  Future<String?> fetchSnapshot();
}

class ImportResult {
  const ImportResult({
    required this.added,
    required this.updated,
    required this.unchanged,
    required this.total,
    this.retainedConfirmed = 0,
  });

  final int added;
  final int updated;
  final int unchanged;
  final int total;

  /// A lower-trust cloud copy was received, but the confirmed local game won.
  /// This never promotes imported observations to provider-confirmed ones.
  final int retainedConfirmed;
  bool get changed => added > 0 || updated > 0;
}

class TrophyRepository extends ChangeNotifier {
  TrophyRepository({
    required this.storage,
    this.picker,
    DateTime Function()? clock,
  }) : _clock = clock ?? DateTime.now;

  final SnapshotStorage storage;
  final SnapshotFilePicker? picker;
  final DateTime Function() _clock;
  TrophySnapshot? _snapshot;
  String? _ownerId;
  String? get ownerId => _ownerId;
  DateTime? _importedAt;
  bool _isLoading = true;
  bool _isBusy = false;
  bool _initialized = false;
  String? _error;
  ImportResult? _lastImport;

  TrophySnapshot? get snapshot => _snapshot;
  List<GameRecord> get games => _snapshot?.games ?? const [];
  DateTime? get importedAt => _importedAt;
  bool get isLoading => _isLoading;
  bool get isBusy => _isBusy;
  bool get initialized => _initialized;
  String? get error => _error;
  ImportResult? get lastImport => _lastImport;

  Future<void> initialize() async {
    if (_initialized || _isBusy) return;
    _isBusy = true;
    _isLoading = true;
    _error = null;
    notifyListeners();
    try {
      final saved = await storage.read();
      if (saved != null) {
        if (saved.length > SnapshotCodec.maxBytes + 1024 ||
            utf8.encode(saved).length > SnapshotCodec.maxBytes + 1024) {
          throw const SnapshotFormatException(
            'Сохранённый файл слишком велик.',
          );
        }
        final envelope = jsonDecode(saved);
        if (envelope is! Map<String, dynamic> ||
            envelope.length != (envelope['storageVersion'] == 2 ? 4 : 3) ||
            envelope.keys.any(
              (k) => ![
                'storageVersion',
                'snapshot',
                'importedAt',
                if (envelope['storageVersion'] == 2) 'ownerId',
              ].contains(k),
            ) ||
            ![1, 2].contains(envelope['storageVersion']) ||
            envelope['storageVersion'] is! int ||
            !envelope.containsKey('snapshot') ||
            !envelope.containsKey('importedAt')) {
          throw const SnapshotFormatException(
            'Неизвестный формат локальной библиотеки.',
          );
        }
        final imported = envelope['importedAt'];
        if (imported is! String || !imported.endsWith('Z')) {
          throw const SnapshotFormatException(
            'Повреждена дата локального импорта.',
          );
        }
        final date = DateTime.tryParse(imported);
        if (date == null || !date.isUtc) {
          throw const SnapshotFormatException(
            'Повреждена дата локального импорта.',
          );
        }
        final loaded = SnapshotCodec.decode(jsonEncode(envelope['snapshot']));
        final owner = envelope['ownerId'];
        if (envelope['storageVersion'] == 2 &&
            (owner is! String || !RegExp(r'^[a-f0-9]{64}$').hasMatch(owner))) {
          throw const SnapshotFormatException(
            'Повреждена привязка библиотеки.',
          );
        }
        _ownerId = owner as String?;
        _snapshot = loaded;
        _importedAt = date;
      }
    } catch (_) {
      // Retain the original private file for recovery; never erase on failure.
      _error = 'Не удалось прочитать локальную библиотеку. Файл сохранён. Можно повторно импортировать снимок.';
    } finally {
      _initialized = true;
      _isLoading = false;
      _isBusy = false;
      notifyListeners();
    }
  }

  Future<ImportResult?> importJson(
    String json, {
    String? cloudOwnerId,
    bool allowGroupReclassification = false,
  }) async {
    if (_isBusy) return null;
    _isBusy = true;
    _error = null;
    _lastImport = null;
    notifyListeners();
    try {
      return await _commitImport(
        json,
        cloudOwnerId: cloudOwnerId,
        allowGroupReclassification: allowGroupReclassification,
      );
    } catch (error) {
      _error = error is SnapshotFormatException
          ? error.message
          : 'Не удалось сохранить снимок. Предыдущая библиотека не изменена.';
      return null;
    } finally {
      _isBusy = false;
      notifyListeners();
    }
  }

  Future<ImportResult?> importFromPicker() async {
    if (picker == null) {
      _error = 'Выбор файла недоступен на этом устройстве.';
      notifyListeners();
      return null;
    }
    return _importFrom(() => picker!.pickSnapshot());
  }

  Future<ImportResult?> importFromSource(SnapshotDataSource source) =>
      _importFrom(source.fetchSnapshot);

  Future<ImportResult?> _importFrom(Future<String?> Function() fetch) async {
    if (_isBusy) return null;
    _isBusy = true;
    _error = null;
    _lastImport = null;
    notifyListeners();
    try {
      final json = await fetch();
      if (json == null) return null;
      return await _commitImport(json);
    } catch (error) {
      _error = error is SnapshotFormatException
          ? error.message
          : 'Не удалось импортировать файл. Предыдущая библиотека не изменена.';
      return null;
    } finally {
      _isBusy = false;
      notifyListeners();
    }
  }

  Future<ImportResult> _commitImport(
    String json, {
    String? cloudOwnerId,
    bool allowGroupReclassification = false,
  }) async {
    if (cloudOwnerId != null &&
        (!RegExp(r'^[a-f0-9]{64}$').hasMatch(cloudOwnerId) ||
            (_ownerId != null && _ownerId != cloudOwnerId))) {
      throw const SnapshotFormatException(
        'Эта библиотека принадлежит другому аккаунту. Данные сохранены.',
      );
    }
    final nextOwner = cloudOwnerId ?? _ownerId;
    // Validate every game and trophy before even attempting a storage mutation.
    final incoming = SnapshotCodec.decode(json);
    if (incoming.games.isEmpty) {
      throw const SnapshotFormatException(
        'Снимок не содержит игр. Для удаления библиотеки используйте настройки.',
      );
    }
    final merged = {for (final game in games) game.id: game};
    var added = 0;
    var updated = 0;
    var unchanged = 0;
    var retainedConfirmed = 0;
    for (final candidate in incoming.games) {
      final previous = merged[candidate.id];
      if (previous == null) {
        final reusedIdentity = merged.values.any(
          (game) =>
              game.sony.npCommunicationId == candidate.sony.npCommunicationId &&
              game.sony.service == candidate.sony.service &&
              game.platform == candidate.platform,
        );
        if (reusedIdentity) {
          throw const SnapshotFormatException(
            'Для существующего набора Sony изменён идентификатор игры. Импорт отклонён.',
          );
        }
        merged[candidate.id] = candidate;
        added++;
        continue;
      }
      if (previous.sony.npCommunicationId != candidate.sony.npCommunicationId ||
          previous.sony.service != candidate.sony.service ||
          previous.platform != candidate.platform) {
        throw const SnapshotFormatException(
          'Идентификатор игры относится к другому набору Sony. Импорт отклонён.',
        );
      }
      if (cloudOwnerId != null &&
          previous.source == 'direct_psn_api' &&
          candidate.source == 'imported') {
        // Authenticated cloud transport does not upgrade data provenance.
        // Keep the whole stronger record (including dates/metadata), but do
        // not fail the connection because the server holds an imported seed.
        unchanged++;
        retainedConfirmed++;
        continue;
      }
      if (candidate.observedAt.isBefore(previous.observedAt)) {
        throw const SnapshotFormatException(
          'Снимок содержит более старые данные. Текущая библиотека сохранена.',
        );
      }
      if (candidate.observedAt.isAtSameMomentAs(previous.observedAt)) {
        if (candidate.contentSignature != previous.contentSignature) {
          if (allowGroupReclassification &&
              cloudOwnerId != null &&
              _neutralGroupCorrection(previous, candidate)) {
            merged[candidate.id] = candidate;
            updated++;
            continue;
          }
          throw const SnapshotFormatException(
            'Данные с одинаковой датой наблюдения различаются. Нужен новый экспорт из источника.',
          );
        }
        unchanged++;
        continue;
      }
      if (previous.source == 'direct_psn_api' &&
          candidate.source != 'direct_psn_api') {
        throw const SnapshotFormatException(
          'Импортированные данные не могут заменить подтверждённые данные PSN.',
        );
      }
      for (final old in previous.trophies) {
        final matches = candidate.trophies.where((t) => t.id == old.id);
        if (matches.isEmpty) {
          throw const SnapshotFormatException(
            'Новый каталог неполон. Библиотека сохранена.',
          );
        }
        final next = matches.single;
        if ((old.isEarned && !next.isEarned) ||
            (old.earnedAt != null && next.earnedAt != old.earnedAt) ||
            (old.description?.isNotEmpty == true &&
                next.description?.isNotEmpty != true) ||
            (old.official != null && next.official == null)) {
          throw const SnapshotFormatException(
            'Новый снимок теряет подтверждённые сведения. Нужна проверка источника; библиотека сохранена.',
          );
        }
        if ((old.official?.russianName?.isNotEmpty == true &&
                next.official?.russianName?.isNotEmpty != true) ||
            (old.official?.russianDescription?.isNotEmpty == true &&
                next.official?.russianDescription?.isNotEmpty != true)) {
          throw const SnapshotFormatException(
            'Новый снимок теряет ранее доступную локализацию. Библиотека сохранена.',
          );
        }
      }
      merged[candidate.id] = candidate;
      updated++;
    }
    final result = ImportResult(
      added: added,
      updated: updated,
      unchanged: unchanged,
      total: merged.length,
      retainedConfirmed: retainedConfirmed,
    );
    if (!result.changed && nextOwner == _ownerId) {
      _lastImport = result;
      return result;
    }
    if (merged.length > SnapshotCodec.maxGames) {
      throw const SnapshotFormatException(
        'В локальной библиотеке допускается не более 100 игр.',
      );
    }
    final previousExport = _snapshot?.exportedAt;
    final mergedSnapshot = TrophySnapshot(
      exportedAt:
          previousExport != null && previousExport.isAfter(incoming.exportedAt)
          ? previousExport
          : incoming.exportedAt,
      games: merged.values.toList(),
    );
    // The persisted library obeys the same size limit as a file import.
    final normalized = SnapshotCodec.encode(mergedSnapshot);
    if (utf8.encode(normalized).length > SnapshotCodec.maxBytes) {
      throw const SnapshotFormatException(
        'Объединённая библиотека превышает 10 МБ.',
      );
    }
    final importedAt = _clock().toUtc();
    final envelope = jsonEncode({
      'storageVersion': nextOwner == null ? 1 : 2,
      'ownerId': ?nextOwner,
      'importedAt': importedAt.toIso8601String(),
      'snapshot': mergedSnapshot.toJson(),
    });
    await storage.write(envelope);
    // Publish only after the atomic private-file replacement succeeds.
    _snapshot = mergedSnapshot;
    _ownerId = nextOwner;
    _importedAt = importedAt;
    _lastImport = result;
    _initialized = true;
    _isLoading = false;
    return result;
  }

  Future<bool> clear() async {
    if (_isBusy) return false;
    _isBusy = true;
    _error = null;
    notifyListeners();
    try {
      await storage.clear();
      _snapshot = null;
      _ownerId = null;
      _importedAt = null;
      _lastImport = null;
      _initialized = true;
      _isLoading = false;
      return true;
    } catch (_) {
      _error = 'Не удалось удалить локальную библиотеку.';
      return false;
    } finally {
      _isBusy = false;
      notifyListeners();
    }
  }

  void clearError() {
    _error = null;
    notifyListeners();
  }
}

// Authenticated metadata correction only: no trophy, date, source or text changes.
bool _neutralGroupCorrection(GameRecord old, GameRecord next) {
  if (old.groups.length != next.groups.length) return false;
  for (var i = 0; i < old.groups.length; i++) {
    final a = old.groups[i], b = next.groups[i];
    if (a.kind != b.kind &&
        !(a.kind == TrophyGroupKind.dlc &&
            b.kind == TrophyGroupKind.additional)) {
      return false;
    }
  }
  Map<String, Object?> withoutKinds(GameRecord g) {
    final json = g.toJson();
    json['groups'] = g.groups
        .map((group) => {'id': group.id, 'name': group.name})
        .toList();
    return json;
  }

  return jsonEncode(withoutKinds(old)) == jsonEncode(withoutKinds(next));
}
