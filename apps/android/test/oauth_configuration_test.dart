import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:platinum_companion/data/cloud_api.dart';

void main() {
  test('AppAuth callback uses the same Android task and registered URI', () {
    final manifest = File('android/app/src/main/AndroidManifest.xml')
        .readAsStringSync();
    final gradle = File('android/app/build.gradle.kts').readAsStringSync();
    // Empty affinity causes RedirectUriReceiverActivity to lose the pending
    // AuthorizationManagementActivity. The native integration test proves it.
    expect(manifest, isNot(contains('android:taskAffinity=""')));
    expect(manifest, contains('android:launchMode="singleTop"'));
    expect(manifest, contains('android:usesCleartextTraffic="false"'));
    final uri = Uri.parse(CloudConfiguration.redirectUri);
    expect(uri.toString(), 'app.platinumcompanion.android:/oauthredirect');
    expect(
      gradle,
      contains(
        'manifestPlaceholders["appAuthRedirectScheme"] = "${uri.scheme}"',
      ),
    );
  });
}
