import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

class TrophyLanguage extends InheritedWidget {
  const TrophyLanguage({
    super.key,
    required this.russian,
    required this.onChanged,
    required super.child,
  });
  final bool russian;
  final ValueChanged<bool> onChanged;
  static TrophyLanguage? of(BuildContext context) =>
      context.dependOnInheritedWidgetOfExactType<TrophyLanguage>();
  static bool useRussian(BuildContext context) => of(context)?.russian ?? true;
  @override
  bool updateShouldNotify(TrophyLanguage oldWidget) =>
      russian != oldWidget.russian;
}

class TrophyLanguageHost extends StatefulWidget {
  const TrophyLanguageHost({super.key, required this.child});
  final Widget child;
  @override
  State<TrophyLanguageHost> createState() => _TrophyLanguageHostState();
}

class _TrophyLanguageHostState extends State<TrophyLanguageHost> {
  static const channel = MethodChannel('platinum_companion/preferences');
  bool russian = true;
  @override
  void initState() {
    super.initState();
    read();
  }

  Future<void> read() async {
    try {
      final language = await channel.invokeMethod<String>('readTrophyLanguage');
      if (mounted) setState(() => russian = language != 'original');
    } on PlatformException {
      /* Default Russian; catalogue fallback is per field. */
    } on MissingPluginException {
      /* Tests use the default. */
    }
  }

  Future<void> change(bool value) async {
    setState(() => russian = value);
    try {
      await channel.invokeMethod<void>('writeTrophyLanguage', {
        'language': value ? 'ru' : 'original',
      });
    } on PlatformException {
      /* Session preference still applies. */
    } on MissingPluginException {
      /* No native storage in widget tests. */
    }
  }

  @override
  Widget build(BuildContext context) =>
      TrophyLanguage(russian: russian, onChanged: change, child: widget.child);
}
