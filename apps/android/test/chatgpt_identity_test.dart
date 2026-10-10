import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:platinum_companion/data/chatgpt_plan_client.dart';
import 'package:platinum_companion/data/chatgpt_plan_protocol.dart';

String token(Map<String, dynamic> claims, {String alg = 'RS256'}) {
  String part(dynamic value) =>
      base64UrlEncode(utf8.encode(jsonEncode(value))).replaceAll('=', '');
  return '${part({'alg': alg, 'kid': 'fixture-key'})}.${part(claims)}.Zml4dHVyZQ';
}

void main() {
  final now = DateTime.utc(2026, 1, 1);
  final epoch = now.millisecondsSinceEpoch ~/ 1000;
  final claims = {
    'iss': 'https://auth.openai.com',
    'aud': 'oaiapp_fixture',
    'sub': 'fixture-subject',
    'exp': epoch + 600,
    'iat': epoch,
    'nonce': 'fixture-nonce',
  };
  final jwks = {
    'keys': [
      {
        'kty': 'RSA',
        'kid': 'fixture-key',
        'n': 'fixture-n',
        'e': 'AQAB',
        'alg': 'RS256',
      },
    ],
  };
  Future<Map<String, dynamic>> verify(
    Map<String, dynamic> value, {
    bool signature = true,
    String alg = 'RS256',
  }) => verifyPlanIdentity(
    token(value, alg: alg),
    jwks,
    clientId: 'oaiapp_fixture',
    nonce: 'fixture-nonce',
    subject: 'fixture-subject',
    now: now,
    verifySignature: (_) async => signature,
  );
  test('signed identity claims retain account and client binding', () async {
    expect((await verify(claims))['sub'], 'fixture-subject');
  });
  test('signature failure never becomes a validated identity', () async {
    await expectLater(
      verify(claims, signature: false),
      throwsA(isA<PlanUsageFailure>()),
    );
  });
  test(
    'reject wrong issuer audience nonce subject time and algorithm',
    () async {
      for (final delta in [
        {'iss': 'https://example.invalid'},
        {'aud': 'another-client'},
        {'nonce': 'another-attempt'},
        {'sub': 'other-user'},
        {'exp': epoch - 1},
        {'iat': epoch + 120},
        {'nbf': epoch + 120},
        {
          'aud': ['oaiapp_fixture', 'other'],
          'azp': 'other',
        },
      ]) {
        await expectLater(
          verify({...claims, ...delta}),
          throwsA(isA<PlanUsageFailure>()),
        );
      }
      await expectLater(
        verify(claims, alg: 'none'),
        throwsA(isA<PlanUsageFailure>()),
      );
    },
  );
  test('unknown key and duplicate kid fail closed', () async {
    for (final keys in [
      [],
      [jwks['keys']!.first, jwks['keys']!.first],
    ]) {
      await expectLater(
        verifyPlanIdentity(
          token(claims),
          {'keys': keys},
          clientId: 'oaiapp_fixture',
          now: now,
          verifySignature: (_) async => true,
        ),
        throwsA(isA<PlanUsageFailure>()),
      );
    }
  });
  test(
    'device HTTP layer rejects alternate endpoints before making a request',
    () async {
      await expectLater(
        PlanHttp().json('https://example.invalid/token'),
        throwsA(isA<PlanUsageFailure>()),
      );
      await expectLater(
        PlanHttp().json('https://chatgpt.com/backend-api/models'),
        throwsA(isA<PlanUsageFailure>()),
      );
    },
  );
}
