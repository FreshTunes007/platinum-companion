import 'dart:convert';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:platinum_companion/data/cloud_api.dart';
import 'package:platinum_companion/data/cloud_auth.dart';
import 'package:platinum_companion/data/cloud_controller.dart';
import 'package:platinum_companion/data/data.dart';
import 'package:platinum_companion/ui/cloud_panel.dart';

import 'data_test.dart' show syntheticSnapshot, MemorySnapshotStorage;

const owner =
    'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const other =
    'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

class TestAuth implements CompanionAuth {
  CloudConfiguration? config = CloudConfiguration(
    Uri.parse('https://synthetic.invalid/'),
    'https://identity.invalid/',
    'test-public-client',
    'test-api',
  );
  @override
  Future<CloudConfiguration?> restore() async => config;
  @override
  Future<void> login(CloudConfiguration configuration) async {
    config = configuration;
  }

  @override
  Future<String> accessToken({bool forceRefresh = false}) async =>
      'synthetic-only';
  @override
  Future<void> clear() async {
    config = null;
  }
}

class TestTransport implements CloudTransport {
  bool offline = false, denied = false, malformed = false;
  String ownerId = owner;
  int revision = 1;
  Map<String, dynamic>? snapshotOverride;
  final calls = <String>[];
  @override
  Future<Map<String, dynamic>> request(
    Uri url, {
    String method = 'GET',
    String? token,
    Map<String, dynamic>? body,
  }) async {
    calls.add('$method ${url.path}');
    if (offline) throw const CloudFailure('network_unavailable');
    if (denied) throw const CloudFailure('login_required');
    if (url.path == '/api/v1/me') {
      return {'ownerId': ownerId, 'deviceId': owner, 'revision': revision};
    }
    if (url.path == '/api/v1/status') {
      return {
        'ownerId': ownerId,
        'revision': revision,
        'lastResult': 'success',
        'running': false,
      };
    }
    if (url.path == '/api/v1/sync') return {'status': 'cooldown'};
    if (url.path == '/api/v1/snapshot') {
      return {
        'ownerId': ownerId,
        'revision': revision,
        'snapshot': malformed
            ? {'invalid': true}
            : snapshotOverride ?? syntheticSnapshot(),
      };
    }
    if (method == 'DELETE') return {'status': 'revoked'};
    throw const CloudFailure('invalid_response');
  }
}

void main() {
  final realLocal = Platform.environment['PLATINUM_VERIFY_SNAPSHOT'];
  final realCloud = Platform.environment['PLATINUM_VERIFY_CLOUD_SNAPSHOT'];
  if (realLocal != null && realCloud != null) {
    test('real saved five-game cloud seed reconciles with existing PSN library and restarts offline', () async {
      final storage = MemorySnapshotStorage(),
          repo = TrophyRepository(storage: MemorySnapshotStorage());
      await repo.importJson(await File(realLocal).readAsString());
      expect(repo.games.length, 5);
      final before = jsonEncode(repo.games.map((g) => g.toJson()).toList());
      final transport = TestTransport()
        ..snapshotOverride = jsonDecode(
          await File(realCloud).readAsString(),
        ) as Map<String, dynamic>;
      final cloud = CloudController(
        repository: repo,
        auth: TestAuth(),
        transport: transport,
      );
      await cloud.initialize();
      expect(cloud.error, isNull);
      expect(cloud.revision, 1);
      expect(repo.lastImport!.retainedConfirmed, 5);
      expect(
        jsonEncode(repo.games.map((g) => g.toJson()).toList()) == before,
        isTrue,
      );
      final restored = TrophyRepository(storage: repo.storage);
      await restored.initialize();
      expect(
        jsonEncode(restored.games.map((g) => g.toJson()).toList()) == before,
        isTrue,
      );
      final empty = TrophyRepository(storage: storage);
      final emptyCloud = CloudController(
        repository: empty,
        auth: TestAuth(),
        transport: transport,
      );
      await emptyCloud.initialize();
      expect(emptyCloud.error, isNull);
      expect(empty.games.length, 5);
      expect(empty.games.every((g) => g.source == 'imported'), isTrue);
      expect(empty.games.fold<int>(0, (n, g) => n + g.trophies.length), 271);
    });
  }
  test('authenticated imported seed reconciles without downgrading confirmed local PSN or repeating login', () async {
    for (final date in [
      '2026-01-01T10:00:00Z',
      '2026-01-02T10:00:00Z',
      '2026-01-03T10:00:00Z',
    ]) {
      final storage = MemorySnapshotStorage();
      final repo = TrophyRepository(storage: storage);
      await repo.importJson(jsonEncode(syntheticSnapshot()));
      final before = repo.games.single.toJson();
      final transport = TestTransport()
        ..snapshotOverride = syntheticSnapshot(
          source: 'imported',
          observedAt: date,
        );
      final cloud = CloudController(
        repository: repo,
        auth: TestAuth(),
        transport: transport,
      );
      await cloud.initialize();
      expect(cloud.connected, isTrue);
      expect(cloud.error, isNull);
      expect(cloud.revision, 1);
      expect(cloud.notice, contains('подтверждённые данные'));
      expect(repo.lastImport!.retainedConfirmed, 1);
      expect(repo.games.single.toJson(), before);
      expect(repo.ownerId, owner);
      final restored = TrophyRepository(storage: storage);
      await restored.initialize();
      expect(restored.games.single.toJson(), before);
      expect(restored.ownerId, owner);
      final writes = storage.writes;
      await cloud.refresh();
      expect(storage.writes, writes);
      expect(transport.calls.where((p) => p.contains('/sync')), isEmpty);
    }
  });
  test('cloud reconciliation still rejects another owner and malformed snapshots atomically', () async {
    final storage = MemorySnapshotStorage();
    final bound = TrophyRepository(storage: storage);
    await bound.importJson(
      jsonEncode(syntheticSnapshot()),
      cloudOwnerId: owner,
    );
    final before = storage.value;
    final imported = syntheticSnapshot(source: 'imported');
    expect(
      await bound.importJson(jsonEncode(imported), cloudOwnerId: other),
      isNull,
    );
    expect(storage.value, before);
    (imported['games'] as List).first['summary']['total'] = 999;
    expect(
      await bound.importJson(jsonEncode(imported), cloudOwnerId: owner),
      isNull,
    );
    expect(storage.value, before);
  });
  test('HTTPS origin rejects cleartext, URL credentials, query and paths', () {
    for (final uri in [
      'http://test.invalid',
      'https://u:p@test.invalid',
      'https://test.invalid/?token=x',
      'https://test.invalid/api',
    ]) {
      expect(() => secureOrigin(uri), throwsA(isA<CloudFailure>()));
    }
    expect(secureOrigin('https://test.invalid').scheme, 'https');
  });
  test('cloud observation persists owner and revision; opening and duplicate check never request Sony', () async {
    final storage = MemorySnapshotStorage();
    final repo = TrophyRepository(storage: storage);
    await repo.initialize();
    final transport = TestTransport(), auth = TestAuth();
    final cloud = CloudController(
      repository: repo,
      auth: auth,
      transport: transport,
    );
    await cloud.initialize();
    expect(cloud.error, isNull);
    expect(cloud.revision, 1);
    expect(repo.ownerId, owner);
    expect(repo.games.single.summary.earned, 1);
    final writes = storage.writes;
    await cloud.refresh();
    expect(storage.writes, writes);
    expect(transport.calls.where((p) => p.contains('/sync')), isEmpty);
    final restored = TrophyRepository(storage: storage);
    await restored.initialize();
    expect(restored.ownerId, owner);
    expect(restored.games.length, 1);
  });
  test('401, network failure and malformed cloud snapshot retain atomic offline data and accepted revision', () async {
    final storage = MemorySnapshotStorage(), transport = TestTransport();
    final repo = TrophyRepository(storage: storage);
    await repo.initialize();
    final cloud = CloudController(
      repository: repo,
      auth: TestAuth(),
      transport: transport,
    );
    await cloud.initialize();
    final before = storage.value;
    transport.offline = true;
    await cloud.refresh();
    expect(cloud.error, isNotNull);
    expect(storage.value, before);
    transport.offline = false;
    transport.denied = true;
    await cloud.refresh();
    expect(cloud.requiresLogin, isTrue);
    expect(storage.value, before);
    transport.denied = false;
    transport.malformed = true;
    transport.revision = 2;
    await cloud.refresh();
    expect(cloud.revision, 1);
    expect(storage.value, before);
  });
  test('logout retains owner binding; another owner cannot silently merge into the old library', () async {
    final storage = MemorySnapshotStorage(),
        transport = TestTransport(),
        auth = TestAuth();
    final repo = TrophyRepository(storage: storage);
    await repo.initialize();
    final cloud = CloudController(
      repository: repo,
      auth: auth,
      transport: transport,
    );
    await cloud.initialize();
    final before = storage.value;
    await cloud.disconnect();
    expect(cloud.connected, isFalse);
    expect(storage.value, before);
    expect(repo.ownerId, owner);
    auth.config = CloudConfiguration(
      Uri.parse('https://synthetic.invalid'),
      'https://identity.invalid/',
      'client',
      'api',
    );
    transport.ownerId = other;
    await cloud.initialize();
    expect(cloud.error, contains('не совпадает'));
    expect(storage.value, before);
  });
  test(
    'server cooldown is not reported as successful fresh PSN sync',
    () async {
      final repo = TrophyRepository(storage: MemorySnapshotStorage());
      await repo.initialize();
      final transport = TestTransport();
      final cloud = CloudController(
        repository: repo,
        auth: TestAuth(),
        transport: transport,
      );
      await cloud.initialize();
      await cloud.refresh(requestPsn: true);
      expect(cloud.notice, contains('на паузе'));
      expect(transport.calls.where((c) => c == 'POST /api/v1/sync').length, 1);
    },
  );
  test('first cloud binding on unchanged JSON is still durably written; failing write cannot bind owner', () async {
    final storage = MemorySnapshotStorage(),
        repo = TrophyRepository(storage: MemorySnapshotStorage());
    await repo.initialize();
    final bound = TrophyRepository(storage: storage);
    await bound.initialize();
    await bound.importJson(jsonEncode(syntheticSnapshot()));
    storage.failWrite = true;
    expect(
      await bound.importJson(
        jsonEncode(syntheticSnapshot()),
        cloudOwnerId: owner,
      ),
      isNull,
    );
    expect(bound.ownerId, isNull);
    storage.failWrite = false;
    await bound.importJson(
      jsonEncode(syntheticSnapshot()),
      cloudOwnerId: owner,
    );
    expect(bound.ownerId, owner);
    expect(jsonDecode(storage.value!)['storageVersion'], 2);
  });
  testWidgets(
    'offline cloud settings offer connection without pretending live sync is available',
    (tester) async {
      final repo = TrophyRepository(storage: MemorySnapshotStorage());
      await repo.initialize();
      final auth = TestAuth()..config = null;
      final cloud = CloudController(
        repository: repo,
        auth: auth,
        transport: TestTransport(),
      );
      await cloud.initialize();
      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: SingleChildScrollView(child: CloudPanel(cloud: cloud)),
          ),
        ),
      );
      expect(find.text('Подключить сервер'), findsOneWidget);
      expect(find.text('Обновить из PSN'), findsNothing);
      await tester.tap(find.text('Подключить сервер'));
      await tester.pumpAndSettle();
      expect(find.text('Адрес HTTPS-сервера'), findsOneWidget);
      await tester.tap(find.text('Отмена'));
      await tester.pumpAndSettle();
      expect(cloud.connected, isFalse);
    },
  );
}
