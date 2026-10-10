// Fixtures establish the protocol only, never account admission or live AI.
import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:platinum_companion/data/chatgpt_plan_protocol.dart';
import 'package:platinum_companion/data/chatgpt_plan_loopback.dart';

const host = 'urn:uuid:35c65273-d710-4c0e-bb1b-282df5bc7838';
PlanAuthorizationAttempt attempt({String? issued}) => PlanAuthorizationAttempt(
  callback: Uri.parse('http://127.0.0.1:1455/auth/callback'),
  hostId: host,
  issuedClientId: issued,
);
Uri returned(PlanAuthorizationAttempt a, {String? state, String? client}) =>
    a.callback.replace(
      queryParameters: {
        'state': state ?? a.state,
        'code': 'fixture-code',
        'client_id': ?client,
      },
    );
Stream<List<int>> events(
  List<Map<String, dynamic>> data,
) => Stream.fromIterable(
  utf8
      .encode(
        '${data.map((e) => 'data: ${jsonEncode(e)}\r\n\r\n').join()}data: [DONE]\n\n',
      )
      .map((b) => [b]), // Split Unicode and SSE frames across bytes.
);
void main() {
  final realContext = Platform.environment['PLATINUM_VERIFY_PLAN_CONTEXT'];
  if (realContext != null) {
    test('real saved production Journey prepares context without state writes or inference', () async {
      final data = jsonDecode(
        await File(realContext).readAsString(),
      ) as Map<String, dynamic>;
      final before = jsonEncode(data['context']);
      final context = planGameContext(
        Map<String, dynamic>.from(data['context'] as Map),
      );
      expect(
        context['trophySummary']['earned'],
        data['proof']['trophySummary']['earned'],
      );
      expect(context['trophySummary']['source'], 'PSN_VERIFIED');
      expect(context['game']['revision'], data['proof']['runRevision']);
      expect(context['facts']['currentRegion']['source'], 'USER_CONFIRMED');
      expect(jsonEncode(data['context']), before);
      expect(data['proof']['playerStateChanged'], false);
      expect(data['proof']['modelRequests'], 0);
    });
  }
  test('callback from another attempt cannot be exchanged', () {
    final a = attempt(), b = attempt();
    final callback = a.validateCallback(returned(a, client: 'oaiapp_fixture'));
    expect(
      () => b.exchangeBody(callback, selectedPrivateClientApproved: true),
      throwsA(isA<PlanUsageFailure>()),
    );
  });
  test('closing local listener cancels its pending attempt', () async {
    final listener = await PlanLoopback.listen(hostId: host);
    final cancelled = expectLater(
      listener.result,
      throwsA(isA<PlanUsageFailure>()),
    );
    await listener.close();
    await cancelled;
  });
  test('unapproved closed client cannot start authorize or inference', () {
    expect(
      () => attempt().authorizationUri(),
      throwsA(isA<PlanUsageFailure>()),
    );
    expect(
      () => planResponseBody(
        model: 'fixture-model',
        catalog: [],
        input: [],
        grantedScopes: planScopes,
        consent: true,
      ),
      throwsA(isA<PlanUsageFailure>()),
    );
  });
  test(
    'new registration uses own name, exact loopback and fresh S256 state',
    () {
      final a = attempt(), b = attempt();
      final p = a
          .authorizationUri(selectedPrivateClientApproved: true)
          .queryParameters;
      expect(p['client_id'], 'dynamic_agent_client');
      expect(p['agent_name_hint'], 'Platinum Companion');
      expect(p['redirect_uri'], a.callback.toString());
      expect(p['resource'], planResource);
      expect(p['code_challenge_method'], 'S256');
      expect(p['code_challenge'], a.challenge);
      expect(p['state'], isNot(b.state));
      expect(a.verifier.length, inInclusiveRange(43, 128));
      expect(p.containsKey('client_secret'), false);
    },
  );
  test('returning sign-in retains issued client and stable host', () {
    final a = attempt(issued: 'oaiapp_fixture');
    final p = a
        .authorizationUri(selectedPrivateClientApproved: true)
        .queryParameters;
    expect(p['client_id'], 'oaiapp_fixture');
    expect(p['ext_agent_host_id'], host);
    expect(p.containsKey('agent_name_hint'), false);
    final c = a.validateCallback(returned(a));
    expect(c.clientId, 'oaiapp_fixture');
    expect(
      () => a.validateCallback(returned(a, client: 'oaiapp_other')),
      throwsA(isA<PlanUsageFailure>()),
    );
  });
  test('registration callback requires issued ID, state and original path', () {
    final a = attempt();
    expect(
      () => a.validateCallback(returned(a)),
      throwsA(isA<PlanUsageFailure>()),
    );
    expect(
      () => a.validateCallback(returned(a, client: 'dynamic_agent_client')),
      throwsA(isA<PlanUsageFailure>()),
    );
    expect(
      () => a.validateCallback(
        returned(a, state: 'wrong', client: 'oaiapp_fixture'),
      ),
      throwsA(isA<PlanUsageFailure>()),
    );
    final c = a.validateCallback(returned(a, client: 'oaiapp_fixture'));
    final body = a.exchangeBody(c, selectedPrivateClientApproved: true);
    expect(body['client_id'], 'oaiapp_fixture');
    expect(body['redirect_uri'], a.callback.toString());
    expect(c.toString(), isNot(contains('fixture-code')));
    expect(
      () => a.validateCallback(
        returned(a, client: 'oaiapp_fixture').replace(path: '/callback'),
      ),
      throwsA(isA<PlanUsageFailure>()),
    );
  });
  test('localhost and Companion custom scheme are not substitutes', () {
    for (final uri in [
      'http://localhost:1455/auth/callback',
      'app.platinumcompanion.android:/oauthredirect',
      'https://127.0.0.1:1455/auth/callback',
    ]) {
      expect(
        () => PlanAuthorizationAttempt(callback: Uri.parse(uri), hostId: host),
        throwsA(isA<PlanUsageFailure>()),
      );
    }
  });
  test('direct grant cannot be inferred from identity or callback scopes', () {
    expect(hasDirectPlanGrant('openid profile email'), false);
    expect(hasDirectPlanGrant('chatgpt.tokens.use.directly'), false);
    expect(hasDirectPlanGrant(planScopes), true);
    final body = planRefreshBody('oaiapp_fixture', 'fixture-local-refresh');
    expect(body.containsKey('scope'), false);
    expect(body['resource'], planResource);
    expect(
      () => planRefreshBody('dynamic_agent_client', 'fixture'),
      throwsA(isA<PlanUsageFailure>()),
    );
  });
  test('account model catalogue and request omit unsupported fields', () {
    final models = planModelCatalog({
      'models': [
        {
          'slug': 'fixture-model',
          'display_name': 'Fixture',
          'visibility': 'list',
        },
        {'slug': 'hidden', 'display_name': 'Hidden', 'visibility': 'hide'},
      ],
    });
    expect(models.length, 1);
    final body = planResponseBody(
      model: models.first['slug']!,
      catalog: models,
      input: [
        {'role': 'user', 'content': 'Fixture input'},
      ],
      grantedScopes: planScopes,
      consent: true,
      selectedPrivateClientApproved: true,
    );
    expect(body.keys.toSet(), {'model', 'input', 'store', 'stream'});
    expect(body['store'], false);
    expect(body['stream'], true);
    expect(
      () => planResponseBody(
        model: 'hidden',
        catalog: models,
        input: [
          {'role': 'user', 'content': 'x'},
        ],
        grantedScopes: planScopes,
        consent: true,
        selectedPrivateClientApproved: true,
      ),
      throwsA(isA<PlanUsageFailure>()),
    );
  });
  test('inference requires both exact grant and external-transfer consent', () {
    for (final permissions in [
      ('', true),
      ('chatgpt.tokens.use.direct', true),
      (planScopes, false),
    ]) {
      expect(
        () => planResponseBody(
          model: 'fixture',
          catalog: [
            {'slug': 'fixture'},
          ],
          input: [
            {'role': 'user', 'content': 'x'},
          ],
          grantedScopes: permissions.$1,
          consent: permissions.$2,
          selectedPrivateClientApproved: true,
        ),
        throwsA(isA<PlanUsageFailure>()),
      );
    }
  });
  test(
    'SSE handles split UTF8, requires completion and returns real deltas',
    () async {
      final text = await consumePlanResponse(
        events([
          {'type': 'response.output_text.delta', 'delta': 'Привет'},
          {
            'type': 'response.completed',
            'response': {'status': 'completed'},
          },
        ]),
      );
      expect(text, 'Привет');
    },
  );
  test('partial stream and late usage error never become success', () async {
    for (final end in [
      null,
      {
        'type': 'response.failed',
        'response': {
          'error': {'code': 'subscription_sharing_usage_limit_exceeded'},
        },
      },
      {'type': 'response.incomplete', 'response': {}},
    ]) {
      await expectLater(
        consumePlanResponse(
          events([
            {'type': 'response.output_text.delta', 'delta': 'Partial'},
            ?end,
          ]),
        ),
        throwsA(isA<PlanUsageFailure>()),
      );
    }
  });
  test('completed stream with no text is not a personal-answer PASS', () async {
    await expectLater(
      consumePlanResponse(
        events([
          {
            'type': 'response.completed',
            'response': {'status': 'completed'},
          },
        ]),
      ),
      throwsA(isA<PlanUsageFailure>()),
    );
  });
  test('context keeps provenance, version uncertainty and no credentials', () {
    final value = planGameContext({
      'schemaVersion': 1,
      'title': 'The Witcher 3',
      'platform': 'PS5',
      'run': {'id': 'fixture-run'},
      'revision': 29,
      'revealed': false,
      'ownerId': 'must-not-export',
      'accessToken': 'must-not-export',
      'trophySource': 'direct_psn_api',
      'trophySummary': {'earned': 8, 'total': 79},
      'currentRunFacts': {
        'currentRegion': {'value': 'Vizima', 'source': 'user_confirmation'},
      },
      'actions': [
        {'id': 'difficulty', 'certainty': 'VERSION_UNCERTAIN', 'evidence': []},
        {'id': 'spoiler', 'spoilerHidden': true},
      ],
      'coverage': {'total': 12},
      'criticalUnknowns': [],
    });
    expect(value['facts']['currentRegion']['source'], 'USER_CONFIRMED');
    expect(value['trophySummary']['source'], 'PSN_VERIFIED');
    expect((value['rules'] as List).length, 1);
    expect(value['rules'][0]['verificationStatus'], 'VERSION_UNCERTAIN');
    expect(jsonEncode(value), isNot(contains('must-not-export')));
  });
  test(
    'real loopback rejects wrong state then consumes one valid callback',
    () async {
      final listener = await PlanLoopback.listen(hostId: host);
      final client = HttpClient();
      addTearDown(() async {
        client.close(force: true);
        await listener.close();
      });
      Future<(int, String)> get(Uri uri) async {
        final r = await (await client.getUrl(uri)).close();
        return (r.statusCode, await utf8.decoder.bind(r).join());
      }

      final invalid = await get(
        returned(listener.attempt, state: 'wrong', client: 'oaiapp_fixture'),
      );
      expect(invalid.$1, 400);
      final success = await get(
        returned(listener.attempt, client: 'oaiapp_fixture'),
      );
      expect(success.$1, 200);
      expect(success.$2, isNot(contains('fixture-code')));
      expect((await listener.result).clientId, 'oaiapp_fixture');
    },
  );
}
