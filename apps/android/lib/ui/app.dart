import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_localizations/flutter_localizations.dart';

import '../data/data.dart';
import '../data/cloud_controller.dart';
import 'library_page.dart';
import 'settings_page.dart';
import 'theme.dart';
import 'trophy_language.dart';
import '../data/update_controller.dart';

class PlatinumApp extends StatefulWidget {
  const PlatinumApp({
    super.key,
    required this.repository,
    this.cloud,
    this.updates,
  });
  final TrophyRepository repository;
  final CloudController? cloud;
  final UpdateController? updates;

  @override
  State<PlatinumApp> createState() => _PlatinumAppState();
}

class _PlatinumAppState extends State<PlatinumApp> with WidgetsBindingObserver {
  static const _preferences = MethodChannel('platinum_companion/preferences');
  ThemeMode _themeMode = ThemeMode.dark;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    _readTheme();
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state == AppLifecycleState.resumed) widget.cloud?.checkOnResume();
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    super.dispose();
  }

  Future<void> _readTheme() async {
    try {
      final saved = await _preferences.invokeMethod<String>('readTheme');
      if (!mounted) return;
      setState(
        () => _themeMode = switch (saved) {
          'light' => ThemeMode.light,
          'system' => ThemeMode.system,
          _ => ThemeMode.dark,
        },
      );
    } on PlatformException {
      // Preferences are optional. Local trophy data has its own strict storage.
    } on MissingPluginException {
      // Widget tests and unsupported hosts use the dark default.
    }
  }

  Future<void> _changeTheme(ThemeMode mode) async {
    setState(() => _themeMode = mode);
    try {
      await _preferences.invokeMethod<void>('writeTheme', {'theme': mode.name});
    } on PlatformException {
      // The current session still uses the selected appearance.
    } on MissingPluginException {
      // Test hosts have no Android preferences plugin.
    }
  }

  @override
  Widget build(BuildContext context) => MaterialApp(
    builder: (context, child) => TrophyLanguageHost(child: child!),
    title: 'Platinum Companion',
    debugShowCheckedModeBanner: false,
    theme: companionTheme(Brightness.light),
    darkTheme: companionTheme(Brightness.dark),
    themeMode: _themeMode,
    locale: const Locale('ru'),
    supportedLocales: const [Locale('ru'), Locale('en')],
    localizationsDelegates: const [
      GlobalMaterialLocalizations.delegate,
      GlobalWidgetsLocalizations.delegate,
      GlobalCupertinoLocalizations.delegate,
    ],
    home: _Home(
      updates: widget.updates,
      repository: widget.repository,
      cloud: widget.cloud,
      themeMode: _themeMode,
      onThemeChanged: _changeTheme,
    ),
  );
}

class _Home extends StatefulWidget {
  const _Home({
    required this.repository,
    this.cloud,
    this.updates,
    required this.themeMode,
    required this.onThemeChanged,
  });
  final TrophyRepository repository;
  final CloudController? cloud;
  final UpdateController? updates;
  final ThemeMode themeMode;
  final ValueChanged<ThemeMode> onThemeChanged;

  @override
  State<_Home> createState() => _HomeState();
}

class _HomeState extends State<_Home> with WidgetsBindingObserver {
  int _page = 0;
  bool _updateDialog = false;
  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    widget.updates?.addListener(_notice);
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted) widget.updates?.check();
    });
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state == AppLifecycleState.resumed) widget.updates?.check();
  }

  Future<void> _notice() async {
    final updates = widget.updates;
    if (!mounted ||
        _updateDialog ||
        updates == null ||
        !updates.showNotice ||
        updates.release == null) {
      return;
    }
    _updateDialog = true;
    final approved = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        title: Text('Обновление ${updates.release!['versionName']}'),
        content: SingleChildScrollView(
          child: Text((updates.release!['changelog'] as List).join('\n\n')),
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(context, false),
            child: const Text('Позже'),
          ),
          FilledButton(
            onPressed: () => Navigator.pop(context, true),
            child: const Text('Обновить'),
          ),
        ],
      ),
    );
    await updates.later();
    if (approved == true) await updates.open();
    _updateDialog = false;
  }

  @override
  void dispose() {
    widget.updates?.removeListener(_notice);
    WidgetsBinding.instance.removeObserver(this);
    super.dispose();
  }

  Future<void> _import() async {
    final approved = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        title: const Text('Импорт личного прогресса'),
        content: const Text(
          'Выберите JSON-снимок из Platinum Companion. Игры и трофеи сохранятся только на этом устройстве. '
          'Токены и пароль PSN не нужны.\n\n'
          'Более свежие сведения обновят библиотеку. Старые записи не заменят новые, а остальные игры сохранятся.',
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(context, false),
            child: const Text('Отмена'),
          ),
          FilledButton(
            onPressed: () => Navigator.pop(context, true),
            child: const Text('Выбрать файл'),
          ),
        ],
      ),
    );
    if (approved != true || !mounted) return;
    final result = await widget.repository.importFromPicker();
    if (!mounted) return;
    final error = widget.repository.error;
    if (error != null) {
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text(error), duration: const Duration(seconds: 6)),
      );
    } else if (result != null) {
      final message = result.changed
          ? 'Готово: добавлено ${result.added}, обновлено ${result.updated}. Библиотека доступна офлайн.'
          : 'Этот прогресс уже сохранён. Дата синхронизации не изменилась.';
      ScaffoldMessenger.of(context)
          .showSnackBar(SnackBar(content: Text(message)));
    }
  }

  @override
  Widget build(BuildContext context) => AnimatedBuilder(
    animation: widget.repository,
    builder: (context, _) {
      final repository = widget.repository;
      return Scaffold(
        body: SafeArea(
          bottom: false,
          child: Center(
            child: ConstrainedBox(
              constraints: const BoxConstraints(maxWidth: 900),
              child: Stack(
                children: [
                  IndexedStack(
                    index: _page,
                    children: [
                      LibraryPage(
                        repository: repository,
                        onImport: _import,
                        cloud: widget.cloud,
                      ),
                      SettingsPage(
                        updates: widget.updates,
                        cloud: widget.cloud,
                        repository: repository,
                        onImport: _import,
                        themeMode: widget.themeMode,
                        onThemeChanged: widget.onThemeChanged,
                      ),
                    ],
                  ),
                  if (repository.isBusy)
                    const Positioned(
                      top: 0,
                      left: 0,
                      right: 0,
                      child: LinearProgressIndicator(),
                    ),
                ],
              ),
            ),
          ),
        ),
        bottomNavigationBar: NavigationBar(
          selectedIndex: _page,
          onDestinationSelected: (value) => setState(() => _page = value),
          destinations: const [
            NavigationDestination(
              icon: Icon(Icons.grid_view_rounded),
              selectedIcon: Icon(Icons.grid_view_rounded),
              label: 'Библиотека',
            ),
            NavigationDestination(
              icon: Icon(Icons.tune_rounded),
              selectedIcon: Icon(Icons.tune_rounded),
              label: 'Настройки',
            ),
          ],
        ),
      );
    },
  );
}
