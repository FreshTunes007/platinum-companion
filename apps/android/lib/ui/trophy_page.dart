import 'official_image.dart';

import 'package:flutter/material.dart';

import '../data/data.dart';
import 'game_page.dart' show groupLabel;
import 'theme.dart';
import 'widgets.dart';
import 'trophy_language.dart';

class TrophyPage extends StatefulWidget {
  const TrophyPage({
    super.key,
    required this.game,
    required this.trophy,
    required this.revealed,
    required this.onReveal,
  });
  final GameRecord game;
  final TrophyRecord trophy;
  final bool revealed;
  final VoidCallback onReveal;

  @override
  State<TrophyPage> createState() => _TrophyPageState();
}

class _TrophyPageState extends State<TrophyPage> {
  late bool _revealed = widget.revealed;

  @override
  Widget build(BuildContext context) {
    final trophy = widget.trophy;
    final game = widget.game;
    final scheme = Theme.of(context).colorScheme;
    final concealed = trophy.hidden && !trophy.isEarned && !_revealed;
    final description = trophy.displayDescription(
      TrophyLanguage.useRussian(context),
    );
    return Scaffold(
      appBar: AppBar(title: const Text('Трофей')),
      body: Center(
        child: ConstrainedBox(
          constraints: const BoxConstraints(maxWidth: 720),
          child: ListView(
            padding: const EdgeInsets.fromLTRB(24, 24, 24, 36),
            children: [
              Center(
                child: OfficialTrophyIcon(
                  trophy: trophy,
                  size: 110,
                  concealed: concealed,
                ),
              ),
              const SizedBox(height: 24),
              Text(
                gradeLabel(trophy.grade.name),
                textAlign: TextAlign.center,
                style: Theme.of(context).textTheme.labelLarge?.copyWith(
                  color: gradeColor(trophy.grade.name),
                  letterSpacing: 1,
                ),
              ),
              const SizedBox(height: 10),
              AnimatedSwitcher(
                duration: const Duration(milliseconds: 180),
                child: Text(
                  concealed
                      ? 'Скрытый трофей'
                      : trophy.displayName(TrophyLanguage.useRussian(context)),
                  key: ValueKey(concealed),
                  textAlign: TextAlign.center,
                  style: Theme.of(context).textTheme.headlineMedium,
                ),
              ),
              const SizedBox(height: 20),
              Center(
                child: SourcePill(
                  label: trophy.isEarned
                      ? 'Получен'
                      : trophy.isUnearned
                      ? 'Не получен'
                      : 'Статус неизвестен',
                  icon: trophy.isEarned
                      ? Icons.check_circle_outline_rounded
                      : trophy.isUnearned
                      ? Icons.radio_button_unchecked_rounded
                      : Icons.help_outline_rounded,
                ),
              ),
              const SizedBox(height: 30),
              if (concealed)
                InfoCard(
                  title: 'Сведения скрыты',
                  body: 'Название и условие могут раскрывать детали игры. Откройте их, когда будете готовы.',
                  icon: Icons.visibility_off_outlined,
                  trailing: FilledButton.tonalIcon(
                    key: const Key('reveal-trophy'),
                    onPressed: () {
                      setState(() => _revealed = true);
                      widget.onReveal();
                    },
                    icon: const Icon(Icons.visibility_outlined),
                    label: const Text('Раскрыть трофей'),
                  ),
                )
              else
                Card(
                  child: Padding(
                    padding: const EdgeInsets.all(22),
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(
                          'Условие получения',
                          style: Theme.of(context).textTheme.titleMedium,
                        ),
                        const SizedBox(height: 12),
                        Text(
                          description == null || description.isEmpty
                              ? 'Описание отсутствует в снимке. Условие не подтверждено.'
                              : description,
                          style: Theme.of(context).textTheme.bodyLarge
                              ?.copyWith(height: 1.5),
                        ),
                        if (trophy.hidden)
                          Padding(
                            padding: const EdgeInsets.only(top: 14),
                            child: Row(
                              children: [
                                Icon(
                                  Icons.visibility_outlined,
                                  size: 16,
                                  color: scheme.onSurfaceVariant,
                                ),
                                const SizedBox(width: 7),
                                Text(
                                  'Скрытый трофей · раскрыт',
                                  style: Theme.of(context).textTheme.labelSmall
                                      ?.copyWith(
                                        color: scheme.onSurfaceVariant,
                                      ),
                                ),
                              ],
                            ),
                          ),
                      ],
                    ),
                  ),
                ),
              const SizedBox(height: 18),
              Card(
                child: Padding(
                  padding: const EdgeInsets.symmetric(
                    horizontal: 20,
                    vertical: 10,
                  ),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      DetailRow('Игра', game.title),
                      DetailRow('Платформа', game.platform),
                      DetailRow(
                        'Группа',
                        groupLabel(game.groupById(trophy.groupId), game.groups),
                      ),
                      if (trophy.isEarned)
                        DetailRow('Получен', displayDate(trophy.earnedAt)),
                      const Divider(),
                      DetailRow('Источник', sourceLabel(game.source)),
                      const DetailRow('Условие', 'Официальное описание PSN'),
                      DetailRow(
                        'Язык текста',
                        TrophyLanguage.useRussian(context) &&
                                trophy.official?.russianDescription != null
                            ? 'Русский · Sony'
                            : 'Оригинал Sony',
                      ),
                      DetailRow(
                        'Дата наблюдения',
                        displayDate(game.observedAt),
                      ),
                    ],
                  ),
                ),
              ),
              const SizedBox(height: 18),
              Card(
                child: ExpansionTile(
                  title: const Text('Идентификаторы Sony'),
                  tilePadding: const EdgeInsets.symmetric(horizontal: 20),
                  childrenPadding: const EdgeInsets.fromLTRB(20, 0, 20, 14),
                  expandedCrossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    DetailRow(
                      'Набор трофеев',
                      game.sony.npCommunicationId,
                      selectable: true,
                    ),
                    DetailRow(
                      'ID трофея',
                      trophy.sonyTrophyId?.toString() ?? 'Источник не передал',
                      selectable: true,
                    ),
                    DetailRow('Группа', trophy.groupId, selectable: true),
                    if (trophy.earnedAt != null)
                      DetailRow(
                        'Получен, UTC',
                        trophy.earnedAt!.toUtc().toIso8601String(),
                        selectable: true,
                      ),
                  ],
                ),
              ),
              const SizedBox(height: 20),
              Row(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  const Icon(
                    Icons.offline_pin_outlined,
                    size: 18,
                    color: platinumBlue,
                  ),
                  const SizedBox(width: 10),
                  Expanded(
                    child: Text(
                      'Показан сохранённый снимок. Обновить прогресс можно импортом нового файла в настройках.',
                      style: Theme.of(context).textTheme.bodySmall
                          ?.copyWith(color: scheme.onSurfaceVariant),
                    ),
                  ),
                ],
              ),
            ],
          ),
        ),
      ),
    );
  }
}
