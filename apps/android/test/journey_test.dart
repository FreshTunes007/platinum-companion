import 'dart:async';
import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:platinum_companion/data/journey_repository.dart';
import 'package:platinum_companion/data/snapshot_repository.dart';
import 'package:platinum_companion/data/cloud_api.dart';
import 'package:platinum_companion/ui/journey_page.dart';

class MemoryJourneyStorage implements SnapshotStorage {
  String? value;
  @override
  Future<String?> read() async => value;
  @override
  Future<void> write(String s) async {
    value = s;
  }

  @override
  Future<void> clear() async {
    value = null;
  }
}

Map<String, dynamic> response({int rev = 1, bool reveal = false}) => {
  'schemaVersion': 1,
  'ownerId': 'test-owner',
  'gameId': 'game',
  'title': 'Synthetic Journey',
  'revealed': reveal,
  'revision': rev,
  'actions': [
    {
      'id': 'a',
      'title': 'Сохранять сложность',
      'message': 'Проверенное условие',
      'category': 'MUST',
      'whyNow': 'Трофей не получен',
      'evidence': [],
    },
  ],
  'currentRunFacts': {},
  'fields': {},
  'run': {'id': 'run'},
  'history': [],
  'historyTotal': 0,
  'updateRequests': [],
  'criticalUnknowns': [],
  'coach': [],
  'trophySummary': {'earned': 2, 'total': 10},
  'remainingCount': 8,
  'trophySource': 'direct_psn_api',
  'coverage': {},
  'progress': {'providerConfirmed': 0, 'total': 1},
  'completed': [],
  'completedTotal': 0,
};
void main() {
  test(
    'durable compact journey reopens offline, with independent spoiler caches',
    () async {
      final storage = MemoryJourneyStorage();
      var offline = false;
      final repo = JourneyRepository(
        storage: storage,
        request: (path, {method = 'GET', body}) async {
          if (offline) throw const CloudFailure('network_unavailable');
          return response(reveal: path.contains('true'));
        },
      );
      expect((await repo.load('game'))?['revision'], 1);
      offline = true;
      final restart = JourneyRepository(
        storage: storage,
        request: (path, {method = 'GET', body}) async =>
            throw const CloudFailure('network_unavailable'),
      );
      expect((await restart.load('game'))?['title'], 'Synthetic Journey');
      expect(restart.offline, true);
      expect(await restart.load('game', reveal: true), null);
    },
  );
  test(
    'uncertain confirmation persists and replays same request after restart',
    () async {
      final storage = MemoryJourneyStorage();
      Map<String, dynamic>? sent;
      final repo = JourneyRepository(
        storage: storage,
        request: (path, {method = 'GET', body}) async {
          if (method == 'GET') return response();
          sent = body;
          throw const CloudFailure('network_unavailable');
        },
      );
      await repo.load('game');
      await repo.confirm('game', {
        'type': 'fact',
        'field': 'note',
        'value': 'Done',
      });
      expect(repo.pending('game'), true);
      final restart = JourneyRepository(
        storage: storage,
        request: (path, {method = 'GET', body}) async {
          expect(jsonEncode(body), jsonEncode(sent));
          return response(rev: 2);
        },
      );
      await restart.confirm('game', {});
      expect(restart.pending('game'), false);
      expect(restart.cached('game')?['revision'], 2);
    },
  );
  test(
    'revision conflict reloads state without overwriting another device',
    () async {
      final storage = MemoryJourneyStorage();
      var revision = 1;
      final repo = JourneyRepository(
        storage: storage,
        request: (path, {method = 'GET', body}) async {
          if (method == 'POST') {
            revision = 4;
            throw const CloudFailure('journey_conflict');
          }
          return response(rev: revision);
        },
      );
      await repo.load('game');
      await repo.confirm('game', {
        'type': 'fact',
        'field': 'note',
        'value': 'Stale',
      });
      expect(repo.cached('game')?['revision'], 4);
      expect(repo.pending('game'), false);
      expect(repo.error, contains('другом устройстве'));
    },
  );
  test('different owner cannot replace persisted journey', () async {
    final storage = MemoryJourneyStorage();
    var other = false;
    final repo = JourneyRepository(
      storage: storage,
      request: (p, {method = 'GET', body}) async => {
        ...response(),
        'ownerId': other ? 'another' : 'test-owner',
      },
    );
    await repo.load('game');
    other = true;
    await repo.load('game');
    expect(repo.offline, true);
    expect(repo.cached('game')?['ownerId'], 'test-owner');
  });
  test('delayed GET cannot downgrade a newer chat-confirmed route', () async {
    final storage = MemoryJourneyStorage();
    final delayed = Completer<Map<String, dynamic>>();
    var calls = 0;
    final repo = JourneyRepository(
      storage: storage,
      request: (p, {method = 'GET', body}) async {
        if (++calls == 1) return response(rev: 29);
        return delayed.future;
      },
    );
    await repo.load('game');
    final oldRequest = repo.load('game');
    await repo.acceptExternalContext('game', response(rev: 30));
    delayed.complete(response(rev: 29));
    expect((await oldRequest)?['revision'], 30);
    expect(repo.cached('game')?['revision'], 30);
    expect(jsonDecode(storage.value!)['contexts']['game:safe']['revision'], 30);
    expect(repo.offline, false);
    expect(
      await repo.acceptExternalContext(
        'game',
        response(rev: 29, reveal: true),
        reveal: true,
      ),
      false,
    );
    expect(repo.cached('game')?['revision'], 30);
  });
  testWidgets('journey screen shows actual model and separate next steps', (
    tester,
  ) async {
    final repo = JourneyRepository(
      storage: MemoryJourneyStorage(),
      request: (p, {method = 'GET', body}) async {
        final value = response();
        (value['actions'] as List).first['progress'] = {
          'status': 'not_started',
          'field': 'actionStatus:a',
        };
        return value;
      },
    );
    await tester.pumpWidget(
      MaterialApp(
        home: JourneyPage(gameId: 'game', repository: repo),
      ),
    );
    await tester.pumpAndSettle();
    expect(find.text('Путь к платине'), findsOneWidget);
    expect(find.text('Сохранять сложность'), findsOneWidget);
    expect(find.byKey(const Key('action-progress-a')), findsNothing);
    expect(find.textContaining('2 / 10'), findsOneWidget);
    expect(find.text('Скрытый трофей'), findsNothing);
  });
}
