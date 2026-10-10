import 'dart:convert';
import 'dart:typed_data';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:platinum_companion/data/cloud_api.dart';
import 'package:platinum_companion/data/companion_repository.dart';
import 'package:platinum_companion/data/journey_repository.dart';
import 'package:platinum_companion/data/snapshot_repository.dart';
import 'package:platinum_companion/ui/companion_page.dart';

class MemoryConversationStorage implements SnapshotStorage {
  String? value;
  @override
  Future<String?> read() async => value;
  @override
  Future<void> write(String json) async {
    value = json;
  }

  @override
  Future<void> clear() async {
    value = null;
  }
}

Map<String, dynamic> companionResponse({
  int revision = 29,
  bool reveal = false,
  List<Map<String, dynamic>> messages = const [],
  List<Map<String, dynamic>> proposals = const [],
  List<String> applied = const [],
}) => {
  'schemaVersion': 1,
  'gameId': 'game',
  'ownerId': 'test-owner',
  'title': 'Synthetic Witcher test copy',
  'revision': revision,
  'revealed': reveal,
  'runId': 'test-run',
  'run': {'id': 'test-run'},
  'provider': {
    'configured': false,
    'textAvailable': false,
    'visionAvailable': false,
    'requiresConsent': true,
    'status': 'AI_UNCONFIGURED',
  },
  'messages': messages,
  'proposals': proposals,
  'appliedRequestIds': applied,
  'coverage': {'limitation': 'Synthetic partial knowledge pack'},
  'fields': {
    'currentRegion': {'label': 'Текущая локация', 'type': 'text'},
    'currentObjective': {'label': 'Текущее задание', 'type': 'text'},
    'items': {'label': 'Предметы', 'type': 'array'},
    'bombRecipeTypes': {
      'label': 'Типы рецептов',
      'type': 'number',
      'min': 0,
      'max': 6,
    },
  },
  'currentRunFacts': {
    'currentRegion': {'value': 'Вызима', 'source': 'user_confirmation'},
  },
};

void main() {
  testWidgets(
    'collection editor uses typed entries and preserves unconfirmed state',
    (tester) async {
      final repo = CompanionRepository(
        storage: MemoryConversationStorage(),
        request: (p, {method = 'GET', body}) async => companionResponse(),
      );
      await tester.pumpWidget(
        MaterialApp(
          home: CompanionPage(gameId: 'game', repository: repo),
        ),
      );
      await tester.pumpAndSettle();
      await tester.scrollUntilVisible(
        find.byKey(const Key('add-manual-fact')),
        400,
        scrollable: find.byType(Scrollable).first,
      );
      await tester.tap(find.byKey(const Key('add-manual-fact')));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Предметы'));
      await tester.pumpAndSettle();
      await tester.enterText(
        find.byType(TextField).last,
        'Грамота Барона\nДругая вещь',
      );
      await tester.tap(find.text('Использовать в черновике'));
      await tester.pumpAndSettle();
      expect(find.text('Грамота Барона; Другая вещь'), findsOneWidget);
      expect(repo.cached('game')?['revision'], 29);
      expect(
        (repo.cached('game')?['currentRunFacts'] as Map).containsKey('items'),
        false,
      );
    },
  );
  test(
    'HTTP 200 processing keeps uncertain command until completed receipt',
    () async {
      final storage = MemoryConversationStorage();
      String? requestId;
      var complete = false;
      final repo = CompanionRepository(
        storage: storage,
        request: (p, {method = 'GET', body}) async {
          if (method == 'POST') requestId = body!['requestId'];
          return {
            ...companionResponse(
              applied: complete && requestId != null ? [requestId!] : [],
            ),
            'requestState': complete ? 'complete' : 'processing',
          };
        },
      );
      await repo.load('game');
      await repo.sendMessage('game', 'Жду ответ');
      expect(repo.pending('game'), true);
      expect(repo.error, contains('ещё выполняется'));
      final restart = CompanionRepository(
        storage: storage,
        request: repo.request,
      );
      await restart.load('game');
      expect(restart.pending('game'), true);
      complete = true;
      await restart.load('game');
      expect(restart.pending('game'), false);
    },
  );
  test('confirmed chat atomically caches authoritative route and never downgrades it', () async {
    Map<String, dynamic> route(int revision) => {
      'schemaVersion': 1,
      'ownerId': 'test-owner',
      'gameId': 'game',
      'revealed': false,
      'revision': revision,
      'run': {'id': 'test-run'},
      'actions': [],
      'updateRequests': [],
      'history': [],
      'currentRunFacts': {
        'currentRegion': {'value': revision < 30 ? 'Вызима' : 'Оксенфурт'},
      },
    };
    final journeyStorage = MemoryConversationStorage();
    final journeys = JourneyRepository(
      storage: journeyStorage,
      request: (p, {method = 'GET', body}) async => route(29),
    );
    final conversations = CompanionRepository(
      storage: MemoryConversationStorage(),
      journeys: journeys,
      request: (p, {method = 'GET', body}) async => method == 'GET'
          ? companionResponse()
          : {
              ...companionResponse(revision: 30, applied: [body!['requestId']]),
              'journey': route(30),
            },
    );
    await conversations.load('game');
    expect(journeys.cached('game')?['revision'], 29);
    await conversations.resolve('game', 'proposal', [
      {'itemId': 'location', 'decision': 'accept'},
    ]);
    expect(journeys.cached('game')?['revision'], 30);
    expect(await journeys.acceptExternalContext('game', route(29)), false);
    expect(journeys.cached('game')?['revision'], 30);
    await expectLater(
      journeys.acceptExternalContext('game', companionResponse(revision: 31)),
      throwsA(isA<CloudFailure>()),
    );
    await expectLater(
      journeys.acceptExternalContext('game', {
        ...route(31),
        'ownerId': 'other-owner',
      }),
      throwsA(isA<CloudFailure>()),
    );
    final offline = JourneyRepository(
      storage: journeyStorage,
      request: (p, {method = 'GET', body}) async =>
          throw const CloudFailure('network_unavailable'),
    );
    expect((await offline.load('game'))?['revision'], 30);
  });
  test('conversation cache persists offline and isolates spoiler projection and owner', () async {
    final storage = MemoryConversationStorage();
    var other = false;
    final repo = CompanionRepository(
      storage: storage,
      request: (p, {method = 'GET', body}) async => {
        ...companionResponse(
          messages: [
            {'id': 'm1', 'role': 'user', 'text': 'Поехал в Оксенфурт'},
          ],
        ),
        'ownerId': other ? 'other-owner' : 'test-owner',
      },
    );
    expect((await repo.load('game'))?['revision'], 29);
    other = true;
    await repo.load('game');
    expect(repo.cached('game')?['ownerId'], 'test-owner');
    final restart = CompanionRepository(
      storage: storage,
      request: (p, {method = 'GET', body}) async =>
          throw const CloudFailure('network_unavailable'),
    );
    expect(
      (await restart.load('game'))?['messages'][0]['text'],
      'Поехал в Оксенфурт',
    );
    expect(restart.offline, true);
    expect(await restart.load('game', reveal: true), null);
  });

  test('manual proposal is a preview; only explicit selected decisions change state', () async {
    final storage = MemoryConversationStorage();
    final commands = <Map<String, dynamic>>[];
    var revision = 29;
    var location = 'Вызима';
    var proposals = <Map<String, dynamic>>[];
    final repo = CompanionRepository(
      storage: storage,
      request: (p, {method = 'GET', body}) async {
        if (method == 'POST') {
          commands.add(Map<String, dynamic>.from(body!));
          if (body['type'] == 'manual') {
            proposals = [
              {
                'id': 'proposal',
                'source': 'USER_DRAFT',
                'status': 'pending',
                'items': [
                  {
                    'id': 'location',
                    'field': 'currentRegion',
                    'value': 'Оксенфурт',
                    'previousValue': location,
                    'status': 'pending',
                  },
                  {
                    'id': 'item',
                    'field': 'items',
                    'value': ['Грамота Барона'],
                    'operation': 'add',
                    'status': 'pending',
                  },
                ],
              },
            ];
          } else if (body['type'] == 'resolve') {
            final decisions = body['decisions'] as List;
            expect(decisions.length, 1);
            expect(decisions.single['itemId'], 'location');
            location = decisions.single['value'] as String;
            revision++;
            (proposals.single['items'] as List).first['status'] = 'accepted';
          }
        }
        return {
          ...companionResponse(
            revision: revision,
            proposals: proposals,
            applied: body == null ? [] : [body['requestId']],
          ),
          'currentRunFacts': {
            'currentRegion': {'value': location, 'source': 'user_confirmation'},
          },
        };
      },
    );
    await repo.load('game');
    await repo.manualProposal('game', [
      {'field': 'currentRegion', 'value': 'Оксенфурт'},
      {
        'field': 'items',
        'value': ['Грамота Барона'],
        'operation': 'add',
      },
    ]);
    expect(location, 'Вызима');
    expect(repo.cached('game')?['revision'], 29);
    await repo.resolve('game', 'proposal', [
      {
        'itemId': 'location',
        'decision': 'accept',
        'value': 'Оксенфурт · ворота',
      },
    ]);
    expect(location, 'Оксенфурт · ворота');
    expect(repo.cached('game')?['revision'], 30);
    expect((proposals.single['items'] as List).last['status'], 'pending');
    expect(commands[1]['expectedRevision'], 29);
  });

  test(
    'uncertain text command survives restart and retries identical request',
    () async {
      final storage = MemoryConversationStorage();
      Map<String, dynamic>? sent;
      final repo = CompanionRepository(
        storage: storage,
        request: (p, {method = 'GET', body}) async {
          if (method == 'GET') return companionResponse();
          sent = Map<String, dynamic>.from(body!);
          throw const CloudFailure('network_unavailable');
        },
      );
      await repo.load('game');
      await repo.sendMessage('game', 'Получил грамоту от Барона');
      expect(repo.pending('game'), true);
      final restart = CompanionRepository(
        storage: storage,
        request: (p, {method = 'GET', body}) async {
          expect(jsonEncode(body), jsonEncode(sent));
          return companionResponse(
            applied: [body!['requestId']],
            messages: [
              {'id': 'm', 'role': 'user', 'text': 'Получил грамоту от Барона'},
            ],
          );
        },
      );
      await restart.retry('game');
      expect(restart.pending('game'), false);
    },
  );

  test('image payload is transient; completed receipt settles after restart without resend', () async {
    final storage = MemoryConversationStorage();
    Map<String, dynamic>? command;
    final bytes = Uint8List.fromList(List.generate(200, (i) => i));
    final repo = CompanionRepository(
      storage: storage,
      request: (p, {method = 'GET', body}) async {
        if (method == 'GET') return companionResponse();
        command = Map<String, dynamic>.from(body!);
        throw const CloudFailure('network_unavailable');
      },
    );
    await repo.load('game');
    await repo.setExternalTransferConsent(true);
    await repo.sendMessage(
      'game',
      'Журнал',
      images: [
        CompanionImage(
          mimeType: 'image/png',
          bytes: bytes,
          width: 10,
          height: 20,
        ),
      ],
    );
    expect(command?['images'][0]['dataBase64'], base64Encode(bytes));
    expect(storage.value, isNot(contains(base64Encode(bytes))));
    expect(storage.value, isNot(contains('dataBase64')));
    var gets = 0;
    final restart = CompanionRepository(
      storage: storage,
      request: (p, {method = 'GET', body}) async {
        expect(method, 'GET');
        gets++;
        return companionResponse(
          applied: gets > 1 ? [command!['requestId']] : [],
          messages: [
            {
              'id': 'm',
              'role': 'user',
              'text': 'Журнал',
              'requestId': command!['requestId'],
              'state': 'processing',
            },
          ],
        );
      },
    );
    await restart.load('game');
    expect(restart.pendingImagesNeedReselection('game'), true);
    expect(restart.pending('game'), true); // Processing is not confirmation.
    await restart.retry('game');
    expect(restart.pending('game'), false);
  });

  test(
    'revision conflict reloads without autoaccepting stale proposal',
    () async {
      final storage = MemoryConversationStorage();
      var revision = 29;
      var writes = 0;
      final repo = CompanionRepository(
        storage: storage,
        request: (p, {method = 'GET', body}) async {
          if (method == 'POST') {
            writes++;
            revision = 32;
            throw const CloudFailure('journey_conflict');
          }
          return companionResponse(revision: revision);
        },
      );
      await repo.load('game');
      await repo.resolve('game', 'proposal', [
        {'itemId': 'location', 'decision': 'accept'},
      ]);
      expect(writes, 1);
      expect(repo.cached('game')?['revision'], 32);
      expect(repo.pending('game'), false);
      expect(repo.error, contains('другом устройстве'));
    },
  );

  testWidgets(
    'unconfigured UI labels manual fallback and never simulates AI or earned trophies',
    (tester) async {
      final repo = CompanionRepository(
        storage: MemoryConversationStorage(),
        request: (p, {method = 'GET', body}) async => companionResponse(),
      );
      await tester.pumpWidget(
        MaterialApp(
          home: CompanionPage(gameId: 'game', repository: repo),
        ),
      );
      await tester.pumpAndSettle();
      expect(find.text('Чат и подтверждение прохождения'), findsOneWidget);
      expect(
        find.textContaining('Личный ChatGPT открывается кнопкой выше'),
        findsOneWidget,
      );
      expect(
        find.textContaining('Снимки в этом режиме не анализируются'),
        findsOneWidget,
      );
      await tester.scrollUntilVisible(
        find.byKey(const Key('add-manual-fact')),
        400,
        scrollable: find.byType(Scrollable).first,
      );
      expect(find.text('Подготовить изменения вручную'), findsOneWidget);
      await tester.tap(find.byKey(const Key('add-manual-fact')));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Текущая локация').last);
      await tester.pumpAndSettle();
      await tester.enterText(find.byType(TextField).last, 'Оксенфурт');
      await tester.tap(find.text('Использовать в черновике'));
      await tester.pumpAndSettle();
      expect(find.text('Оксенфурт'), findsOneWidget);
      expect(find.text('Показать черновик для подтверждения'), findsOneWidget);
      expect(
        repo.cached('game')?['currentRunFacts']['currentRegion']['value'],
        'Вызима',
      );
    },
  );
}
