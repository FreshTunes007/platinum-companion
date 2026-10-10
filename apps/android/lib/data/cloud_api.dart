import 'dart:convert';
import 'dart:io';

class CloudFailure implements Exception {
  const CloudFailure(this.code);
  final String code;
  @override
  String toString() => 'CloudFailure($code)';
}

Uri secureOrigin(String input) {
  final uri = Uri.tryParse(input.trim());
  if (uri == null ||
      uri.scheme != 'https' ||
      uri.host.isEmpty ||
      uri.userInfo.isNotEmpty ||
      uri.hasQuery ||
      uri.hasFragment ||
      (uri.path.isNotEmpty && uri.path != '/')) {
    throw const CloudFailure('https_origin_required');
  }
  return uri.replace(path: '/');
}

abstract interface class CloudTransport {
  Future<Map<String, dynamic>> request(
    Uri url, {
    String method = 'GET',
    String? token,
    Map<String, dynamic>? body,
  });
}

/// No redirects, insecure certificates, query-string tokens or request logging.
class HttpsCloudTransport implements CloudTransport {
  HttpsCloudTransport({HttpClient Function()? clientFactory})
    : _clientFactory = clientFactory ?? HttpClient.new;
  final HttpClient Function() _clientFactory;
  @override
  Future<Map<String, dynamic>> request(
    Uri url, {
    String method = 'GET',
    String? token,
    Map<String, dynamic>? body,
  }) async {
    if (url.scheme != 'https' || url.userInfo.isNotEmpty) {
      throw const CloudFailure('https_required');
    }
    final client = _clientFactory()
      ..connectionTimeout = const Duration(seconds: 15);
    try {
      return await (() async {
        final req = await client.openUrl(method, url);
        req.followRedirects = false;
        if (body != null) {
          req.headers.contentType = ContentType.json;
          req.write(jsonEncode(body));
        }
        req.headers.set(HttpHeaders.acceptHeader, 'application/json');
        if (token != null) {
          req.headers.set(HttpHeaders.authorizationHeader, 'Bearer $token');
        }
        final response = await req.close();
        if (response.statusCode == 401 || response.statusCode == 403) {
          throw const CloudFailure('login_required');
        }
        if (response.statusCode == 409) {
          throw const CloudFailure('journey_conflict');
        }
        if ([400, 413, 415, 429].contains(response.statusCode)) {
          final bytes = <int>[];
          await for (final chunk in response) {
            bytes.addAll(chunk);
            if (bytes.length > 4096) {
              throw const CloudFailure('invalid_response');
            }
          }
          String? code;
          try {
            final value = jsonDecode(utf8.decode(bytes));
            if (value is Map && value['error'] is String) code = value['error'];
          } catch (_) {}
          if (code != null &&
              RegExp(
                r'^(companion_|invalid_companion_|ai_|journey_|invalid_journey_|request_too_large|invalid_json|json_required|active_game_required)[a-z_]*$',
              ).hasMatch(code)) {
            throw CloudFailure(code);
          }
          throw const CloudFailure('request_rejected');
        }
        if (response.statusCode < 200 || response.statusCode >= 300) {
          throw const CloudFailure('server_unavailable');
        }
        if (response.headers.contentType?.mimeType != 'application/json' ||
            response.contentLength > 11 * 1024 * 1024) {
          throw const CloudFailure('invalid_response');
        }
        final bytes = <int>[];
        await for (final chunk in response) {
          bytes.addAll(chunk);
          if (bytes.length > 11 * 1024 * 1024) {
            throw const CloudFailure('invalid_response');
          }
        }
        final value = jsonDecode(utf8.decode(bytes));
        if (value is! Map<String, dynamic>) {
          throw const CloudFailure('invalid_response');
        }
        return value;
      })().timeout(const Duration(seconds: 30));
    } on CloudFailure {
      rethrow;
    } catch (_) {
      throw const CloudFailure('network_unavailable');
    } finally {
      client.close(force: true);
    }
  }
}

class CloudConfiguration {
  const CloudConfiguration(
    this.origin,
    this.issuer,
    this.clientId,
    this.audience,
  );
  final Uri origin;
  final String issuer, clientId, audience;
  static const redirectUri = 'app.platinumcompanion.android:/oauthredirect';
  factory CloudConfiguration.parse(Uri origin, Map<String, dynamic> value) {
    final issuer = Uri.tryParse(
      value['issuer'] is String ? value['issuer'] as String : '',
    );
    if (value['schemaVersion'] != 1 ||
        issuer == null ||
        issuer.scheme != 'https' ||
        issuer.host.isEmpty ||
        issuer.userInfo.isNotEmpty ||
        issuer.hasQuery ||
        issuer.hasFragment ||
        value['clientId'] is! String ||
        (value['clientId'] as String).isEmpty ||
        value['audience'] is! String ||
        (value['audience'] as String).isEmpty) {
      throw const CloudFailure('invalid_configuration');
    }
    return CloudConfiguration(
      origin,
      issuer.toString(),
      value['clientId'] as String,
      value['audience'] as String,
    );
  }
  Map<String, dynamic> toJson() => {
    'schemaVersion': 1,
    'origin': origin.toString(),
    'issuer': issuer,
    'clientId': clientId,
    'audience': audience,
  };
}
