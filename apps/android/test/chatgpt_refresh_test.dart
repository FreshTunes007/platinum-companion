// Contract fixtures only: no actual OpenAI login, encryption or inference claim.
import 'dart:convert';

import 'package:flutter/services.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:platinum_companion/data/chatgpt_plan_client.dart';
import 'package:platinum_companion/data/chatgpt_plan_protocol.dart';

class RefreshFixture extends PlanHttp {
  int exchanges = 0;
  bool keysUnavailable = true;
  @override
  Future<Map<String, dynamic>> json(
    String url, {
    Map<String, String>? form,
    String? access,
  }) async {
    if (url.endsWith('/token')) {
      exchanges++;
      expect(form!['refresh_token'], 'fixture-old-refresh');
      expect(form.containsKey('scope'), false);
      final epoch = DateTime.now().millisecondsSinceEpoch ~/ 1000;
      String part(dynamic value) =>
          base64UrlEncode(utf8.encode(jsonEncode(value))).replaceAll('=', '');
      return {
        'access_token': 'fixture-new-access',
        'refresh_token': 'fixture-new-refresh',
        'scope': planScopes,
        'token_type': 'Bearer',
        'expires_in': 3600,
        'id_token':
            '${part({'alg': 'RS256', 'kid': 'fixture'})}.${part({'iss': 'https://auth.openai.com', 'aud': 'oaiapp_fixture', 'sub': 'fixture-subject', 'iat': epoch, 'exp': epoch + 3600})}.Zml4dHVyZQ',
      };
    }
    if (url.endsWith('/jwks.json')) {
      if (keysUnavailable) throw const PlanUsageFailure('network_unavailable');
      return {
        'keys': [
          {'kty': 'RSA', 'kid': 'fixture', 'n': 'fixture-modulus', 'e': 'AQAB'},
        ],
      };
    }
    throw StateError('unexpected fixture endpoint');
  }
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  setUp(() {
    FlutterSecureStorage.setMockInitialValues({
      'chatgpt_device_accounts_v1': jsonEncode({
        'active': 'oaiapp_fixture:fixture-subject',
        'accounts': {
          'oaiapp_fixture:fixture-subject': {
            'client_id': 'oaiapp_fixture',
            'subject': 'fixture-subject',
            'access_token': 'fixture-old-access',
            'refresh_token': 'fixture-old-refresh',
            'scope': planScopes,
            'expires': '2020-01-01T00:00:00Z',
          },
        },
      }),
    });
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(
          const MethodChannel('platinum_companion/chatgpt'),
          (call) async => call.method == 'verifySignature',
        );
  });
  test('rotated refresh survives JWKS outage and restart without replay or unverified access', () async {
    final http = RefreshFixture();
    final first = ChatGptPlanClient(http: http);
    await first.restore();
    await expectLater(first.access(), throwsA(isA<PlanUsageFailure>()));
    expect(http.exchanges, 1);
    expect(first.pendingVerification, true);
    final restarted = ChatGptPlanClient(http: http);
    await restarted.restore();
    http.keysUnavailable = false;
    expect(await restarted.access(), 'fixture-new-access');
    expect(http.exchanges, 1);
    expect(restarted.pendingVerification, false);
    final last = ChatGptPlanClient(http: http);
    await last.restore();
    expect(await last.access(), 'fixture-new-access');
    expect(http.exchanges, 1);
  });
  test('concurrent access shares a single rotating refresh attempt', () async {
    final http = RefreshFixture()..keysUnavailable = false;
    final client = ChatGptPlanClient(http: http);
    await client.restore();
    expect(await Future.wait([client.access(), client.access()]), [
      'fixture-new-access',
      'fixture-new-access',
    ]);
    expect(http.exchanges, 1);
  });
}
