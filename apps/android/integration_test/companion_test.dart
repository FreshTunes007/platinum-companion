// Real Android widgets/native storage -> loopback Node API/SQLite, isolated copy.
// This exercises the honest manual fallback, not a connected AI/Vision model.
import 'dart:convert';
import 'dart:io';
import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';
import 'package:platinum_companion/data/cloud_api.dart';
import 'package:platinum_companion/data/cloud_controller.dart';
import 'package:platinum_companion/data/companion_repository.dart';
import 'package:platinum_companion/data/data.dart';
import 'package:platinum_companion/data/journey_repository.dart';
import 'package:platinum_companion/data/library_entry.dart';
import 'package:platinum_companion/ui/companion_page.dart';
import 'package:platinum_companion/ui/game_page.dart';
import 'package:platinum_companion/ui/theme.dart';

import 'artwork_test.dart' show OfflineTestAuth;

class ObservedNativePicker implements GameImagePicker {
  final selected = Completer<List<CompanionImage>>();
  @override
  Future<List<CompanionImage>> pick() async {
    final images = await const NativeGameImagePicker().pick();
    selected.complete(images);
    return images;
  }
}

void main() {
  final binding = IntegrationTestWidgetsFlutterBinding.ensureInitialized();
  testWidgets(
    'manual conversation preview, item correction and native offline history',
    (tester) async {
      var network = true;
      final actualClient = HttpClient();
      addTearDown(() => actualClient.close(force: true));
      Future<dynamic> raw(
        String path, {
        String method = 'GET',
        Map<String, dynamic>? body,
      }) async {
        if (!network) throw const SocketException('intentional_offline');
        final req = await actualClient.openUrl(
          method,
          Uri.parse('http://127.0.0.1:43129$path'),
        );
        if (body != null) {
          req.headers.contentType = ContentType.json;
          req.write(jsonEncode(body));
        }
        final r = await req.close();
        final decoded = jsonDecode(await utf8.decoder.bind(r).join());
        if (r.statusCode == 409) throw const CloudFailure('journey_conflict');
        // Widget initState invokes this outside the test body's async guard.
        // A test matcher here would throw guardSync while pump is active.
        if (r.statusCode != 200) {
          throw CloudFailure('test_http_${r.statusCode}');
        }
        return decoded;
      }

      Future<Map<String, dynamic>> request(
        String path, {
        String method = 'GET',
        Map<String, dynamic>? body,
      }) async {
        final data = Map<String, dynamic>.from(
          await raw(path, method: method, body: body) as Map,
        );
        return data;
      }

      Future<void> show(Finder finder, {bool reset = true}) async {
        if (reset) {
          final state = tester.state<ScrollableState>(
            find.byType(Scrollable).first,
          );
          state.position.jumpTo(0);
          await tester.pumpAndSettle();
        }
        await tester.scrollUntilVisible(
          finder,
          300,
          scrollable: find.byType(Scrollable).first,
          maxScrolls: 70,
        );
        await tester.pumpAndSettle();
      }

      Future<void> waitFor(bool Function() ready) async {
        final deadline = DateTime.now().add(const Duration(seconds: 20));
        while (!ready() && DateTime.now().isBefore(deadline)) {
          await tester.runAsync(
            () => Future<void>.delayed(const Duration(milliseconds: 100)),
          );
          await tester.pump();
        }
        expect(ready(), true);
        await tester.pumpAndSettle();
      }

      Future<void> manualField(String field, String value, Map fields) async {
        await show(find.byKey(const Key('add-manual-fact')));
        await tester.tap(find.byKey(const Key('add-manual-fact')));
        await tester.pumpAndSettle();
        final option = find.text('${fields[field]['label']}');
        await tester.scrollUntilVisible(
          option,
          250,
          scrollable: find.byType(Scrollable).last,
          maxScrolls: 70,
        );
        await tester.tap(option);
        await tester.pumpAndSettle();
        await tester.enterText(find.byType(TextField).last, value);
        await tester.tap(find.text('Использовать в черновике'));
        await tester.pumpAndSettle();
      }

      final games = await raw('/test/fixture') as List;
      final w =
          games.firstWhere((g) => g['setId'] == 'NPWR24698_00')['id'] as String;
      const chatStorage = NativeConversationStorage();
      const journeyStorage = NativeJourneyStorage();
      await chatStorage.clear();
      await journeyStorage.clear();
      final journeys = JourneyRepository(
        storage: journeyStorage,
        request: request,
      );
      final picker = ObservedNativePicker();
      final companions = CompanionRepository(
        storage: chatStorage,
        request: request,
        journeys: journeys,
        picker: picker,
      );
      final initial = await journeys.load(w);
      expect(initial?['revision'], 29);
      final originalLocation =
          initial?['currentRunFacts']['currentRegion']['value'];
      expect(initial?['currentRunFacts']['zoltanCard']['value'], 'yes');
      final fixture = await raw('/test/library') as Map;
      final trophies = TrophyRepository(storage: NativeSnapshotStorage());
      await trophies.initialize();
      await trophies.importJson(
        jsonEncode(fixture['snapshot']),
        cloudOwnerId: fixture['index']['ownerId'],
        allowGroupReclassification: true,
      );
      final cloud = CloudController(
        repository: trophies,
        auth: OfflineTestAuth(),
        transport: HttpsCloudTransport(),
        journeyRepository: journeys,
        companionRepository: companions,
      );
      cloud.library = (fixture['index']['games'] as List)
          .map(LibraryEntry.parse)
          .toList();
      final game = trophies.games.firstWhere(
        (g) => g.sony.npCommunicationId == 'NPWR24698_00',
      );
      Widget app(Widget child) => MaterialApp(
        theme: companionTheme(Brightness.dark),
        debugShowCheckedModeBanner: false,
        home: child,
      );
      await tester.pumpWidget(app(GamePage(game: game, cloud: cloud)));
      await tester.pumpAndSettle();
      await show(find.byKey(const Key('open-journey')));
      await tester.tap(find.byKey(const Key('open-journey')));
      await tester.pumpAndSettle();
      final counterButton = find.byKey(const Key('action-progress-w3.bombs'));
      await show(counterButton);
      await tester.tap(counterButton);
      await tester.pumpAndSettle();
      await tester.enterText(find.byType(TextField).last, '3');
      await tester.tap(find.text('Подтвердить'));
      await tester.pumpAndSettle();
      expect(
        journeys.cached(w)?['currentRunFacts']['bombRecipeTypes']['value'],
        3,
      );
      expect(journeys.cached(w)?['revision'], 30);
      final bomb = (journeys.cached(w)?['actions'] as List).firstWhere(
        (a) => a['id'] == 'w3.bombs',
      );
      expect(bomb['progress']['status'], 'in_progress');
      expect(bomb['progress']['counter']['value'], 3);
      final bombTitle = find.text(bomb['title'] as String);
      await show(bombTitle);
      await Scrollable.ensureVisible(tester.element(bombTitle), alignment: .1);
      await tester.pumpAndSettle();
      await binding.convertFlutterSurfaceToImage();
      await tester.pump();
      await binding.takeScreenshot('stage10-counter');
      await show(counterButton);
      await tester.tap(counterButton);
      await tester.pumpAndSettle();
      await tester.enterText(find.byType(TextField).last, '2');
      await tester.tap(find.text('Подтвердить'));
      await tester.pumpAndSettle();
      expect(journeys.cached(w)?['revision'], 31);
      expect(
        journeys.cached(w)?['currentRunFacts']['bombRecipeTypes']['value'],
        2,
      );
      expect(
        journeys.cached(w)?['trophySummary']['earned'],
        initial?['trophySummary']['earned'],
      );
      await tester.tap(find.byTooltip('Back'));
      await tester.pumpAndSettle();
      await companions.load(w);
      expect(companions.cached(w), isNotNull, reason: companions.error);
      await show(find.byKey(const Key('open-companion')));
      await tester.tap(find.byKey(const Key('open-companion')));
      await waitFor(() => companions.cached(w) != null);
      await show(find.text('AI ещё не подключён'));
      expect(find.text('AI ещё не подключён'), findsOneWidget);
      await binding.takeScreenshot('stage10-chat');
      await show(find.byKey(const Key('companion-message')));
      await tester.enterText(
        find.byKey(const Key('companion-message')),
        'Получил грамоту от Барона, приехал в Оксенфурт. Сейчас ищу его дочь.',
      );
      await show(find.byKey(const Key('attach-game-images')), reset: false);
      await tester.tap(find.byKey(const Key('attach-game-images')));
      // The driver operator selects the benign UI PNG through the real system
      // document picker; this observer calls the actual native image bridge.
      debugPrint('stage10_native_picker_waiting');
      final picked = await picker.selected.future.timeout(
        const Duration(minutes: 2),
      );
      expect(picked.length, 1);
      final sanitizedImage = picked.single;
      expect(sanitizedImage.mimeType, 'image/png');
      expect(
        picked.single.width * picked.single.height,
        lessThanOrEqualTo(12000000),
      );
      expect(picked.single.bytes.length, lessThanOrEqualTo(3 * 1024 * 1024));
      await tester.pumpAndSettle();
      expect(find.textContaining('Vision ещё не подключён'), findsOneWidget);
      await binding.takeScreenshot('stage10-image-preview');
      await tester.tap(find.text('Убрать').last);
      await tester.pumpAndSettle();
      expect(
        (tester.widget(
          find.byKey(const Key('companion-message')),
        ) as TextField).controller?.text,
        'Получил грамоту от Барона, приехал в Оксенфурт. Сейчас ищу его дочь.',
      );
      await show(find.byKey(const Key('send-companion')), reset: false);
      await waitFor(
        () =>
            tester
                .widget<FilledButton>(find.byKey(const Key('send-companion')))
                .onPressed !=
            null,
      );
      await tester.tap(find.byKey(const Key('send-companion')));
      await waitFor(
        () =>
            !companions.pending(w) &&
            (companions.cached(w)?['messages'] as List).isNotEmpty,
      );
      expect(companions.cached(w)?['revision'], 31);
      expect(
        companions.cached(w)?['currentRunFacts']['currentRegion']['value'],
        originalLocation,
      );
      expect(
        companions.cached(w)?['proposals'],
        isEmpty,
      ); // No fabricated parsing.
      final fields = companions.cached(w)!['fields'] as Map;
      await manualField('currentRegion', 'Оксенфурт', fields);
      await manualField('items', 'Грамота Барона', fields);
      await manualField('currentObjective', 'Ищу дочь Барона', fields);
      await show(find.byKey(const Key('preview-manual-proposal')));
      await tester.tap(find.byKey(const Key('preview-manual-proposal')));
      await waitFor(
        () =>
            !companions.pending(w) &&
            (companions.cached(w)?['proposals'] as List).isNotEmpty,
      );
      final proposal =
          (companions.cached(w)?['proposals'] as List).first as Map;
      expect(proposal['source'], 'USER_DRAFT');
      expect(companions.cached(w)?['revision'], 31);
      final items = proposal['items'] as List;
      final location =
          items.firstWhere((i) => i['field'] == 'currentRegion') as Map;
      final letter = items.firstWhere((i) => i['field'] == 'items') as Map;
      final objective =
          items.firstWhere((i) => i['field'] == 'currentObjective') as Map;
      final editLocation = find.byKey(
        ValueKey('edit-${proposal['id']}-${location['id']}'),
      );
      await show(editLocation);
      await tester.tap(editLocation);
      await tester.pumpAndSettle();
      await tester.enterText(
        find.byType(TextField).last,
        'Оксенфурт · у ворот',
      );
      await tester.tap(find.text('Использовать в черновике'));
      await tester.pumpAndSettle();
      final chooseLetter = find.byKey(
        ValueKey('choose-${proposal['id']}-${letter['id']}'),
      );
      await show(chooseLetter);
      await tester.tap(chooseLetter);
      await tester.pumpAndSettle();
      final rejectObjective = find.byKey(
        ValueKey('reject-${proposal['id']}-${objective['id']}'),
      );
      await show(rejectObjective);
      await tester.tap(rejectObjective);
      await waitFor(
        () =>
            !companions.pending(w) &&
            ((companions.cached(w)?['proposals'] as List).first['items']
                        as List)
                    .firstWhere((i) => i['id'] == objective['id'])['status'] ==
                'rejected',
      );
      expect(companions.cached(w)?['revision'], 31);
      await show(
        find.byKey(ValueKey('choose-${proposal['id']}-${location['id']}')),
      );
      await binding.takeScreenshot('stage10-proposals');
      final accept = find.byKey(ValueKey('accept-${proposal['id']}'));
      await show(accept);
      await tester.tap(accept);
      await waitFor(
        () => !companions.pending(w) && companions.cached(w)?['revision'] == 32,
      );
      expect(companions.cached(w)?['revision'], 32);
      expect(journeys.cached(w)?['revision'], 32);
      expect(
        companions.cached(w)?['currentRunFacts']['currentRegion']['value'],
        'Оксенфурт · у ворот',
      );
      expect(
        companions.cached(w)?['currentRunFacts']['items']['value'],
        contains('Грамота Барона'),
      );
      final accepted = await journeys.load(w);
      expect(accepted?['revision'], 32);
      final locationEvent = (accepted?['history'] as List).firstWhere(
        (e) => e['field'] == 'currentRegion' && e['batch'] == true,
      ) as Map;
      final corrected = await journeys.confirm(w, {
        'type': 'retract',
        'targetId': locationEvent['id'],
        'field': 'currentRegion',
      });
      expect(corrected?['revision'], 33);
      expect(
        corrected?['currentRunFacts']['currentRegion']['value'],
        originalLocation,
      );
      expect(
        corrected?['currentRunFacts']['items']['value'],
        contains('Грамота Барона'),
      );
      expect(corrected?['currentRunFacts']['bombRecipeTypes']['value'], 2);
      expect(
        corrected?['trophySummary']['earned'],
        initial?['trophySummary']['earned'],
      );
      await companions.load(w);
      final proof = await raw('/test/proof');
      expect(proof['productionUntouched'], true);
      expect(proof['sonyRequests'], 0);
      network = false;
      final offline = CompanionRepository(
        storage: chatStorage,
        request: request,
      );
      expect((await offline.load(w))?['revision'], 33);
      expect(offline.offline, true);
      expect((offline.cached(w)?['messages'] as List).isNotEmpty, true);
      final conversationFile = await chatStorage.read();
      expect(conversationFile, isNot(contains('dataBase64')));
      expect(
        conversationFile,
        isNot(contains(base64Encode(sanitizedImage.bytes))),
      );
      final offlineJourney = JourneyRepository(
        storage: journeyStorage,
        request: request,
      );
      expect((await offlineJourney.load(w))?['revision'], 33);
      await tester.pumpWidget(
        app(CompanionPage(gameId: w, repository: offline)),
      );
      await tester.pumpAndSettle();
      await binding.takeScreenshot('stage10-chat-offline');
      binding.reportData = {
        ...?binding.reportData,
        'nativeOfflineConversation': true,
        'realSavedSets': 5,
        'testCopyRevision': 33,
        'sonyRequests': 0,
        'productionUntouched': true,
        'nodeApiRoundtrip': true,
        'manualPerItemPreview': true,
        'counter3of6': true,
        'partialBatchCorrection': true,
        'aiConfigured': false,
        'visionLive': false,
        'nativeImagePicker': true,
        'imageBytesPersisted': false,
        'nativeOfflineRoute': true,
      };
    },
    timeout: const Timeout(Duration(minutes: 8)),
  );
}
