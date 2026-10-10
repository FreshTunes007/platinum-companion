import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:platinum_companion/data/data.dart';

import 'data_test.dart' show MemorySnapshotStorage, syntheticSnapshot;

void main() {
  test(
    'authenticated neutral group correction preserves observation and progress',
    () async {
      final repo = TrophyRepository(storage: MemorySnapshotStorage());
      final original = syntheticSnapshot();
      await repo.importJson(
        jsonEncode(original),
        cloudOwnerId: 'a'.padLeft(64, 'a'),
      );
      final corrected = syntheticSnapshot();
      corrected['games'][0]['groups'][1]['kind'] = 'additional';
      final result = await repo.importJson(
        jsonEncode(corrected),
        cloudOwnerId: 'a'.padLeft(64, 'a'),
        allowGroupReclassification: true,
      );
      expect(result?.updated, 1);
      expect(repo.games.single.groups.last.kind, TrophyGroupKind.additional);
      expect(repo.games.single.observedAt, DateTime.utc(2026, 1, 2, 10));
      expect(repo.games.single.summary.earned, 1);
      final again = await repo.importJson(
        jsonEncode(corrected),
        cloudOwnerId: 'a'.padLeft(64, 'a'),
        allowGroupReclassification: true,
      );
      expect(again?.changed, false);
    },
  );

  test('neutral metadata permission cannot change trophy facts or ordinary imports', () async {
    for (final changeTrophy in [false, true]) {
      final repo = TrophyRepository(storage: MemorySnapshotStorage());
      await repo.importJson(
        jsonEncode(syntheticSnapshot()),
        cloudOwnerId: 'a'.padLeft(64, 'a'),
      );
      final changed = syntheticSnapshot();
      changed['games'][0]['groups'][1]['kind'] = 'additional';
      if (changeTrophy) {
        changed['games'][0]['trophies'][0]['description'] = 'Changed condition';
      }
      final result = await repo.importJson(
        jsonEncode(changed),
        cloudOwnerId: 'a'.padLeft(64, 'a'),
        allowGroupReclassification: changeTrophy,
      );
      expect(result?.updated ?? 0, 0);
      expect(repo.games.single.groups.last.kind, TrophyGroupKind.dlc);
    }
  });
}
