import 'dart:convert';

import 'package:flutter_appauth/flutter_appauth.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';

import 'cloud_api.dart';

abstract interface class CompanionAuth {
  Future<CloudConfiguration?> restore();
  Future<void> login(CloudConfiguration configuration);
  Future<String> accessToken({bool forceRefresh = false});
  Future<void> clear();
}

/// Stores only Companion OIDC credentials, never Sony credentials.
class NativeCompanionAuth implements CompanionAuth {
  final _appAuth = const FlutterAppAuth();
  final _storage = const FlutterSecureStorage();
  static const _key = 'companion_oidc_v1';
  static const _scopes = [
    'openid',
    'offline_access',
    'platinum:read',
    'platinum:sync',
  ];
  CloudConfiguration? _configuration;
  String? _access, _refresh;
  DateTime? _expires;

  @override
  Future<CloudConfiguration?> restore() async {
    final saved = await _storage.read(key: _key);
    if (saved == null) return null;
    try {
      final value = jsonDecode(saved) as Map<String, dynamic>;
      final config = value['configuration'] as Map<String, dynamic>;
      _configuration = CloudConfiguration.parse(
        secureOrigin(config['origin'] as String),
        config,
      );
      _access = value['access'] as String?;
      _refresh = value['refresh'] as String?;
      _expires = DateTime.tryParse(value['expires'] as String? ?? '');
      return _configuration;
    } catch (_) {
      throw const CloudFailure('login_required');
    }
  }

  Future<void> _save() => _storage.write(
    key: _key,
    value: jsonEncode({
      'configuration': _configuration!.toJson(),
      'access': _access,
      'refresh': _refresh,
      'expires': _expires?.toUtc().toIso8601String(),
    }),
  );

  Future<void> _accept(TokenResponse response) async {
    if (response.accessToken == null ||
        response.accessTokenExpirationDateTime == null) {
      throw const CloudFailure('login_required');
    }
    _access = response.accessToken;
    _refresh = response.refreshToken ?? _refresh;
    _expires = response.accessTokenExpirationDateTime;
    await _save(); // Persist rotated refresh token before another request.
  }

  @override
  Future<void> login(CloudConfiguration configuration) async {
    // AppAuth uses the external browser and a random PKCE verifier/state/nonce.
    final response = await _appAuth.authorizeAndExchangeCode(
      AuthorizationTokenRequest(
        configuration.clientId,
        CloudConfiguration.redirectUri,
        issuer: configuration.issuer,
        scopes: _scopes,
        promptValues: ['login'],
        // The native client receives its audience from Keycloak's fixed mapper.
        // An audience name is not an RFC 8707 resource URI (invalid_target).
      ),
    );
    _configuration = configuration;
    _refresh = null;
    await _accept(response);
  }

  @override
  Future<String> accessToken({bool forceRefresh = false}) async {
    if (!forceRefresh &&
        _access != null &&
        _expires != null &&
        _expires!.isAfter(DateTime.now().add(const Duration(seconds: 60)))) {
      return _access!;
    }
    final config = _configuration;
    if (config == null || _refresh == null) {
      throw const CloudFailure('login_required');
    }
    final response = await _appAuth.token(
      TokenRequest(
        config.clientId,
        CloudConfiguration.redirectUri,
        issuer: config.issuer,
        refreshToken: _refresh,
      ),
    );
    await _accept(response);
    return _access!;
  }

  @override
  Future<void> clear() async {
    await _storage.delete(key: _key);
    _configuration = null;
    _access = null;
    _refresh = null;
    _expires = null;
  }
}
