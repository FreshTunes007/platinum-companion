import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:platinum_companion/data/update_controller.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  const channel = MethodChannel('platinum_companion/updates');
  tearDown(
    () => TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(channel, null),
  );
  test('offline verification leaves no actionable release', () async {
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(channel, (call) async {
          throw PlatformException(code: 'offline');
        });
    final controller = UpdateController();
    await controller.check(manual: true);
    expect(controller.release, isNull);
    expect(controller.busy, false);
    expect(controller.message, contains('офлайн'));
  });
  test(
    'verified update, deferral and browser action remain separate',
    () async {
      final methods = <String>[];
      TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
          .setMockMethodCallHandler(channel, (call) async {
            methods.add(call.method);
            if (call.method == 'installed') return {'versionName': '0.3.2'};
            if (call.method == 'check') {
              return {
                'status': 'available',
                'showNotice': true,
                'versionCode': 6,
                'versionName': '0.3.3',
                'apkUrl': 'https://freshoryx.com/downloads/platinum-companion/PlatinumCompanion-0.3.3.apk',
                'changelog': ['Test'],
              };
            }
            return null;
          });
      final controller = UpdateController();
      await controller.check();
      expect(controller.showNotice, true);
      expect(methods, isNot(contains('open')));
      await controller.later();
      expect(controller.showNotice, false);
      await controller.open();
      expect(methods.last, 'open');
    },
  );
  test('no update or older channel release has no download action', () async {
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(
          channel,
          (call) async => call.method == 'installed'
              ? {'versionName': '0.3.2'}
              : {'status': 'current'},
        );
    final controller = UpdateController();
    await controller.check();
    expect(controller.release, isNull);
    expect(controller.message, contains('более новая'));
  });
}
