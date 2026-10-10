// Official SIWC protocol for the published open-source Android client.
// Pure contract: no credentials, storage or network calls in this module.
import 'dart:convert';
import 'dart:math';

import 'package:crypto/crypto.dart';

class PlanUsageFailure implements Exception {
  const PlanUsageFailure(this.code);
  final String code;
  @override
  String toString() => 'PlanUsageFailure($code)';
}

const planResource = 'https://api.openai.com/v1';
const planScopes =
    'openid profile email offline_access resource.invoke '
    'chatgpt.tokens.use.direct';

String _random() =>
    base64UrlEncode(List.generate(32, (_) => Random.secure().nextInt(256)))
        .replaceAll('=', '');

bool validPlanHostId(String id) => RegExp(
  r'^urn:uuid:[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$',
).hasMatch(id);

bool validIssuedClient(String id) =>
    id != 'dynamic_agent_client' &&
    RegExp(r'^[A-Za-z0-9_.~-]{1,200}$').hasMatch(id);

class PlanAuthorizationAttempt {
  PlanAuthorizationAttempt({
    required this.callback,
    required this.hostId,
    this.issuedClientId,
  }) : state = _random(),
       nonce = _random(),
       verifier = _random() {
    if (callback.scheme != 'http' ||
        callback.host != '127.0.0.1' ||
        callback.path != '/auth/callback' ||
        callback.port < 1 ||
        callback.port > 65535 ||
        callback.hasQuery ||
        callback.hasFragment ||
        callback.userInfo.isNotEmpty ||
        !validPlanHostId(hostId) ||
        issuedClientId != null && !validIssuedClient(issuedClientId!)) {
      throw const PlanUsageFailure('invalid_registration_configuration');
    }
  }
  final Uri callback;
  final String hostId, state, nonce, verifier;
  final String? issuedClientId;
  String get challenge =>
      base64UrlEncode(sha256.convert(utf8.encode(verifier)).bytes)
          .replaceAll('=', '');

  Uri authorizationUri({bool officialFlowEnabled = false}) {
    if (!officialFlowEnabled) {
      throw const PlanUsageFailure('official_flow_disabled');
    }
    return Uri.https('auth.openai.com', '/api/accounts/authorize', {
      'client_id': issuedClientId ?? 'dynamic_agent_client',
      if (issuedClientId == null) 'agent_name_hint': 'Platinum Companion',
      'ext_agent_host_id': hostId,
      'response_type': 'code',
      'redirect_uri': callback.toString(),
      'scope': planScopes,
      'resource': planResource,
      'state': state,
      'nonce': nonce,
      'code_challenge_method': 'S256',
      'code_challenge': challenge,
    });
  }

  Map<String, String> exchangeBody(
    PlanCallback result, {
    bool officialFlowEnabled = false,
  }) {
    if (!officialFlowEnabled) {
      throw const PlanUsageFailure('official_flow_disabled');
    }
    if (result._stateBinding != state) {
      throw const PlanUsageFailure('invalid_callback');
    }
    return {
      'grant_type': 'authorization_code',
      'client_id': result.clientId,
      'code': result.code,
      'code_verifier': verifier,
      'redirect_uri': callback.toString(),
      'resource': planResource,
    };
  }

  PlanCallback validateCallback(Uri uri) {
    if (uri.scheme != callback.scheme ||
        uri.host != callback.host ||
        uri.port != callback.port ||
        uri.path != callback.path ||
        uri.userInfo.isNotEmpty ||
        uri.hasFragment ||
        uri.queryParametersAll.values.any((v) => v.length != 1) ||
        uri.queryParameters['state'] != state) {
      throw const PlanUsageFailure('invalid_callback');
    }
    if (uri.queryParameters.containsKey('error')) {
      throw const PlanUsageFailure('authorization_declined');
    }
    final client = uri.queryParameters['client_id'] ?? issuedClientId;
    final code = uri.queryParameters['code'];
    if (client == null ||
        !validIssuedClient(client) ||
        issuedClientId != null && client != issuedClientId ||
        code == null ||
        code.isEmpty ||
        code.length > 4096) {
      throw const PlanUsageFailure('incomplete_registration');
    }
    return PlanCallback._(code, client, state);
  }
}

class PlanCallback {
  const PlanCallback._(this.code, this.clientId, this._stateBinding);
  final String code, clientId;
  final String _stateBinding;
  // Default Object.toString deliberately never reveals the authorization code.
}

bool hasDirectPlanGrant(String grantedScopes) =>
    grantedScopes.split(RegExp(r'\s+')).contains('chatgpt.tokens.use.direct');

Map<String, String> planRefreshBody(String clientId, String refreshToken) {
  if (!validIssuedClient(clientId) || refreshToken.isEmpty) {
    throw const PlanUsageFailure('invalid_registration');
  }
  return {
    'grant_type': 'refresh_token',
    'client_id': clientId,
    'refresh_token': refreshToken,
    'resource': planResource,
  };
}

List<Map<String, String>> planModelCatalog(Map<String, dynamic> data) {
  if (data['models'] is! List) throw const PlanUsageFailure('invalid_models');
  final result = <Map<String, String>>[];
  final seen = <String>{};
  for (final model in data['models'] as List) {
    if (model is! Map || model['visibility'] != 'list') continue;
    if (model['slug'] is! String ||
        model['display_name'] is! String ||
        !RegExp(r'^[A-Za-z0-9_.-]{1,100}$').hasMatch(model['slug'])) {
      throw const PlanUsageFailure('invalid_models');
    }
    if (seen.add(model['slug'])) {
      result.add({
        'slug': model['slug'],
        'display_name': model['display_name'],
      });
    }
  }
  return result;
}

Map<String, dynamic> planResponseBody({
  required String model,
  required List<Map<String, String>> catalog,
  required List<Map<String, dynamic>> input,
  required String grantedScopes,
  required bool consent,
  bool officialFlowEnabled = false,
  String? instructions,
}) {
  if (!officialFlowEnabled) {
    throw const PlanUsageFailure('official_flow_disabled');
  }
  if (!hasDirectPlanGrant(grantedScopes) ||
      !grantedScopes.split(RegExp(r'\s+')).contains('resource.invoke')) {
    throw const PlanUsageFailure('plan_permission_missing');
  }
  if (!consent) {
    throw const PlanUsageFailure('external_transfer_consent_required');
  }
  if (!catalog.any((m) => m['slug'] == model) ||
      input.isEmpty ||
      input.any((i) => i['role'] == 'system')) {
    throw const PlanUsageFailure('invalid_inference_request');
  }
  return {
    'model': model,
    'input': input,
    'store': false,
    'stream': true,
    'instructions': ?instructions,
  };
}

/// Build from the authenticated existing Journey projection, not an entire PSN
/// library or credential record. No network/write or automatic confirmation.
Map<String, dynamic> planGameContext(Map<String, dynamic> journey) {
  if (journey['schemaVersion'] != 1 ||
      journey['currentRunFacts'] is! Map ||
      journey['actions'] is! List ||
      journey['trophySummary'] is! Map) {
    throw const PlanUsageFailure('invalid_game_context');
  }
  final facts = <String, dynamic>{};
  for (final e in (journey['currentRunFacts'] as Map).entries) {
    final fact = e.value;
    if (fact is Map) {
      facts[e.key.toString()] = {
        'value': fact['value'],
        'source': fact['source'] == 'user_confirmation'
            ? 'USER_CONFIRMED'
            : 'UNKNOWN',
      };
    }
  }
  final value = <String, dynamic>{
    'game': {
      'title': journey['title'],
      'platform': journey['platform'],
      'runId': journey['run']?['id'],
      'revision': journey['revision'],
    },
    'reveal': journey['revealed'] == true,
    'facts': facts,
    'trophySummary': {
      ...journey['trophySummary'] as Map,
      'source': journey['trophySource'] == 'direct_psn_api'
          ? 'PSN_VERIFIED'
          : 'IMPORTED',
      'observedAt': journey['lastSuccessfulSyncAt'],
    },
    'rules': [
      for (final a in journey['actions'] as List)
        if (a is Map && a['spoilerHidden'] != true)
          {
            'ruleId': a['id'],
            'title': a['title'],
            'message': a['message'],
            'category': a['category'],
            'verificationStatus': a['certainty'],
            'evidence': (a['evidence'] as List? ?? []).take(3).toList(),
          },
    ],
    'coverage': journey['coverage'],
    'criticalUnknowns': journey['criticalUnknowns'],
    'policy':
        'Model output is INFERRED; changes require separate user confirmation. '
        'Only Sony confirms trophies. Knowledge coverage is limited.',
  };
  if (utf8.encode(jsonEncode(value)).length > 48 * 1024) {
    throw const PlanUsageFailure('context_too_large');
  }
  return value;
}

/// Parse HTTP/SSE through a real terminal event. Partial output never becomes a
/// successful result or an applied game event. No retries or token logging.
Future<String> consumePlanResponse(
  Stream<List<int>> bytes, {
  void Function(String delta)? onDelta,
}) async {
  final data = <String>[];
  var text = '', pendingBytes = 0, terminal = false;
  void dispatch() {
    if (data.isEmpty) return;
    final payload = data.join('\n');
    data.clear();
    pendingBytes = 0;
    if (payload == '[DONE]') return;
    final e = jsonDecode(payload);
    if (e is! Map) throw const PlanUsageFailure('invalid_stream');
    if (terminal) throw const PlanUsageFailure('events_after_completion');
    if (e['type'] == 'response.output_text.delta') {
      final delta = e['delta'];
      if (delta is! String) throw const PlanUsageFailure('invalid_stream');
      text += delta;
      if (utf8.encode(text).length > 64 * 1024) {
        throw const PlanUsageFailure('response_too_large');
      }
      onDelta?.call(delta);
    } else if (e['type'] == 'response.completed') {
      if (e['response'] is! Map || e['response']['status'] != 'completed') {
        throw const PlanUsageFailure('invalid_terminal_event');
      }
      terminal = true;
    } else if ([
      'response.failed',
      'response.incomplete',
      'error',
    ].contains(e['type'])) {
      final code =
          e['response']?['error']?['code'] ?? e['error']?['code'] ?? e['code'];
      throw PlanUsageFailure(
        code is String && RegExp(r'^[a-z_]{1,100}$').hasMatch(code)
            ? code
            : 'inference_incomplete',
      );
    }
  }

  await for (final line
      in bytes.transform(utf8.decoder).transform(const LineSplitter())) {
    if (line.isEmpty) {
      dispatch();
      continue;
    }
    if (line.startsWith('data:')) {
      final value = line.substring(5).trimLeft();
      pendingBytes += utf8.encode(value).length;
      if (pendingBytes > 256 * 1024) {
        throw const PlanUsageFailure('event_too_large');
      }
      data.add(value);
    }
  }
  dispatch();
  if (!terminal) throw const PlanUsageFailure('stream_interrupted');
  if (text.trim().isEmpty) throw const PlanUsageFailure('no_text_output');
  return text;
}
