import 'package:flutter/material.dart';

import '../data/data.dart';
import 'widgets.dart';
import 'trophy_language.dart';
import '../data/cloud_controller.dart';
import 'cloud_panel.dart';
import '../data/update_controller.dart';
import 'update_panel.dart';

class SettingsPage extends StatelessWidget {
  const SettingsPage({
    super.key,
    this.cloud,
    this.updates,
    required this.repository,
    required this.onImport,
    required this.themeMode,
    required this.onThemeChanged,
  });
  final TrophyRepository repository;
  final CloudController? cloud;
  final UpdateController? updates;
  final VoidCallback onImport;
  final ThemeMode themeMode;
  final ValueChanged<ThemeMode> onThemeChanged;

  Future<void> _clear(BuildContext context) async {
    final approved = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        title: const Text('Удалить локальную библиотеку?'),
        content: const Text(
          'Игры и трофеи будут удалены из приложения. Исходный JSON и данные PlayStation сохранятся. Чтобы вернуть библиотеку, импортируйте снимок снова.',
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(context, false),
            child: const Text('Отмена'),
          ),
          FilledButton(
            onPressed: () => Navigator.pop(context, true),
            child: const Text('Удалить'),
          ),
        ],
      ),
    );
    if (approved != true) return;
    final success = await repository.clear();
    if (!context.mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(
        content: Text(
          success
              ? 'Локальная библиотека удалена.'
              : repository.error ?? 'Не удалось удалить данные.',
        ),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final snapshot = repository.snapshot;
    final sources = repository.games
        .map((game) => sourceLabel(game.source))
        .toSet()
        .join(', ');
    return ListView(
      key: const PageStorageKey('settings-scroll'),
      padding: const EdgeInsets.fromLTRB(22, 28, 22, 30),
      children: [
        if (cloud?.library.isNotEmpty == true)
          InfoCard(
            title: 'Изображения PlayStation',
            body:
                'Обложки: ${cloud!.library.where((e) => e.artwork?.cover != null).length}/${cloud!.library.length} · Иконки наборов: ${cloud!.library.where((e) => e.artwork?.titleIcon != null).length}/${cloud!.library.length}\nИзображения загружаются по мере просмотра и сохраняются на устройстве. Кэш — до 96 МБ. При отсутствии обложки показывается официальная иконка.',
            icon: Icons.image_outlined,
          ),
        const SizedBox(height: 16),
        Text('Настройки', style: Theme.of(context).textTheme.headlineMedium),
        const SizedBox(height: 10),
        Text(
          'Твоя библиотека, на твоём устройстве.',
          style: Theme.of(context).textTheme.bodyMedium
              ?.copyWith(color: Theme.of(context).colorScheme.onSurfaceVariant),
        ),
        const SizedBox(height: 26),
        if (cloud != null)
          CloudPanel(cloud: cloud!)
        else
          const InfoCard(
            title: 'Офлайн-режим',
            body: 'Приложение читает сохранённые снимки. Облачное подключение пока не настроено. Открытие приложения не запускает синхронизацию PSN.',
            icon: Icons.offline_pin_outlined,
          ),
        const SizedBox(height: 16),
        Card(
          child: Padding(
            padding: const EdgeInsets.all(20),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                Text(
                  'Источник данных',
                  style: Theme.of(context).textTheme.titleMedium,
                ),
                const SizedBox(height: 14),
                const Text('Безопасный JSON-снимок Platinum Companion'),
                if (snapshot != null) ...[
                  DetailRow('Источник снимка', sources),
                  DetailRow(
                    'Последнее наблюдение источника',
                    displayDate(snapshot.latestObservation),
                  ),
                  if (snapshot.oldestObservation != snapshot.latestObservation)
                    DetailRow(
                      'Самый ранний снимок в библиотеке',
                      displayDate(snapshot.oldestObservation),
                    ),
                  DetailRow(
                    'Импорт на устройство',
                    displayDate(repository.importedAt),
                  ),
                ] else
                  const Padding(
                    padding: EdgeInsets.symmetric(vertical: 14),
                    child: Text('Библиотека пока пуста.'),
                  ),
                const SizedBox(height: 12),
                FilledButton.icon(
                  key: const Key('settings-import'),
                  onPressed: repository.isBusy ? null : onImport,
                  icon: const Icon(Icons.file_download_outlined),
                  label: Text(
                    snapshot == null
                        ? 'Импортировать снимок'
                        : 'Импортировать новый снимок',
                  ),
                ),
                const SizedBox(height: 12),
                Text(
                  'Импорт доступен и без облака. Повторный импорт не меняет дату наблюдения PSN.',
                  style: Theme.of(context).textTheme.bodySmall?.copyWith(
                    color: Theme.of(context).colorScheme.onSurfaceVariant,
                  ),
                ),
              ],
            ),
          ),
        ),
        const SizedBox(height: 26),
        const SectionTitle('Оформление'),
        const SizedBox(height: 14),
        Card(
          child: Padding(
            padding: const EdgeInsets.all(18),
            child: DropdownButtonFormField<ThemeMode>(
              key: ValueKey('theme-${themeMode.name}'),
              initialValue: themeMode,
              isExpanded: true,
              decoration: const InputDecoration(labelText: 'Тема'),
              items: const [
                DropdownMenuItem(value: ThemeMode.dark, child: Text('Тёмная')),
                DropdownMenuItem(
                  value: ThemeMode.light,
                  child: Text('Светлая'),
                ),
                DropdownMenuItem(
                  value: ThemeMode.system,
                  child: Text('Как на устройстве'),
                ),
              ],
              onChanged: (value) {
                if (value != null) onThemeChanged(value);
              },
            ),
          ),
        ),
        const SizedBox(height: 26),
        Card(
          child: Padding(
            padding: const EdgeInsets.all(18),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                const Text('Язык трофеев'),
                const SizedBox(height: 12),
                SegmentedButton<bool>(
                  segments: const [
                    ButtonSegment(value: true, label: Text('Русский')),
                    ButtonSegment(value: false, label: Text('Оригинал')),
                  ],
                  selected: {TrophyLanguage.useRussian(context)},
                  onSelectionChanged: (values) =>
                      TrophyLanguage.of(context)?.onChanged(values.first),
                ),
                const SizedBox(height: 10),
                const Text(
                  'Официальный текст Sony. Если русского варианта нет, показываем оригинал. Работает офлайн.',
                ),
              ],
            ),
          ),
        ),
        const SizedBox(height: 26),
        const SectionTitle('О приложении'),
        if (updates != null) UpdatePanel(updates: updates!),
        const SizedBox(height: 14),
        const InfoCard(
          title: 'Platinum Companion · 0.3.4',
          body:
              'Личный спутник по трофеям PlayStation. Библиотека, достижения и прогресс без подключения к сети.\n\n'
              'APK не содержит личной библиотеки, Sony-токенов или привязки к аккаунту. '
              'После установки каждый игрок импортирует свой снимок.\n\n'
              'Даты показываются по времени устройства. Иллюстрации игр созданы внутри приложения.',
          icon: Icons.workspace_premium_outlined,
        ),
        const SizedBox(height: 16),
        if (snapshot != null)
          OutlinedButton.icon(
            key: const Key('clear-library'),
            onPressed: repository.isBusy ? null : () => _clear(context),
            icon: const Icon(Icons.delete_outline_rounded),
            label: const Text('Удалить локальную библиотеку'),
          ),
      ],
    );
  }
}
