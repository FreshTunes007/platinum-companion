// Separate .integration package; actual saved data arrives over ADB, never in APK.
import 'dart:convert';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';
import 'package:platinum_companion/data/artwork_cache.dart';
import 'package:platinum_companion/data/cloud_api.dart';
import 'package:platinum_companion/data/cloud_auth.dart';
import 'package:platinum_companion/data/cloud_controller.dart';
import 'package:platinum_companion/data/data.dart';
import 'package:platinum_companion/data/library_index_storage.dart';
import 'package:platinum_companion/ui/app.dart';
import 'package:platinum_companion/ui/game_page.dart';
import 'package:platinum_companion/ui/official_image.dart';
import 'package:platinum_companion/ui/trophy_page.dart';
import 'package:platinum_companion/ui/theme.dart';

class OfflineTestAuth implements CompanionAuth {
  @override
  Future<CloudConfiguration?> restore() async => null;
  @override
  Future<void> login(CloudConfiguration c) async =>
      throw StateError('not_an_oauth_test');
  @override
  Future<String> accessToken({bool forceRefresh = false}) async =>
      throw StateError('offline_test');
  @override
  Future<void> clear() async {}
}

void main() {
  final binding = IntegrationTestWidgetsFlutterBinding.ensureInitialized();
  testWidgets(
    'real Sony images, native cache restart and full index on Android',
    (tester) async {
      final cache = await nativeArtworkCache();
      final fixtureFile = File(
        '${cache.directory.parent.path}/stage08-fixture.json',
      );
      for (var i = 0; i < 60 && !await fixtureFile.exists(); i++) {
        await Future<void>.delayed(const Duration(seconds: 1));
      }
      final fixture =
          jsonDecode(await fixtureFile.readAsString()) as Map<String, dynamic>;
      final index = fixture['index'] as Map<String, dynamic>;
      final repository = TrophyRepository(storage: NativeSnapshotStorage());
      await repository.initialize();
      expect(
        await repository.importJson(
          jsonEncode(fixture['snapshot']),
          cloudOwnerId: index['ownerId'],
          allowGroupReclassification: true,
        ),
        isNotNull,
      );
      await const NativeLibraryIndexStorage().write(jsonEncode(index));
      final cloud = CloudController(
        repository: repository,
        auth: OfflineTestAuth(),
        transport: HttpsCloudTransport(),
        libraryStorage: const NativeLibraryIndexStorage(),
      );
      await cloud.initialize();
      expect(cloud.library.length, 400);
      expect(cloud.library.where((e) => e.active).length, 5);
      final entry = cloud.library.firstWhere(
        (e) => e.title == 'Hades II' && e.platform == 'PS5',
      );
      final game = repository.games
          .firstWhere((g) => g.id == entry.id)
          .withArtwork(entry.artwork);
      final urls = [
        ...cloud.library
            .where((e) => e.active)
            .map((e) => e.artwork?.preferred),
        game.artwork?.hero,
        ...game.trophies
            .where((t) => t.isEarned)
            .take(3)
            .map((t) => t.official?.iconUrl),
      ];
      final loaded = await Future.wait(urls.map((u) => cache.load(u)));
      expect(loaded.whereType<File>().length, greaterThanOrEqualTo(7));
      await tester.pumpWidget(
        ArtworkScope(
          cache: cache,
          child: PlatinumApp(repository: repository, cloud: cloud),
        ),
      );
      await tester.pumpAndSettle();
      await binding.convertFlutterSurfaceToImage();
      await tester.pumpAndSettle();
      await Future<void>.delayed(const Duration(seconds: 2));
      await tester.pumpAndSettle();
      await binding.takeScreenshot('stage08-library');
      await tester.ensureVisible(find.text('Активные прохождения'));
      await tester.pumpAndSettle();
      await Future<void>.delayed(const Duration(seconds: 2));
      await tester.pumpAndSettle();
      await binding.takeScreenshot('stage08-active');
      await tester.pumpWidget(
        ArtworkScope(
          cache: cache,
          child: MaterialApp(
            debugShowCheckedModeBanner: false,
            theme: companionTheme(Brightness.dark),
            home: GamePage(game: game),
          ),
        ),
      );
      await tester.pumpAndSettle();
      await Future<void>.delayed(const Duration(seconds: 2));
      await tester.pumpAndSettle();
      await binding.takeScreenshot('stage08-game');
      final trophy = game.trophies.firstWhere(
        (t) => t.isEarned && t.official?.iconUrl != null,
      );
      await tester.pumpWidget(
        ArtworkScope(
          cache: cache,
          child: MaterialApp(
            theme: companionTheme(Brightness.dark),
            home: TrophyPage(
              game: game,
              trophy: trophy,
              revealed: true,
              onReveal: () {},
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();
      await Future<void>.delayed(const Duration(seconds: 2));
      await tester.pumpAndSettle();
      expect(find.byType(Image), findsOneWidget);
      await binding.takeScreenshot('stage08-trophy');
      final offline = ArtworkCache(
        directory: cache.directory,
        fetcher: (uri, max) =>
            throw const SocketException('intentional_offline'),
      );
      for (final url in urls.whereType<String>()) {
        expect(await offline.load(url), isNotNull);
      }
      expect(offline.requests, 0);
      final restarted = TrophyRepository(storage: NativeSnapshotStorage());
      await restarted.initialize();
      expect(restarted.games.length, 5);
      expect(
        restarted.snapshot!.games.fold(0, (n, g) => n + g.summary.earned),
        repository.snapshot!.games.fold(0, (n, g) => n + g.summary.earned),
      );
      binding.reportData = {
        ...?binding.reportData,
        'sets': 400,
        'active': 5,
        'nativeOfflineImages': offline.diskHits,
        'imageDownloads': cache.requests,
        'sonyAuthCalls': 0,
        'productionApkDataEmbedded': false,
      };
      await tester.pumpWidget(const SizedBox.shrink());
      cloud.dispose();
      repository.dispose();
      restarted.dispose();
    },
    timeout: const Timeout(Duration(minutes: 5)),
  );
}
