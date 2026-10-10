import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:platinum_companion/data/cloud_controller.dart';
import 'package:platinum_companion/data/data.dart';

import 'cloud_test.dart' show TestAuth, TestTransport;
import 'data_test.dart' show MemorySnapshotStorage;

void main() {
  final path = Platform.environment['PLATINUM_VERIFY_LIVE_CLOUD'];
  final previous = Platform.environment['PLATINUM_VERIFY_PREVIOUS'];
  test(
    'actual VPS snapshot replaces older PSN observations and survives offline restart',
    () async {
      final incoming =
          jsonDecode(await File(path!).readAsString()) as Map<String, dynamic>;
      final repo = TrophyRepository(storage: MemorySnapshotStorage());
      await repo.importJson(await File(previous!).readAsString());
      final transport = TestTransport()..snapshotOverride = incoming;
      final cloud = CloudController(
        repository: repo,
        auth: TestAuth(),
        transport: transport,
      );
      await cloud.initialize();
      expect(cloud.error, isNull);
      expect(repo.games.length, 5);
      for (final raw in incoming['games'] as List) {
        final game = repo.games.singleWhere((g) => g.id == raw['id']);
        expect(game.source, 'direct_psn_api');
        expect(game.observedAt, DateTime.parse(raw['observedAt'] as String));
        expect(game.summary.toJson(), raw['summary']);
        expect(game.trophies.length, (raw['trophies'] as List).length);
      }
      final saved = jsonEncode(repo.games.map((g) => g.toJson()).toList());
      transport.offline = true;
      final restored = TrophyRepository(storage: repo.storage);
      await restored.initialize();
      expect(jsonEncode(restored.games.map((g) => g.toJson()).toList()), saved);
    },
    skip: path == null || previous == null
        ? 'Private live snapshots not supplied'
        : false,
  );
}
