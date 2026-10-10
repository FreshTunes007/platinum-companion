// Isolated .integration package only. Real public Keycloak + Chrome callback;
// prompt=none without an owner session must return login_required, never tokens.
import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_appauth/flutter_appauth.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';

void main() {
  IntegrationTestWidgetsFlutterBinding.ensureInitialized();
  testWidgets(
    'public HTTPS OIDC error returns through native Android AppAuth',
    (tester) async {
      await tester.pumpWidget(
        const MaterialApp(
          home: Scaffold(body: Text('OAuth callback test — no owner login')),
        ),
      );
      String result = 'unexpected_success';
      await tester.runAsync(() async {
        try {
          await const FlutterAppAuth()
              .authorize(
                AuthorizationRequest(
                  'companion-android',
                  'app.platinumcompanion.android:/oauthredirect',
                  issuer: 'https://auth.freshoryx.com/realms/companion',
                  scopes: ['openid'],
                  promptValues: ['none'],
                ),
              )
              .timeout(const Duration(seconds: 45));
        } on TimeoutException {
          result = 'callback_timeout';
        } on FlutterAppAuthPlatformException catch (e) {
          // Compare inside memory; never print raw exception details/URL/state.
          result = e.platformErrorDetails.error == 'login_required'
              ? 'login_required'
              : 'other_platform_error';
        } on FlutterAppAuthUserCancelledException {
          result = 'unexpected_native_cancellation';
        } catch (e) {
          result = 'other_error_${e.runtimeType}';
        }
      });
      expect(result, 'login_required');
    },
    timeout: const Timeout(Duration(minutes: 2)),
  );
}
