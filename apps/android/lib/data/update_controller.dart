import 'package:flutter/foundation.dart';
import 'package:flutter/services.dart';

class UpdateController extends ChangeNotifier {
  UpdateController({
    this.channel = const MethodChannel('platinum_companion/updates'),
  });
  final MethodChannel channel;
  bool busy = false;
  String releaseChannel = 'stable';
  String installedVersion = '0.3.4';
  String message = 'Проверка подписанного манифеста Freshoryx.';
  Map<String, dynamic>? release;
  bool showNotice = false;

  Future<void> check({bool manual = false}) async {
    if (busy) return;
    busy = true;
    notifyListeners();
    try {
      final info = await channel.invokeMapMethod<String, dynamic>('installed');
      installedVersion = info?['versionName'] as String? ?? installedVersion;
      final result = await channel.invokeMapMethod<String, dynamic>('check', {
        'manual': manual,
        'channel': releaseChannel,
      });
      if (result?['status'] == 'interval') return;
      // Only native verifier output is accepted, never raw network JSON.
      release = result?['status'] == 'available' ? result : null;
      showNotice = release != null && result?['showNotice'] == true;
      message = switch (result?['status']) {
        'available' => 'Доступна версия ${result?['versionName']}',
        'current' => 'Установлена актуальная или более новая версия.',
        'incompatible' => 'Новая версия требует более свежий Android.',
        _ => 'Сейчас обновление недоступно.',
      };
    } on PlatformException {
      release = null;
      showNotice = false;
      message = 'Не удалось безопасно проверить обновления. Библиотека доступна офлайн.';
    } on MissingPluginException {
      message = 'Проверка доступна в Android-приложении.';
    } finally {
      busy = false;
      notifyListeners();
    }
  }

  Future<void> later() async {
    showNotice = false;
    notifyListeners();
    try {
      await channel.invokeMethod<void>('defer', {
        'channel': releaseChannel,
        'versionCode': release?['versionCode'],
      });
    } on PlatformException {
      /* Session still suppresses notice. */
    }
  }

  Future<void> open() async {
    if (release == null) return;
    try {
      await channel.invokeMethod<void>('open', {'url': release!['apkUrl']});
    } on PlatformException {
      message = 'Не удалось открыть браузер.';
      notifyListeners();
    }
  }
}
