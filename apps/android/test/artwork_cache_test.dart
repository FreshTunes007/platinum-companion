import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:platinum_companion/data/artwork_cache.dart';
import 'package:platinum_companion/data/data.dart';
import 'package:platinum_companion/ui/official_image.dart';

import 'data_test.dart' show syntheticSnapshotJson;

final png = base64Decode(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aRz8AAAAASUVORK5CYII=',
);
void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  test(
    'strict CDN URL policy rejects unsafe transport and lookalike hosts',
    () {
      for (final url in [
        'http://image.api.playstation.com/x',
        'https://image.api.playstation.com.evil/x',
        'https://user@image.api.playstation.com/x',
        'https://127.0.0.1/x',
        'https://image.api.playstation.com:444/x',
        'https://image.api.playstation.com/x#y',
      ]) {
        expect(safeArtworkUri(url), isNull);
      }
    },
  );
  test('deduplicates concurrent reads, has offline disk cache after restart and bounded request budget', () async {
    final dir = await Directory.systemTemp.createTemp('pc-image-test');
    addTearDown(() => dir.delete(recursive: true));
    var calls = 0;
    final gate = Completer<void>();
    final cache = ArtworkCache(
      directory: dir,
      requestBudget: 1,
      fetcher: (uri, max) async {
        calls++;
        await gate.future;
        return ImageDownload(png, 'image/png');
      },
    );
    const url = 'https://image.api.playstation.com/test.png';
    final a = cache.load(url), b = cache.load(url);
    gate.complete();
    expect(await a, isNotNull);
    expect(await b, isNotNull);
    expect(calls, 1);
    expect(
      await cache.load('https://image.api.playstation.com/second.png'),
      isNull,
    );
    final offline = ArtworkCache(
      directory: dir,
      fetcher: (_, max) async => throw const SocketException('offline'),
    );
    expect(await offline.load(url), isNotNull);
    expect(offline.requests, 0);
    expect(offline.diskHits, 1);
  });
  test(
    'MIME/signature/size checks fail closed and LRU eviction bounds disk',
    () async {
      final dir = await Directory.systemTemp.createTemp('pc-image-test');
      addTearDown(() => dir.delete(recursive: true));
      final cache = ArtworkCache(
        directory: dir,
        maxEntries: 1,
        fetcher: (uri, max) async => ImageDownload(
          png,
          uri.path.contains('bad') ? 'text/html' : 'image/png',
        ),
      );
      expect(await cache.load('https://image.api.playstation.com/bad'), isNull);
      expect(
        await cache.load('https://image.api.playstation.com/one'),
        isNotNull,
      );
      expect(
        await cache.load('https://image.api.playstation.com/two'),
        isNotNull,
      );
      expect(
        (await dir.list().toList())
            .where((f) => f.path.endsWith('.img'))
            .length,
        1,
      );
      final oversized = ArtworkCache(
        directory: dir,
        maxImageBytes: 10,
        fetcher: (_, max) async => ImageDownload(png, 'image/png'),
      );
      expect(
        await oversized.load('https://image.api.playstation.com/oversized'),
        isNull,
      );
      final corrupt = ArtworkCache(
        directory: dir,
        fetcher: (_, max) async =>
            ImageDownload(Uint8List.fromList([1, 2, 3]), 'image/png'),
      );
      expect(
        await corrupt.load('https://image.api.playstation.com/corrupt'),
        isNull,
      );
    },
  );
  testWidgets(
    'hidden trophy icon makes no image request before explicit reveal',
    (tester) async {
      final trophy = SnapshotCodec.decode(syntheticSnapshotJson())
          .games
          .single
          .trophies[1];
      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: OfficialTrophyIcon(trophy: trophy, concealed: true),
          ),
        ),
      );
      expect(find.byType(OfficialImage), findsNothing);
      expect(find.byIcon(Icons.lock_outline_rounded), findsOneWidget);
      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: OfficialTrophyIcon(trophy: trophy, concealed: false),
          ),
        ),
      );
      expect(find.byType(OfficialImage), findsOneWidget);
    },
  );
  test('slow responses keep download concurrency bounded and complete queued images', () async {
    final dir = await Directory.systemTemp.createTemp('pc-slow-images');
    addTearDown(() => dir.delete(recursive: true));
    var active = 0, peak = 0;
    final cache = ArtworkCache(
      directory: dir,
      fetcher: (uri, max) async {
        active++;
        if (active > peak) {
          peak = active;
        }
        await Future<void>.delayed(const Duration(milliseconds: 80));
        active--;
        return ImageDownload(png, 'image/png');
      },
    );
    final files = await Future.wait(
      List.generate(
        5,
        (i) => cache.load('https://image.api.playstation.com/slow-$i.png'),
      ),
    );
    expect(files.whereType<File>().length, 5);
    expect(peak, 2);
    expect(cache.requests, 5);
  });
}
