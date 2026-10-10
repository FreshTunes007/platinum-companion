import 'dart:convert';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:platinum_companion/data/cloud_api.dart';
import 'package:platinum_companion/data/cloud_controller.dart';
import 'package:platinum_companion/data/data.dart';
import 'package:platinum_companion/ui/library_page.dart';

import 'cloud_test.dart' show TestAuth, owner;
import 'data_test.dart' show MemorySnapshotStorage;

class SavedLiveTransport implements CloudTransport {
  SavedLiveTransport(this.saved);
  final Map<String, dynamic> saved;
  bool offline = false;
  int indexPages = 0, detailCalls = 0;
  @override
  Future<Map<String, dynamic>> request(
    Uri uri, {
    String method = 'GET',
    String? token,
    Map<String, dynamic>? body,
  }) async {
    if (offline) throw const CloudFailure('network_unavailable');
    final index = saved['index'] as Map<String, dynamic>;
    if (uri.path == '/api/v1/me') {
      return {'ownerId': owner, 'revision': index['revision']};
    }
    if (uri.path == '/api/v1/status') {
      return {'ownerId': owner, 'running': false};
    }
    if (uri.path == '/api/v2/library') {
      indexPages++;
      final offset = int.parse(uri.queryParameters['offset']!),
          all = index['games'] as List;
      return {
        ...index,
        'ownerId': owner,
        'games': all.skip(offset).take(100).toList(),
        'total': all.length,
        'nextOffset': offset + 100 < all.length ? offset + 100 : null,
      };
    }
    if (uri.path.startsWith('/api/v2/games/')) {
      detailCalls++;
      final detail = (saved['details'] as List).singleWhere(
        (g) => g['gameId'] == uri.path.split('/').last,
      );
      return {'ownerId': owner, 'snapshot': detail['snapshot']};
    }
    throw const CloudFailure('invalid_response');
  }
}

void main() {
  final path = Platform.environment['PLATINUM_VERIFY_FULL_LIBRARY'];
  testWidgets(
    'actual full Sony index and catalogs validate; summary pages are lazy and viewed catalog survives offline restart',
    (tester) async {
      tester.view.physicalSize = const Size(430, 980);
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.view.resetDevicePixelRatio);
      final input = await tester.runAsync(() => File(path!).readAsString());
      final saved = jsonDecode(input!) as Map<String, dynamic>;
      final details = saved['details'] as List;
      final all = saved['index']['games'] as List;
      expect(all.length, 400);
      expect(details.length, all.length);
      for (final detail in details) {
        final snapshot = SnapshotCodec.decode(jsonEncode(detail['snapshot']));
        final raw = detail['snapshot']['games'][0];
        expect(snapshot.games.single.summary.toJson(), raw['summary']);
        expect(
          snapshot.games.single.trophies.where((t) => t.earned == true).length,
          raw['summary']['earned'],
        );
        expect(
          snapshot.games.single.trophies.every((t) => t.sonyTrophyId != null),
          isTrue,
        );
      }
      final repo = TrophyRepository(storage: MemorySnapshotStorage());
      await repo.initialize();
      final indexStore = MemorySnapshotStorage(),
          transport = SavedLiveTransport(saved);
      final cloud = CloudController(
        repository: repo,
        auth: TestAuth(),
        transport: transport,
        libraryStorage: indexStore,
      );
      await cloud.initialize();
      expect(cloud.error, isNull);
      expect(transport.indexPages, 4);
      expect(transport.detailCalls, 0);
      expect(cloud.library.where((e) => e.active).length, 5);
      final chosen = cloud.library.first;
      final game = await cloud.loadGame(chosen);
      expect(game, isNotNull);
      expect(transport.detailCalls, 1);
      transport.offline = true;
      final restoredRepo = TrophyRepository(storage: repo.storage);
      await restoredRepo.initialize();
      final restored = CloudController(
        repository: restoredRepo,
        auth: TestAuth(),
        transport: transport,
        libraryStorage: indexStore,
      );
      await restored.initialize();
      expect(restored.library.length, 400);
      expect((await restored.loadGame(chosen))!.toJson(), game!.toJson());
      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: LibraryPage(
              repository: restoredRepo,
              cloud: restored,
              onImport: () {},
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();
      expect(find.text('400'), findsOneWidget);
      expect(tester.takeException(), isNull);
      // Offscreen catalogs/cards are not all rendered at once.
      expect(find.byType(InkWell).evaluate().length, lessThan(40));
      await tester.pumpWidget(const SizedBox.shrink());
      cloud.dispose();
      restored.dispose();
      repo.dispose();
      restoredRepo.dispose();
    },
    skip: path == null,
  );
}
