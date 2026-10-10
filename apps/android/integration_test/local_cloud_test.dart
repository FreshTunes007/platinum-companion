// This target uses a separate Android package. It is never the release entrypoint.
import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';
import 'package:platinum_companion/data/cloud_api.dart';
import 'package:platinum_companion/data/cloud_auth.dart';
import 'package:platinum_companion/data/cloud_controller.dart';
import 'package:platinum_companion/data/data.dart';
import 'package:platinum_companion/ui/app.dart';

class LocalTestAuth implements CompanionAuth {
  LocalTestAuth(this.transport);
  final CloudTransport transport;
  String? token;
  @override
  Future<CloudConfiguration?> restore() async => CloudConfiguration(
    Uri.parse('https://127.0.0.1:18787/'),
    'https://synthetic.invalid/',
    'test',
    'local-test',
  );
  @override
  Future<void> login(CloudConfiguration configuration) async =>
      throw UnimplementedError(
        'Browser OAuth is outside this synthetic-identity proof',
      );
  @override
  Future<String> accessToken({bool forceRefresh = false}) async {
    token ??=
        (await transport.request(
              Uri.parse('https://127.0.0.1:18787/test/login'),
            ))['accessToken']
            as String;
    return token!;
  }

  @override
  Future<void> clear() async {
    token = null;
  }
}

void main() {
  IntegrationTestWidgetsFlutterBinding.ensureInitialized();
  testWidgets(
    'actual emulator HTTPS API, real saved five-game snapshot, atomic native restart and logout',
    (tester) async {
      const ca = String.fromEnvironment('TEST_PUBLIC_CA_BASE64');
      expect(ca, isNotEmpty);
      final context = SecurityContext(withTrustedRoots: false)
        ..setTrustedCertificatesBytes(base64Decode(ca));
      final transport = HttpsCloudTransport(
        clientFactory: () => HttpClient(context: context),
      );
      final repo = TrophyRepository(storage: NativeSnapshotStorage());
      await repo.initialize();
      final cloud = CloudController(
        repository: repo,
        auth: LocalTestAuth(transport),
        transport: transport,
      );
      await cloud.initialize();
      expect(cloud.error, isNull);
      expect(repo.games.length, 5);
      expect(repo.ownerId, isNotNull);
      expect(repo.games.every((g) => g.source == 'direct_psn_api'), isTrue);
      final ids = repo.games.map((g) => g.id).toSet();
      expect(ids.length, 5);
      final before = SnapshotCodec.encode(repo.snapshot!);
      final restored = TrophyRepository(storage: NativeSnapshotStorage());
      await restored.initialize();
      expect(SnapshotCodec.encode(restored.snapshot!), before);
      expect(restored.ownerId, repo.ownerId);
      await tester.pumpWidget(PlatinumApp(repository: repo, cloud: cloud));
      await tester.pumpAndSettle();
      expect(find.text('Companion подключён'), findsOneWidget);
      await cloud.refresh(requestPsn: true);
      expect(cloud.notice, contains('на паузе'));
      await cloud.disconnect();
      expect(cloud.connected, isFalse);
      expect(SnapshotCodec.encode(repo.snapshot!), before);
      // The same server-side session is now revoked, including its still-valid JWT.
      final me = transport.request(
        Uri.parse('https://127.0.0.1:18787/api/v1/me'),
        token: await LocalTestAuth(transport).accessToken(),
      );
      await expectLater(me, throwsA(isA<CloudFailure>()));
      await tester.pumpAndSettle();
      expect(find.text('Офлайн-библиотека'), findsWidgets);
    },
  );
}
