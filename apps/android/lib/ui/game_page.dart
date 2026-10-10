import 'official_image.dart';
import '../data/cloud_controller.dart';
import 'journey_page.dart';
import 'companion_page.dart';

import 'package:flutter/material.dart';

import '../data/data.dart';
import 'theme.dart';
import 'trophy_page.dart';
import 'widgets.dart';
import 'trophy_language.dart';

enum _TrophyFilter { all, unearned, earned, unknown }

enum _TrophySort { original, earnedAt, name, grade }

class GamePage extends StatefulWidget {
  const GamePage({super.key, required this.game, this.cloud});
  final GameRecord game;
  final CloudController? cloud;

  @override
  State<GamePage> createState() => _GamePageState();
}

class _GamePageState extends State<GamePage> {
  final _search = TextEditingController();
  final _revealed = <String>{};
  _TrophyFilter _filter = _TrophyFilter.all;
  _TrophySort _sort = _TrophySort.original;
  TrophyGrade? _grade;
  String? _groupId;

  @override
  void dispose() {
    _search.dispose();
    super.dispose();
  }

  bool _hidden(TrophyRecord trophy) =>
      trophy.hidden && !trophy.isEarned && !_revealed.contains(trophy.id);

  @override
  Widget build(BuildContext context) {
    final game = widget.game;
    final entries = widget.cloud?.library.where((e) => e.id == game.id);
    final journeyEntry = entries != null && entries.isNotEmpty
        ? entries.first
        : null;
    final summary = game.summary;
    final platinumUnknown = game.trophies.any(
      (trophy) => trophy.grade == TrophyGrade.platinum && trophy.isUnknown,
    );
    final scheme = Theme.of(context).colorScheme;
    final query = _search.text.trim().toLowerCase();
    final trophies = game.trophies.where((trophy) {
      if (_filter == _TrophyFilter.earned && !trophy.isEarned) return false;
      if (_filter == _TrophyFilter.unearned && !trophy.isUnearned) return false;
      if (_filter == _TrophyFilter.unknown && !trophy.isUnknown) return false;
      if (_grade != null && trophy.grade != _grade) return false;
      if (_groupId != null && trophy.groupId != _groupId) return false;
      if (query.isNotEmpty) {
        final searchable = _hidden(trophy)
            ? 'скрытый трофей'
            : '${trophy.displayName(TrophyLanguage.useRussian(context))} ${trophy.displayDescription(TrophyLanguage.useRussian(context)) ?? ''}';
        if (!searchable.toLowerCase().contains(query)) return false;
      }
      return true;
    }).toList();
    trophies.sort(
      (a, b) => switch (_sort) {
        _TrophySort.original => (a.sonyTrophyId ?? 2147483647).compareTo(
          b.sonyTrophyId ?? 2147483647,
        ),
        _TrophySort.name =>
          (_hidden(a)
                  ? 'Скрытый трофей'
                  : a.displayName(TrophyLanguage.useRussian(context)))
              .toLowerCase()
              .compareTo(
                (_hidden(b)
                        ? 'Скрытый трофей'
                        : b.displayName(TrophyLanguage.useRussian(context)))
                    .toLowerCase(),
              ),
        _TrophySort.grade => b.grade.index.compareTo(a.grade.index),
        _TrophySort.earnedAt =>
          (b.earnedAt?.millisecondsSinceEpoch ?? -1).compareTo(
            a.earnedAt?.millisecondsSinceEpoch ?? -1,
          ),
      },
    );
    return Scaffold(
      appBar: AppBar(title: const Text('Об игре')),
      body: Center(
        child: ConstrainedBox(
          constraints: const BoxConstraints(maxWidth: 900),
          child: CustomScrollView(
            slivers: [
              SliverPadding(
                padding: const EdgeInsets.fromLTRB(22, 10, 22, 0),
                sliver: SliverToBoxAdapter(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Hero(
                        tag: 'art-${game.id}',
                        child: OfficialGameArtwork(
                          game: game,
                          height: 174,
                          width: double.infinity,
                          radius: 26,
                          large: true,
                        ),
                      ),
                      const SizedBox(height: 10),
                      Text(
                        game.artwork?.hero != null
                            ? 'Арт игры · каталог PlayStation'
                            : game.artwork?.cover != null
                            ? 'Обложка · каталог PlayStation'
                            : game.artwork?.gameIcon != null
                            ? 'Иконка игры · PlayStation'
                            : 'Иконка трофейного набора · PlayStation',
                        style: Theme.of(context).textTheme.labelSmall,
                      ),
                      const SizedBox(height: 16),
                      Row(
                        children: [
                          SourcePill(
                            label: game.platform,
                            icon: Icons.sports_esports_outlined,
                          ),
                          const SizedBox(width: 8),
                          const SourcePill(
                            label: 'Офлайн',
                            icon: Icons.offline_pin_outlined,
                          ),
                        ],
                      ),
                      const SizedBox(height: 12),
                      Text(
                        game.title,
                        style: Theme.of(context).textTheme.headlineMedium,
                      ),
                      const SizedBox(height: 22),
                      if (journeyEntry?.active == true) ...[
                        SizedBox(
                          width: double.infinity,
                          child: FilledButton.icon(
                            key: const Key('open-journey'),
                            icon: const Icon(Icons.route_outlined),
                            label: const Text('Продолжить путь к платине'),
                            onPressed: () => Navigator.of(context).push(
                              MaterialPageRoute<void>(
                                builder: (_) => JourneyPage(
                                  gameId: journeyEntry!.gameId,
                                  repository: widget.cloud!.journeys,
                                ),
                              ),
                            ),
                          ),
                        ),
                        const SizedBox(height: 8),
                        Row(
                          children: [
                            Expanded(
                              child: OutlinedButton.icon(
                                key: const Key('open-companion'),
                                icon: const Icon(Icons.chat_bubble_outline),
                                label: const Text('Спросить компаньона'),
                                onPressed: () => Navigator.of(context).push(
                                  MaterialPageRoute<void>(
                                    builder: (_) => CompanionPage(
                                      gameId: journeyEntry!.gameId,
                                      repository: widget.cloud!.companions,
                                    ),
                                  ),
                                ),
                              ),
                            ),
                            const SizedBox(width: 8),
                            Expanded(
                              child: OutlinedButton.icon(
                                key: const Key('update-journey-chat'),
                                icon: const Icon(Icons.edit_note),
                                label: const Text('Обновить прохождение'),
                                onPressed: () => Navigator.of(context).push(
                                  MaterialPageRoute<void>(
                                    builder: (_) => CompanionPage(
                                      gameId: journeyEntry!.gameId,
                                      repository: widget.cloud!.companions,
                                      updateMode: true,
                                    ),
                                  ),
                                ),
                              ),
                            ),
                          ],
                        ),
                        const SizedBox(height: 16),
                      ],
                      Card(
                        child: Padding(
                          padding: const EdgeInsets.all(20),
                          child: Column(
                            crossAxisAlignment: CrossAxisAlignment.start,
                            children: [
                              Row(
                                crossAxisAlignment: CrossAxisAlignment.end,
                                children: [
                                  Expanded(
                                    child: Text(
                                      '${summary.earned} / ${summary.total}',
                                      style: Theme.of(context)
                                          .textTheme
                                          .headlineMedium,
                                    ),
                                  ),
                                  Text(
                                    '${(summary.progress * 100).round()}%',
                                    style: Theme.of(context)
                                        .textTheme
                                        .titleLarge
                                        ?.copyWith(color: scheme.primary),
                                  ),
                                ],
                              ),
                              const SizedBox(height: 4),
                              Text(
                                summary.unknown > 0
                                    ? 'трофеев получено · не получены ${summary.unearned} · статус неизвестен ${summary.unknown}'
                                    : 'трофеев получено · осталось ${summary.remaining}',
                                style: Theme.of(context).textTheme.bodySmall
                                    ?.copyWith(color: scheme.onSurfaceVariant),
                              ),
                              const SizedBox(height: 16),
                              ProgressBar(
                                earned: summary.earned,
                                total: summary.total,
                              ),
                              const SizedBox(height: 18),
                              Row(
                                children: [
                                  const TrophyBadge(
                                    grade: 'platinum',
                                    size: 38,
                                  ),
                                  const SizedBox(width: 12),
                                  Expanded(
                                    child: Column(
                                      crossAxisAlignment:
                                          CrossAxisAlignment.start,
                                      children: [
                                        Text(
                                          !summary.hasPlatinum
                                              ? 'Платинового трофея нет'
                                              : summary.platinumComplete
                                              ? 'Платина получена'
                                              : platinumUnknown
                                              ? 'Статус платины неизвестен'
                                              : 'Платина ещё не получена',
                                          style: Theme.of(context)
                                              .textTheme
                                              .titleSmall,
                                        ),
                                        if (summary.hasPlatinum)
                                          Text(
                                            '${summary.platinumEarned} / ${summary.platinumTotal} платиновых трофеев',
                                            style: Theme.of(context)
                                                .textTheme
                                                .bodySmall
                                                ?.copyWith(
                                                  color:
                                                      scheme.onSurfaceVariant,
                                                ),
                                          ),
                                      ],
                                    ),
                                  ),
                                ],
                              ),
                              if (summary.unknown > 0)
                                Padding(
                                  padding: const EdgeInsets.only(top: 12),
                                  child: Text(
                                    '${summary.unknown} трофеев: статус неизвестен. Они не отмечены как неполученные.',
                                    style: Theme.of(context)
                                        .textTheme
                                        .bodySmall,
                                  ),
                                ),
                            ],
                          ),
                        ),
                      ),
                      const SizedBox(height: 16),
                      Text(
                        '${sourceLabel(game.source)}\nНаблюдение: ${displayDate(game.observedAt)}',
                        style: Theme.of(context).textTheme.bodySmall
                            ?.copyWith(color: scheme.onSurfaceVariant),
                      ),
                      const SizedBox(height: 4),
                      Text(
                        'Дата относится к источнику, а не к открытию приложения.',
                        style: Theme.of(context).textTheme.labelSmall
                            ?.copyWith(color: scheme.onSurfaceVariant),
                      ),
                      const SizedBox(height: 24),
                      Wrap(
                        spacing: 8,
                        runSpacing: 8,
                        children: TrophyGrade.values.reversed
                            .map(
                              (grade) => FilterChip(
                                avatar: Icon(
                                  grade == TrophyGrade.platinum
                                      ? Icons.workspace_premium_outlined
                                      : Icons.emoji_events_outlined,
                                  color: gradeColor(grade.name),
                                  size: 18,
                                ),
                                label: Text(
                                  '${gradeLabel(grade.name)} ${game.gradeEarned(grade)}/${game.gradeTotal(grade)}',
                                ),
                                selected: _grade == grade,
                                onSelected: (_) => setState(
                                  () => _grade = _grade == grade ? null : grade,
                                ),
                              ),
                            )
                            .toList(),
                      ),
                      const SizedBox(height: 28),
                      SectionTitle(
                        'Трофеи',
                        trailing: PopupMenuButton<_TrophySort>(
                          tooltip: 'Сортировка трофеев',
                          initialValue: _sort,
                          onSelected: (value) => setState(() => _sort = value),
                          itemBuilder: (_) => const [
                            PopupMenuItem(
                              value: _TrophySort.original,
                              child: Text('Порядок источника'),
                            ),
                            PopupMenuItem(
                              value: _TrophySort.earnedAt,
                              child: Text('Недавно полученные'),
                            ),
                            PopupMenuItem(
                              value: _TrophySort.name,
                              child: Text('По названию'),
                            ),
                            PopupMenuItem(
                              value: _TrophySort.grade,
                              child: Text('По типу'),
                            ),
                          ],
                          icon: const Icon(Icons.sort_rounded),
                        ),
                      ),
                      const SizedBox(height: 12),
                      TextField(
                        key: const Key('trophy-search'),
                        controller: _search,
                        onChanged: (_) => setState(() {}),
                        decoration: InputDecoration(
                          hintText: 'Найти трофей',
                          prefixIcon: const Icon(Icons.search_rounded),
                          suffixIcon: _search.text.isEmpty
                              ? null
                              : IconButton(
                                  tooltip: 'Очистить поиск',
                                  onPressed: () => setState(_search.clear),
                                  icon: const Icon(Icons.close_rounded),
                                ),
                        ),
                      ),
                      const SizedBox(height: 12),
                      SingleChildScrollView(
                        key: const Key('trophy-status-filters'),
                        scrollDirection: Axis.horizontal,
                        child: Row(
                          children: [
                            _filterChip(
                              'Все · ${summary.total}',
                              _TrophyFilter.all,
                            ),
                            const SizedBox(width: 8),
                            _filterChip(
                              'Не получены · ${summary.unearned}',
                              _TrophyFilter.unearned,
                            ),
                            const SizedBox(width: 8),
                            _filterChip(
                              'Получены · ${summary.earned}',
                              _TrophyFilter.earned,
                            ),
                            if (summary.unknown > 0) ...[
                              const SizedBox(width: 8),
                              _filterChip(
                                'Неизвестно · ${summary.unknown}',
                                _TrophyFilter.unknown,
                              ),
                            ],
                          ],
                        ),
                      ),
                      if (game.groups.length > 1)
                        Padding(
                          padding: const EdgeInsets.only(top: 10),
                          child: DropdownButtonFormField<String>(
                            key: const Key('group-filter'),
                            initialValue: _groupId ?? '',
                            isExpanded: true,
                            decoration: const InputDecoration(
                              labelText: 'Группа трофеев',
                            ),
                            items: [
                              const DropdownMenuItem(
                                value: '',
                                child: Text('Все группы и дополнения'),
                              ),
                              ...game.groups.map(
                                (group) => DropdownMenuItem(
                                  value: group.id,
                                  child: Text(
                                    groupLabel(group, game.groups),
                                    overflow: TextOverflow.ellipsis,
                                  ),
                                ),
                              ),
                            ],
                            onChanged: (value) => setState(
                              () => _groupId = value == '' ? null : value,
                            ),
                          ),
                        ),
                      const SizedBox(height: 14),
                      Text(
                        'Показано: ${trophies.length}',
                        style: Theme.of(context).textTheme.labelMedium
                            ?.copyWith(color: scheme.onSurfaceVariant),
                      ),
                      const SizedBox(height: 12),
                    ],
                  ),
                ),
              ),
              if (trophies.isEmpty)
                const SliverToBoxAdapter(
                  child: EmptyResults(
                    message: 'По этим фильтрам трофеев нет.\nПопробуйте изменить условия.',
                  ),
                ),
              SliverPadding(
                padding: const EdgeInsets.fromLTRB(22, 0, 22, 20),
                sliver: SliverList.separated(
                  itemCount: trophies.length,
                  separatorBuilder: (_, index) => const SizedBox(height: 10),
                  itemBuilder: (context, index) {
                    final trophy = trophies[index];
                    return TrophyListCard(
                      trophy: trophy,
                      group: game.groupById(trophy.groupId),
                      groups: game.groups,
                      concealed: _hidden(trophy),
                      onTap: () => Navigator.of(context).push(
                        MaterialPageRoute<void>(
                          builder: (_) => TrophyPage(
                            game: game,
                            trophy: trophy,
                            revealed: !_hidden(trophy),
                            onReveal: () =>
                                setState(() => _revealed.add(trophy.id)),
                          ),
                        ),
                      ),
                    );
                  },
                ),
              ),
              SliverPadding(
                padding: const EdgeInsets.fromLTRB(22, 0, 22, 30),
                sliver: SliverToBoxAdapter(
                  child: Card(
                    child: ExpansionTile(
                      title: const Text('О данных игры'),
                      tilePadding: const EdgeInsets.symmetric(horizontal: 18),
                      childrenPadding: const EdgeInsets.fromLTRB(18, 0, 18, 12),
                      expandedCrossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        DetailRow('Источник', game.source, selectable: true),
                        DetailRow(
                          'Набор Sony',
                          game.sony.npCommunicationId,
                          selectable: true,
                        ),
                        DetailRow(
                          'Сервис Sony',
                          game.sony.service,
                          selectable: true,
                        ),
                        DetailRow(
                          'Дата наблюдения, UTC',
                          game.observedAt.toUtc().toIso8601String(),
                          selectable: true,
                        ),
                        const DetailRow(
                          'Изображение',
                          'Абстрактная иллюстрация приложения. Официальная обложка не предоставлена.',
                        ),
                      ],
                    ),
                  ),
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }

  Widget _filterChip(String label, _TrophyFilter filter) => ChoiceChip(
    key: ValueKey('filter-${filter.name}'),
    label: Text(label),
    selected: _filter == filter,
    onSelected: (_) => setState(() => _filter = filter),
  );
}

String groupLabel(TrophyGroup? group, List<TrophyGroup> groups) {
  if (group == null) return 'Группа не указана';
  final name = group.name?.trim();
  if (name != null && name.isNotEmpty) {
    return group.kind == TrophyGroupKind.dlc ? 'DLC · $name' : name;
  }
  if (group.kind == TrophyGroupKind.base) return 'Основная игра';
  if (group.kind == TrophyGroupKind.additional) {
    return 'Группа (название не указано)';
  }
  final position = groups
      .where((candidate) => candidate.kind == TrophyGroupKind.dlc)
      .toList()
      .indexWhere((candidate) => candidate.id == group.id);
  return position < 0
      ? 'Дополнение (название не указано)'
      : 'Дополнение ${position + 1} (название не указано)';
}

class TrophyListCard extends StatelessWidget {
  const TrophyListCard({
    super.key,
    required this.trophy,
    required this.group,
    required this.groups,
    required this.concealed,
    required this.onTap,
  });
  final TrophyRecord trophy;
  final TrophyGroup? group;
  final List<TrophyGroup> groups;
  final bool concealed;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return Card(
      clipBehavior: Clip.antiAlias,
      child: InkWell(
        key: ValueKey('trophy-${trophy.id}'),
        onTap: onTap,
        child: Padding(
          padding: const EdgeInsets.all(15),
          child: Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              OfficialTrophyIcon(trophy: trophy, concealed: concealed),
              const SizedBox(width: 13),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      concealed
                          ? 'Скрытый трофей'
                          : trophy.displayName(
                              TrophyLanguage.useRussian(context),
                            ),
                      style: Theme.of(context).textTheme.titleSmall
                          ?.copyWith(fontWeight: FontWeight.w700),
                    ),
                    const SizedBox(height: 5),
                    if (concealed)
                      Text(
                        'Откройте, чтобы раскрыть сведения',
                        style: Theme.of(context).textTheme.bodySmall
                            ?.copyWith(color: scheme.onSurfaceVariant),
                      )
                    else if (trophy.displayDescription(
                              TrophyLanguage.useRussian(context),
                            ) !=
                            null &&
                        trophy
                            .displayDescription(
                              TrophyLanguage.useRussian(context),
                            )!
                            .isNotEmpty)
                      Text(
                        trophy.displayDescription(
                          TrophyLanguage.useRussian(context),
                        )!,
                        maxLines: 2,
                        overflow: TextOverflow.ellipsis,
                        style: Theme.of(context).textTheme.bodySmall
                            ?.copyWith(color: scheme.onSurfaceVariant),
                      ),
                    const SizedBox(height: 8),
                    Text(
                      trophy.isEarned
                          ? 'Получен${trophy.earnedAt == null ? ' · дата неизвестна' : ' · ${displayDate(trophy.earnedAt, withTime: false)}'}'
                          : trophy.isUnearned
                          ? 'Не получен'
                          : 'Статус неизвестен',
                      style: Theme.of(context).textTheme.labelSmall?.copyWith(
                        color: trophy.isEarned
                            ? (Theme.of(context).brightness == Brightness.dark
                                  ? platinumCyan
                                  : const Color(0xFF197C6F))
                            : scheme.onSurfaceVariant,
                      ),
                    ),
                    if (group?.kind == TrophyGroupKind.dlc)
                      Padding(
                        padding: const EdgeInsets.only(top: 4),
                        child: Text(
                          groupLabel(group, groups),
                          style: Theme.of(context).textTheme.labelSmall
                              ?.copyWith(color: scheme.onSurfaceVariant),
                        ),
                      ),
                  ],
                ),
              ),
              const SizedBox(width: 6),
              Icon(
                trophy.isEarned
                    ? Icons.check_circle_rounded
                    : concealed
                    ? Icons.lock_outline_rounded
                    : Icons.chevron_right_rounded,
                size: 18,
                color: trophy.isEarned
                    ? (Theme.of(context).brightness == Brightness.dark
                          ? platinumCyan
                          : const Color(0xFF197C6F))
                    : scheme.onSurfaceVariant,
              ),
            ],
          ),
        ),
      ),
    );
  }
}
