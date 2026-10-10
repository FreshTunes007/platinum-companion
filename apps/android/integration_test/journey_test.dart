// Actual Android -> loopback HTTP -> existing Node mobile API/SQLite, isolated test copy.
import 'dart:convert';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';
import 'package:platinum_companion/data/journey_repository.dart';
import 'package:platinum_companion/ui/journey_page.dart';
import 'package:platinum_companion/ui/theme.dart';
import 'package:platinum_companion/data/cloud_controller.dart';
import 'package:platinum_companion/data/cloud_api.dart';
import 'package:platinum_companion/data/data.dart';
import 'package:platinum_companion/data/library_entry.dart';
import 'package:platinum_companion/ui/game_page.dart';

import 'artwork_test.dart' show OfflineTestAuth;

void main() {
  final binding = IntegrationTestWidgetsFlutterBinding.ensureInitialized();
  testWidgets(
    'actual device journey API, correction and native offline restart',
    (tester) async {
      var network = true;
      Future<dynamic> raw(
        String path, {
        String method = 'GET',
        Map<String, dynamic>? body,
      }) async {
        if (!network) throw const SocketException('intentional_offline');
        final client = HttpClient();
        try {
          final req = await client.openUrl(
            method,
            Uri.parse('http://127.0.0.1:43129$path'),
          );
          if (body != null) {
            req.headers.contentType = ContentType.json;
            req.write(jsonEncode(body));
          }
          final r = await req.close();
          expect(r.statusCode, 200);
          return jsonDecode(await utf8.decoder.bind(r).join());
        } finally {
          client.close();
        }
      }

      final games = await raw('/test/fixture') as List;
      final w =
          games.firstWhere((g) => g['setId'] == 'NPWR24698_00')['id'] as String;
      final h =
          games.firstWhere((g) => g['setId'] == 'NPWR59398_00')['id'] as String;
      const storage = NativeJourneyStorage();
      await storage.clear();
      final repo = JourneyRepository(
        storage: storage,
        request: (p, {method = 'GET', body}) async => Map<String, dynamic>.from(
          await raw(p, method: method, body: body) as Map,
        ),
      );
      final initial = await repo.load(w);
      expect(initial?['revision'], 29);
      expect(initial?['currentRunFacts']['zoltanCard']['value'], 'yes');
      final fixture = await raw('/test/library') as Map;
      final trophyRepo = TrophyRepository(storage: NativeSnapshotStorage());
      await trophyRepo.initialize();
      await trophyRepo.importJson(
        jsonEncode(fixture['snapshot']),
        cloudOwnerId: fixture['index']['ownerId'],
        allowGroupReclassification: true,
      );
      final cloud = CloudController(
        repository: trophyRepo,
        auth: OfflineTestAuth(),
        transport: HttpsCloudTransport(),
        journeyRepository: repo,
      );
      cloud.library = (fixture['index']['games'] as List)
          .map(LibraryEntry.parse)
          .toList();
      final wg = trophyRepo.games.firstWhere(
        (g) => g.sony.npCommunicationId == 'NPWR24698_00',
      );
      await tester.pumpWidget(
        MaterialApp(
          theme: companionTheme(Brightness.dark),
          debugShowCheckedModeBanner: false,
          home: GamePage(game: wg, cloud: cloud),
        ),
      );
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const Key('open-journey')));
      await tester.pumpAndSettle();
      expect(find.text('Путь к платине'), findsOneWidget);
      await binding.convertFlutterSurfaceToImage();
      await tester.pump();
      await binding.takeScreenshot('stage09-witcher');
      await tester.drag(find.byType(ListView).first, const Offset(0, -420));
      await tester.pumpAndSettle();
      await binding.takeScreenshot('stage09-actions');
      final changed = await repo.confirm(w, {
        'type': 'fact',
        'field': 'note',
        'value': 'DEVICE TEST ONLY',
      });
      expect(changed?['revision'], 30);
      final event = (changed!['history'] as List).firstWhere(
        (e) => e['type'] == 'fact' && e['field'] == 'note',
      );
      // A second repository instance observes the server update without copying state.
      final second = JourneyRepository(storage: storage, request: repo.request);
      expect((await second.load(w))?['revision'], 30);
      final corrected = await second.confirm(w, {
        'type': 'retract',
        'targetId': event['id'],
      });
      expect(corrected?['revision'], 31);
      expect((corrected!['currentRunFacts'] as Map).containsKey('note'), false);
      final hc = await second.load(h);
      expect(hc?['run'], null);
      expect((hc!['currentRunFacts'] as Map).isEmpty, true);
      final proof = await raw('/test/proof');
      expect(proof['productionUntouched'], true);
      expect(proof['noteRestored'], true);
      network = false;
      final offline = JourneyRepository(
        storage: storage,
        request: repo.request,
      );
      expect((await offline.load(w))?['revision'], 31);
      expect(offline.offline, true);
      await tester.pumpWidget(
        MaterialApp(
          theme: companionTheme(Brightness.dark),
          debugShowCheckedModeBanner: false,
          home: JourneyPage(gameId: w, repository: offline),
        ),
      );
      await tester.pumpAndSettle();
      await binding.takeScreenshot('stage09-offline');
      binding.reportData = {
        ...?binding.reportData,
        'nativeOfflineJourney': true,
        'realSavedSets': 5,
        'testCopyRevision': 31,
        'sonyRequests': 0,
        'productionUntouched': true,
        'nodeApiRoundtrip': true,
      };
    },
    timeout: const Timeout(Duration(minutes: 5)),
  );
}
