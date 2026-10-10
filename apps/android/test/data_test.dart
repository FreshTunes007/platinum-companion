import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:platinum_companion/data/data.dart';

/// Synthetic observations only; never a copy of the user's PSN history.
Map<String, dynamic> syntheticSnapshot({
  String observedAt = '2026-01-02T10:00:00.000Z',
  String id = 'psn:NPWR00001_00:PS5',
  String sonyId = 'NPWR00001_00',
  String source = 'direct_psn_api',
}) => {
  'schemaVersion': 1,
  'kind': 'platinum_companion_snapshot',
  'exportedAt': '2026-01-05T12:00:00.000Z',
  'games': [
    {
      'id': id,
      'title': 'Синтетическая игра',
      'platform': 'PS5',
      'source': source,
      'observedAt': observedAt,
      'sony': {'npCommunicationId': sonyId, 'service': 'trophy2'},
      'coverUrl': null,
      'groups': [
        {'id': '$id:group:default', 'name': 'Основная игра', 'kind': 'base'},
        {'id': '$id:group:001', 'name': null, 'kind': 'dlc'},
      ],
      'trophies': [
        {
          'id': '$id:trophy:0',
          'sonyTrophyId': 0,
          'groupId': '$id:group:default',
          'name': 'Первый шаг',
          'description': 'Завершить тестовое действие.',
          'grade': 'bronze',
          'hidden': false,
          'earned': true,
          'earnedAt': '2026-01-01T08:00:00.000Z',
        },
        {
          'id': '$id:trophy:1',
          'sonyTrophyId': 1,
          'groupId': '$id:group:default',
          'name': 'Мастер',
          'description': 'Собрать тестовые трофеи.',
          'grade': 'platinum',
          'hidden': true,
          'earned': false,
          'earnedAt': null,
        },
        {
          'id': '$id:trophy:2',
          'sonyTrophyId': 2,
          'groupId': '$id:group:001',
          'name': 'Неизвестный',
          'description': null,
          'grade': 'silver',
          'hidden': true,
          'earned': null,
          'earnedAt': null,
        },
      ],
      'summary': <String, dynamic>{
        'earned': 1,
        'total': 3,
        'unknown': 1,
        'platinumEarned': 0,
        'platinumTotal': 1,
      },
    },
  ],
};

String syntheticSnapshotJson() => jsonEncode(syntheticSnapshot());

class MemorySnapshotStorage implements SnapshotStorage {
  String? value;
  int writes = 0;
  bool failWrite = false;
  bool failRead = false;
  bool failClear = false;

  @override
  Future<String?> read() async {
    if (failRead) throw StateError('Synthetic storage read failure');
    return value;
  }

  @override
  Future<void> write(String json) async {
    if (failWrite) throw StateError('Synthetic storage write failure');
    value = json;
    writes++;
  }

  @override
  Future<void> clear() async {
    if (failClear) throw StateError('Synthetic storage clear failure');
    value = null;
  }
}

class _Picker implements SnapshotFilePicker {
  _Picker(this.value);
  final String? value;
  @override
  Future<String?> pickSnapshot() async => value;
}

Map<String, dynamic> _game(Map<String, dynamic> data) =>
    (data['games'] as List).first as Map<String, dynamic>;

List<dynamic> _trophies(Map<String, dynamic> data) =>
    _game(data)['trophies'] as List<dynamic>;

void main() {
  final verificationPath = Platform.environment['PLATINUM_VERIFY_SNAPSHOT'];
  if (verificationPath != null) {
    test('externally supplied real snapshot validates and survives offline restart', () async {
      final input = await File(verificationPath).readAsString();
      final original = jsonDecode(input) as Map<String, dynamic>;
      final storage = MemorySnapshotStorage();
      final repository = TrophyRepository(storage: storage);
      final result = await repository.importJson(input);
      expect(repository.error, isNull);
      final rawGames = original['games'] as List<dynamic>;
      expect(result?.added, rawGames.length);
      for (final raw in rawGames) {
        final data = raw as Map<String, dynamic>;
        final game = repository.games.singleWhere(
          (game) => game.id == data['id'],
        );
        expect(game.summary.toJson(), data['summary']);
        expect(game.source, data['source']);
        expect(game.observedAt, DateTime.parse(data['observedAt'] as String));
        expect(game.trophies.length, (data['trophies'] as List).length);
        for (final rawTrophy in data['trophies'] as List) {
          final rawRow = rawTrophy as Map<String, dynamic>;
          final trophy = game.trophies.singleWhere(
            (row) => row.id == rawRow['id'],
          );
          expect(trophy.earned, rawRow['earned']);
          expect(trophy.sonyTrophyId, rawRow['sonyTrophyId']);
          expect(trophy.description, rawRow['description']);
          expect(
            trophy.earnedAt,
            rawRow['earnedAt'] == null
                ? null
                : DateTime.parse(rawRow['earnedAt'] as String),
          );
        }
      }
      final restarted = TrophyRepository(storage: storage);
      await restarted.initialize();
      expect(restarted.error, isNull);
      expect(
        restarted.games.map((game) => game.contentSignature).toList(),
        repository.games.map((game) => game.contentSignature).toList(),
      );
      final duplicate = await restarted.importJson(input);
      expect(duplicate?.changed, isFalse);
    });
  }
  group('strict portable snapshot', () {
    test('preserves source, dates, Sony identity, DLC, and unknown state', () {
      final snapshot = SnapshotCodec.decode(syntheticSnapshotJson());
      final game = snapshot.games.single;
      expect(game.source, 'direct_psn_api');
      expect(game.sony.npCommunicationId, 'NPWR00001_00');
      expect(game.sony.service, 'trophy2');
      expect(game.observedAt, DateTime.utc(2026, 1, 2, 10));
      expect(game.trophies.first.earnedAt, DateTime.utc(2026, 1, 1, 8));
      expect(game.groups.last.kind, TrophyGroupKind.dlc);
      expect(game.summary.earned, 1);
      expect(game.summary.unearned, 1);
      expect(game.summary.unknown, 1);
      expect(game.summary.platinumComplete, isFalse);
      expect(game.trophies.last.isUnearned, isFalse);
      expect(game.trophies.last.isUnknown, isTrue);
      expect(game.trophies.last.description, isNull);
      expect(game.gradeEarned(TrophyGrade.bronze), 1);
      expect(() => game.trophies.clear(), throwsUnsupportedError);
      expect(
        SnapshotCodec.decode(SnapshotCodec.encode(snapshot))
            .games
            .single
            .contentSignature,
        game.contentSignature,
      );
    });

    test('rejects secret-shaped extra fields at every contract level', () {
      final insertions = <void Function(Map<String, dynamic>)>[
        (data) => data['accountId'] = 'synthetic-private-value',
        (data) => _game(data)['refreshToken'] = 'synthetic-private-value',
        (data) => (_game(data)['sony'] as Map)['accessToken'] =
            'synthetic-private-value',
        (data) =>
            (_trophies(data).first as Map)['npsso'] = 'synthetic-private-value',
        (data) => (_game(data)['summary'] as Map)['accountName'] =
            'synthetic-private-value',
        (data) => ((_game(data)['groups'] as List).first as Map)['email'] =
            'synthetic-private-value',
      ];
      for (final insert in insertions) {
        final data = syntheticSnapshot();
        insert(data);
        try {
          SnapshotCodec.decode(jsonEncode(data));
          fail('Unexpected private field was accepted');
        } on SnapshotFormatException catch (error) {
          expect(error.message, isNot(contains('synthetic-private-value')));
          expect(error.message, isNot(contains('refreshToken')));
        }
      }
    });

    test(
      'rejects wrong summaries, broken groups, IDs and inconsistent earnedAt',
      () {
        final changes = <void Function(Map<String, dynamic>)>[
          (data) => (_game(data)['summary'] as Map)['earned'] = 2,
          (data) => (_game(data)['summary'] as Map)['total'] = 3.0,
          (data) => (_trophies(data).first as Map)['groupId'] = 'missing',
          (data) => (_trophies(data).last as Map)['id'] = 'trophy:0',
          (data) => (_trophies(data).last as Map)['sonyTrophyId'] = 0,
          (data) =>
              (_trophies(data)[1] as Map)['earnedAt'] = '2026-01-01T08:00:00Z',
          (data) => (_trophies(data).first as Map)['earnedAt'] =
              '2026-01-03T08:00:00Z',
          (data) => (_trophies(data).first as Map)['earned'] = 'true',
          (data) => _game(data)['source'] = 'direct_provider_guess',
          (data) => _game(data)['coverUrl'] = 'https://example.test/track',
          (data) => data['schemaVersion'] = 999,
          (data) => _game(data)['id'] = '../bad/path',
        ];
        for (final change in changes) {
          final data = syntheticSnapshot();
          change(data);
          expect(
            () => SnapshotCodec.decode(jsonEncode(data)),
            throwsA(isA<SnapshotFormatException>()),
          );
        }
      },
    );

    test('requires valid UTC dates instead of normalizing malformed dates', () {
      for (final date in [
        '2026-01-02T10:00:00+03:00',
        '2026-02-30T10:00:00Z',
        '2026-01-02T25:00:00Z',
        '2026-01-02',
        '2026-01-06T00:00:00Z',
      ]) {
        expect(
          () => SnapshotCodec.decode(
            jsonEncode(syntheticSnapshot(observedAt: date)),
          ),
          throwsA(isA<SnapshotFormatException>()),
        );
      }
    });

    test(
      'rejects oversized input, duplicate games and excessive game count',
      () {
        expect(
          () => SnapshotCodec.decode(' ' * (SnapshotCodec.maxBytes + 1)),
          throwsA(isA<SnapshotFormatException>()),
        );
        final duplicate = syntheticSnapshot();
        (duplicate['games'] as List).add(_game(duplicate));
        expect(
          () => SnapshotCodec.decode(jsonEncode(duplicate)),
          throwsA(isA<SnapshotFormatException>()),
        );
        final many = syntheticSnapshot();
        many['games'] = List.filled(101, _game(many));
        expect(
          () => SnapshotCodec.decode(jsonEncode(many)),
          throwsA(isA<SnapshotFormatException>()),
        );
      },
    );
  });

  group('offline repository', () {
    test('imports atomically, survives restart, and keeps provider/import times distinct', () async {
      final storage = MemorySnapshotStorage();
      final imported = DateTime.utc(2026, 1, 6);
      final repository = TrophyRepository(
        storage: storage,
        clock: () => imported,
      );
      await repository.initialize();
      expect(repository.games, isEmpty);
      final result = await repository.importJson(syntheticSnapshotJson());
      expect(result?.added, 1);
      expect(repository.importedAt, imported);
      expect(repository.games.single.observedAt, DateTime.utc(2026, 1, 2, 10));
      final restarted = TrophyRepository(storage: storage);
      await restarted.initialize();
      expect(restarted.error, isNull);
      expect(
        restarted.games.single.contentSignature,
        repository.games.single.contentSignature,
      );
      expect(restarted.importedAt, imported);
      expect(restarted.isLoading, isFalse);
    });

    test(
      'repeated equivalent import is idempotent even with reordered trophies',
      () async {
        final storage = MemorySnapshotStorage();
        final repository = TrophyRepository(storage: storage);
        await repository.importJson(syntheticSnapshotJson());
        final firstImportedAt = repository.importedAt;
        final reordered = syntheticSnapshot();
        _game(reordered)['trophies'] = _trophies(reordered).reversed.toList();
        final result = await repository.importJson(jsonEncode(reordered));
        expect(result?.changed, isFalse);
        expect(result?.unchanged, 1);
        expect(storage.writes, 1);
        expect(repository.importedAt, firstImportedAt);
      },
    );

    test(
      'invalid, stale, and timestamp-conflicting imports preserve last success',
      () async {
        final storage = MemorySnapshotStorage();
        final repository = TrophyRepository(storage: storage);
        await repository.importJson(syntheticSnapshotJson());
        final saved = storage.value;
        expect(await repository.importJson('{invalid'), isNull);
        expect(
          await repository.importJson(
            jsonEncode(syntheticSnapshot(observedAt: '2026-01-01T10:00:00Z')),
          ),
          isNull,
        );
        final conflicting = syntheticSnapshot();
        _game(conflicting)['title'] = 'Иное название при той же дате';
        expect(await repository.importJson(jsonEncode(conflicting)), isNull);
        expect(storage.value, saved);
        expect(repository.games.single.title, 'Синтетическая игра');
        expect(storage.writes, 1);
        expect(repository.error, isNotNull);
      },
    );

    test(
      'storage failure does not publish newer data; retry succeeds',
      () async {
        final storage = MemorySnapshotStorage();
        final repository = TrophyRepository(storage: storage);
        await repository.importJson(syntheticSnapshotJson());
        final newer = jsonEncode(
          syntheticSnapshot(observedAt: '2026-01-03T10:00:00Z'),
        );
        storage.failWrite = true;
        expect(await repository.importJson(newer), isNull);
        expect(
          repository.games.single.observedAt,
          DateTime.utc(2026, 1, 2, 10),
        );
        storage.failWrite = false;
        expect((await repository.importJson(newer))?.updated, 1);
        expect(
          repository.games.single.observedAt,
          DateTime.utc(2026, 1, 3, 10),
        );
      },
    );

    test('merges new games without silently dropping existing games', () async {
      final storage = MemorySnapshotStorage();
      final repository = TrophyRepository(storage: storage);
      await repository.importJson(syntheticSnapshotJson());
      final other = syntheticSnapshot(
        id: 'psn:NPWR00002_00:PS5',
        sonyId: 'NPWR00002_00',
      );
      expect((await repository.importJson(jsonEncode(other)))?.total, 2);
      expect(repository.games, hasLength(2));
      final empty = syntheticSnapshot()..['games'] = <dynamic>[];
      expect(await repository.importJson(jsonEncode(empty)), isNull);
      expect(repository.games, hasLength(2));
    });

    test('prevents identity substitution and replacement of confirmed PSN by imports', () async {
      final repository = TrophyRepository(storage: MemorySnapshotStorage());
      await repository.importJson(syntheticSnapshotJson());
      final wrongIdentity = syntheticSnapshot(sonyId: 'NPWR00002_00');
      expect(await repository.importJson(jsonEncode(wrongIdentity)), isNull);
      final duplicateIdentity = syntheticSnapshot(id: 'another-game');
      expect(
        await repository.importJson(jsonEncode(duplicateIdentity)),
        isNull,
      );
      final imported = syntheticSnapshot(
        source: 'imported',
        observedAt: '2026-01-03T10:00:00Z',
      );
      expect(await repository.importJson(jsonEncode(imported)), isNull);
      expect(repository.games.single.source, 'direct_psn_api');
    });

    test(
      'retains corrupt persisted file and reports recoverable error',
      () async {
        final storage = MemorySnapshotStorage()..value = '{corrupt';
        final repository = TrophyRepository(storage: storage);
        await repository.initialize();
        expect(repository.isLoading, isFalse);
        expect(repository.games, isEmpty);
        expect(repository.error, contains('Файл сохранён'));
        expect(storage.value, '{corrupt');
        expect(
          (await repository.importJson(syntheticSnapshotJson()))?.added,
          1,
        );
      },
    );

    test(
      'picker cancellation is inert; explicit clear persists across restart',
      () async {
        final storage = MemorySnapshotStorage();
        final repository = TrophyRepository(
          storage: storage,
          picker: _Picker(null),
        );
        await repository.importJson(syntheticSnapshotJson());
        expect(await repository.importFromPicker(), isNull);
        expect(repository.error, isNull);
        expect(repository.games, hasLength(1));
        expect(await repository.clear(), isTrue);
        final restarted = TrophyRepository(storage: storage);
        await restarted.initialize();
        expect(restarted.games, isEmpty);
        expect(restarted.importedAt, isNull);
      },
    );

    test('failed clear leaves in-memory and persisted data intact', () async {
      final storage = MemorySnapshotStorage();
      final repository = TrophyRepository(storage: storage);
      await repository.importJson(syntheticSnapshotJson());
      storage.failClear = true;
      expect(await repository.clear(), isFalse);
      expect(repository.games, hasLength(1));
      expect(storage.value, isNotNull);
    });
  });
}
