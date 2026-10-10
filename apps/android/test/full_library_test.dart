import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:platinum_companion/data/cloud_api.dart';
import 'package:platinum_companion/data/cloud_controller.dart';
import 'package:platinum_companion/data/data.dart';

import 'cloud_test.dart' show TestAuth, owner;
import 'data_test.dart' show MemorySnapshotStorage;

class LibraryTransport implements CloudTransport {
  final paths = <String>[];
  bool offline = false;
  @override
  Future<Map<String, dynamic>> request(
    Uri uri, {
    String method = 'GET',
    String? token,
    Map<String, dynamic>? body,
  }) async {
    paths.add(uri.path);
    if (offline) throw const CloudFailure('network_unavailable');
    if (uri.path == '/api/v1/me') return {'ownerId': owner, 'revision': 1};
    if (uri.path == '/api/v1/status') {
      return {'ownerId': owner, 'running': false};
    }
    if (uri.path == '/api/v2/library') {
      final offset = int.parse(uri.queryParameters['offset']!);
      return {
        'ownerId': owner,
        'revision': 1,
        'total': 400,
        'nextOffset': offset + 100 < 400 ? offset + 100 : null,
        'games': List.generate(100, (i) {
          final n = i + offset;
          return {
            'gameId': n.toRadixString(16).padLeft(24, '0'),
            'id': 'psn:NPWR${(90000 + n)}_00:PS5',
            'title': 'Synthetic $n',
            'platform': 'PS5',
            'active': n < 5,
            'catalogComplete': false,
            'source': 'sony_inventory',
            'observedAt': null,
            'sony': {
              'npCommunicationId': 'NPWR${90000 + n}_00',
              'service': 'trophy2',
            },
            'summary': {
              'total': 50,
              'earned': 0,
              'platinumTotal': 1,
              'platinumEarned': 0,
            },
          };
        }),
        'totals': {'sets': 400},
        'initialImport': {
          'discovered': 400,
          'complete': 5,
          'status': 'running',
        },
      };
    }
    throw const CloudFailure('invalid_response');
  }
}

void main() {
  test('400-set index is paginated, preserves five active games and restarts offline without catalogs', () async {
    final indexStorage = MemorySnapshotStorage(),
        repo = TrophyRepository(storage: MemorySnapshotStorage());
    final transport = LibraryTransport();
    final cloud = CloudController(
      repository: repo,
      auth: TestAuth(),
      transport: transport,
      libraryStorage: indexStorage,
    );
    await cloud.initialize();
    expect(cloud.error, isNull);
    expect(cloud.library.length, 400);
    expect(cloud.library.where((e) => e.active).length, 5);
    expect(transport.paths.where((p) => p == '/api/v2/library').length, 4);
    expect(transport.paths, isNot(contains('/api/v1/snapshot')));
    expect(repo.games, isEmpty);
    expect(
      (jsonDecode((await indexStorage.read())!) as Map)['games'].length,
      400,
    );
    transport.offline = true;
    final restored = CloudController(
      repository: repo,
      auth: TestAuth(),
      transport: transport,
      libraryStorage: indexStorage,
    );
    await restored.initialize();
    expect(restored.library.length, 400);
    expect(restored.library.first.preview.trophies, isEmpty);
  });
}
