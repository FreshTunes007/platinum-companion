import 'official_image.dart';

import 'package:flutter/material.dart';

import '../data/data.dart';
import 'game_page.dart';
import 'theme.dart';
import 'widgets.dart';
import '../data/cloud_controller.dart';
import 'cloud_panel.dart';
import '../data/library_entry.dart';

enum _LibrarySort { title, progress, remaining, observed }

class LibraryPage extends StatefulWidget {
  const LibraryPage({
    super.key,
    this.cloud,
    required this.repository,
    required this.onImport,
  });
  final TrophyRepository repository;
  final CloudController? cloud;
  final VoidCallback onImport;

  @override
  State<LibraryPage> createState() => _LibraryPageState();
}

class _LibraryPageState extends State<LibraryPage> {
  final _search = TextEditingController();
  _LibrarySort _sort = _LibrarySort.title;
  String? _platform;
  bool _activeOnly = false;

  @override
  void dispose() {
    _search.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => AnimatedBuilder(
    animation: widget.cloud ?? widget.repository,
    builder: (context, _) => _build(context),
  );
  Future<void> _open(LibraryEntry entry) async {
    final game = await widget.cloud!.loadGame(entry);
    if (!mounted) return;
    if (game == null) {
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(
          content: Text(
            widget.cloud!.error ?? 'Каталог ещё не загружен. Подробности доступны после первого открытия с интернетом.',
          ),
        ),
      );
      return;
    }
    Navigator.of(context).push(
      MaterialPageRoute<void>(
        builder: (_) => GamePage(game: game, cloud: widget.cloud),
      ),
    );
  }

  Widget _build(BuildContext context) {
    final repository = widget.repository;
    if (repository.isLoading) {
      return const Center(child: CircularProgressIndicator());
    }
    final entries = widget.cloud?.library ?? <LibraryEntry>[];
    final available = entries.isEmpty
        ? repository.games
        : entries.map((e) => e.preview).toList();
    if (available.isEmpty) {
      return _Welcome(
        onImport: widget.onImport,
        busy: repository.isBusy,
        error: repository.error,
      );
    }
    final query = _search.text.trim().toLowerCase();
    final games = available
        .where(
          (game) =>
              game.title.toLowerCase().contains(query) &&
              (_platform == null || game.platform == _platform) &&
              (!_activeOnly || entries.any((e) => e.id == game.id && e.active)),
        )
        .toList();
    games.sort(
      (a, b) => switch (_sort) {
        _LibrarySort.title => a.title.toLowerCase().compareTo(
          b.title.toLowerCase(),
        ),
        _LibrarySort.progress => b.summary.progress.compareTo(
          a.summary.progress,
        ),
        _LibrarySort.remaining => a.summary.remaining.compareTo(
          b.summary.remaining,
        ),
        _LibrarySort.observed => b.observedAt.compareTo(a.observedAt),
      },
    );
    final earned = available.fold(
      0,
      (value, game) => value + game.summary.earned,
    );
    final total = available.fold(
      0,
      (value, game) => value + game.summary.total,
    );
    final platinum = available.fold(
      0,
      (value, game) => value + game.summary.platinumEarned,
    );
    return CustomScrollView(
      key: const PageStorageKey('library-scroll'),
      slivers: [
        if (widget.cloud != null)
          SliverPadding(
            padding: const EdgeInsets.fromLTRB(22, 12, 22, 0),
            sliver: SliverToBoxAdapter(
              child: CloudPanel(cloud: widget.cloud!, compact: true),
            ),
          ),
        SliverPadding(
          padding: const EdgeInsets.fromLTRB(22, 22, 22, 0),
          sliver: SliverToBoxAdapter(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Row(
                  children: [
                    Container(
                      padding: const EdgeInsets.all(9),
                      decoration: BoxDecoration(
                        color: Theme.of(context).colorScheme.primary
                            .withValues(alpha: .14),
                        borderRadius: BorderRadius.circular(13),
                      ),
                      child: Icon(
                        Icons.workspace_premium_outlined,
                        size: 22,
                        color: Theme.of(context).colorScheme.primary,
                      ),
                    ),
                    const SizedBox(width: 10),
                    Expanded(
                      child: Text(
                        'PLATINUM\nCOMPANION',
                        style: Theme.of(context).textTheme.labelMedium
                            ?.copyWith(
                              letterSpacing: 2,
                              fontWeight: FontWeight.w800,
                              height: 1.25,
                            ),
                      ),
                    ),
                    IconButton(
                      onPressed: repository.isBusy ? null : widget.onImport,
                      tooltip: 'Импортировать новый снимок',
                      icon: const Icon(Icons.file_download_outlined),
                    ),
                  ],
                ),
                const SizedBox(height: 28),
                Text(
                  'Твой путь\nк платине.',
                  style: Theme.of(context).textTheme.headlineLarge
                      ?.copyWith(height: 1.08),
                ),
                const SizedBox(height: 12),
                Text(
                  'Вся коллекция. Каждый трофей.',
                  style: Theme.of(context).textTheme.bodyMedium?.copyWith(
                    color: Theme.of(context).colorScheme.onSurfaceVariant,
                  ),
                ),
                const SizedBox(height: 22),
                _LibraryOverview(
                  games: available.length,
                  earned: earned,
                  total: total,
                  platinum: platinum,
                ),
                const SizedBox(height: 18),
                Row(
                  children: [
                    const SourcePill(
                      label: 'На устройстве',
                      icon: Icons.offline_pin_outlined,
                    ),
                    const SizedBox(width: 10),
                    Expanded(
                      child: Text(
                        'Даты снимков — у каждой игры',
                        style: Theme.of(context).textTheme.labelSmall?.copyWith(
                          color: Theme.of(context).colorScheme.onSurfaceVariant,
                        ),
                      ),
                    ),
                  ],
                ),
                const SizedBox(height: 28),
                if (widget.cloud?.initialImport != null) ...[
                  Text(
                    'Первоначальный импорт: ${widget.cloud!.initialImport!['complete']} / ${widget.cloud!.initialImport!['discovered']} наборов · ${widget.cloud!.initialImport!['status'] == 'complete' ? 'завершён' : 'в процессе'}',
                  ),
                  const SizedBox(height: 12),
                ],
                if (entries.any((e) => e.active)) ...[
                  const SectionTitle('Активные прохождения'),
                  const SizedBox(height: 8),
                  SizedBox(
                    height: 172,
                    child: ListView.separated(
                      scrollDirection: Axis.horizontal,
                      itemCount: entries.where((e) => e.active).length,
                      separatorBuilder: (_, index) => const SizedBox(width: 12),
                      itemBuilder: (context, index) {
                        final e = entries
                            .where((e) => e.active)
                            .elementAt(index);
                        return SizedBox(
                          width: 234,
                          child: Card(
                            child: InkWell(
                              onTap: () => _open(e),
                              borderRadius: BorderRadius.circular(20),
                              child: Padding(
                                padding: const EdgeInsets.all(12),
                                child: Row(
                                  children: [
                                    OfficialGameArtwork(
                                      game: e.preview,
                                      width: 82,
                                      height: 120,
                                    ),
                                    const SizedBox(width: 12),
                                    Expanded(
                                      child: Column(
                                        mainAxisAlignment:
                                            MainAxisAlignment.center,
                                        crossAxisAlignment:
                                            CrossAxisAlignment.start,
                                        children: [
                                          Text(
                                            e.platform,
                                            style: Theme.of(context)
                                                .textTheme
                                                .labelSmall,
                                          ),
                                          const SizedBox(height: 8),
                                          Text(
                                            e.title,
                                            maxLines: 3,
                                            overflow: TextOverflow.ellipsis,
                                            style: Theme.of(context)
                                                .textTheme
                                                .titleSmall,
                                          ),
                                          const SizedBox(height: 8),
                                          LinearProgressIndicator(
                                            value: e.preview.summary.progress,
                                          ),
                                          const SizedBox(height: 6),
                                          Text(
                                            '${e.preview.summary.earned}/${e.preview.summary.total}',
                                            style: Theme.of(context)
                                                .textTheme
                                                .labelSmall,
                                          ),
                                        ],
                                      ),
                                    ),
                                  ],
                                ),
                              ),
                            ),
                          ),
                        );
                      },
                    ),
                  ),
                  const SizedBox(height: 20),
                ],
                SectionTitle(
                  'Игры',
                  trailing: PopupMenuButton<_LibrarySort>(
                    tooltip: 'Сортировка игр',
                    initialValue: _sort,
                    onSelected: (value) => setState(() => _sort = value),
                    itemBuilder: (_) => const [
                      PopupMenuItem(
                        value: _LibrarySort.title,
                        child: Text('По названию'),
                      ),
                      PopupMenuItem(
                        value: _LibrarySort.progress,
                        child: Text('По прогрессу'),
                      ),
                      PopupMenuItem(
                        value: _LibrarySort.remaining,
                        child: Text('Ближе к завершению'),
                      ),
                      PopupMenuItem(
                        value: _LibrarySort.observed,
                        child: Text('Свежие снимки первыми'),
                      ),
                    ],
                    icon: const Icon(Icons.sort_rounded),
                  ),
                ),
                const SizedBox(height: 12),
                TextField(
                  key: const Key('library-search'),
                  controller: _search,
                  onChanged: (_) => setState(() {}),
                  decoration: InputDecoration(
                    hintText: 'Найти игру',
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
                Wrap(
                  spacing: 8,
                  children: [
                    FilterChip(
                      label: const Text('Все'),
                      selected: _platform == null,
                      onSelected: (_) => setState(() => _platform = null),
                    ),
                    for (final platform in ['PS4', 'PS5'])
                      FilterChip(
                        label: Text(platform),
                        selected: _platform == platform,
                        onSelected: (_) => setState(() => _platform = platform),
                      ),
                    FilterChip(
                      label: const Text('Активные'),
                      selected: _activeOnly,
                      onSelected: (v) => setState(() => _activeOnly = v),
                    ),
                  ],
                ),
                const SizedBox(height: 18),
              ],
            ),
          ),
        ),
        if (games.isEmpty)
          const SliverToBoxAdapter(
            child: EmptyResults(
              message: 'Такой игры пока нет в библиотеке.\nПопробуйте другое название.',
            ),
          ),
        SliverPadding(
          padding: const EdgeInsets.fromLTRB(22, 0, 22, 28),
          sliver: SliverList.separated(
            itemCount: games.length,
            separatorBuilder: (_, index) => const SizedBox(height: 14),
            itemBuilder: (context, index) {
              final game = games[index];
              LibraryEntry? entry;
              for (final e in entries) {
                if (e.id == game.id) {
                  entry = e;
                  break;
                }
              }
              final selected = entry;
              return _GameCard(
                game: game,
                onOpen: selected == null ? null : () => _open(selected),
                active: selected?.active,
                complete: selected?.complete ?? true,
                onToggle: selected == null
                    ? null
                    : () => widget.cloud!.setActive(selected, !selected.active),
              );
            },
          ),
        ),
      ],
    );
  }
}

class _LibraryOverview extends StatelessWidget {
  const _LibraryOverview({
    required this.games,
    required this.earned,
    required this.total,
    required this.platinum,
  });
  final int games;
  final int earned;
  final int total;
  final int platinum;

  @override
  Widget build(BuildContext context) => Container(
    padding: const EdgeInsets.all(20),
    decoration: BoxDecoration(
      gradient: LinearGradient(
        colors: Theme.of(context).brightness == Brightness.dark
            ? const [Color(0xFF1B3155), Color(0xFF142235)]
            : const [Color(0xFFE2EBFF), Color(0xFFE4F4F1)],
      ),
      borderRadius: BorderRadius.circular(24),
      border: Border.all(color: platinumBlue.withValues(alpha: .16)),
    ),
    child: Column(
      children: [
        Row(
          children: [
            Expanded(
              child: _Stat(label: 'Наборов', value: '$games'),
            ),
            Expanded(
              flex: 2,
              child: _Stat(
                label: 'Трофеев получено',
                value: '$earned / $total',
              ),
            ),
            Expanded(
              child: _Stat(label: 'Платин', value: '$platinum'),
            ),
          ],
        ),
        const SizedBox(height: 18),
        ProgressBar(earned: earned, total: total),
      ],
    ),
  );
}

class _Stat extends StatelessWidget {
  const _Stat({required this.label, required this.value});
  final String label;
  final String value;

  @override
  Widget build(BuildContext context) => Column(
    crossAxisAlignment: CrossAxisAlignment.start,
    children: [
      Text(
        value,
        style: Theme.of(context).textTheme.titleLarge?.copyWith(fontSize: 22),
      ),
      const SizedBox(height: 5),
      Text(
        label,
        style: Theme.of(context).textTheme.labelSmall
            ?.copyWith(color: Theme.of(context).colorScheme.onSurfaceVariant),
      ),
    ],
  );
}

class _GameCard extends StatelessWidget {
  const _GameCard({
    required this.game,
    this.onOpen,
    this.onToggle,
    this.active,
    this.complete = true,
  });
  final VoidCallback? onOpen, onToggle;
  final bool? active;
  final bool complete;
  final GameRecord game;

  @override
  Widget build(BuildContext context) {
    final summary = game.summary;
    final platinumUnknown = game.trophies.any(
      (trophy) => trophy.grade == TrophyGrade.platinum && trophy.isUnknown,
    );
    final scheme = Theme.of(context).colorScheme;
    return Card(
      clipBehavior: Clip.antiAlias,
      child: InkWell(
        key: ValueKey('game-${game.id}'),
        onTap:
            onOpen ??
            () => Navigator.of(context).push(
              MaterialPageRoute<void>(builder: (_) => GamePage(game: game)),
            ),
        child: Padding(
          padding: const EdgeInsets.all(14),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Row(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Hero(
                    tag: 'art-${game.id}',
                    child: OfficialGameArtwork(
                      game: game,
                      width: 78,
                      height: 104,
                      radius: 15,
                    ),
                  ),
                  const SizedBox(width: 14),
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        const SizedBox(height: 3),
                        Text(
                          game.platform,
                          style: Theme.of(context).textTheme.labelSmall
                              ?.copyWith(
                                color: scheme.primary,
                                fontWeight: FontWeight.w700,
                                letterSpacing: 1,
                              ),
                        ),
                        const SizedBox(height: 7),
                        Text(
                          game.title,
                          style: Theme.of(context).textTheme.titleMedium,
                          maxLines: 3,
                          overflow: TextOverflow.ellipsis,
                        ),
                        const SizedBox(height: 10),
                        Row(
                          children: [
                            Icon(
                              summary.platinumComplete
                                  ? Icons.workspace_premium_rounded
                                  : Icons.workspace_premium_outlined,
                              size: 15,
                              color: summary.platinumComplete
                                  ? platinumCyan
                                  : scheme.onSurfaceVariant,
                            ),
                            const SizedBox(width: 5),
                            Expanded(
                              child: Text(
                                !summary.hasPlatinum
                                    ? 'Без платинового трофея'
                                    : summary.platinumComplete
                                    ? 'Платина получена'
                                    : platinumUnknown
                                    ? 'Статус платины неизвестен'
                                    : 'Платина впереди',
                                style: Theme.of(context).textTheme.labelSmall
                                    ?.copyWith(color: scheme.onSurfaceVariant),
                              ),
                            ),
                          ],
                        ),
                      ],
                    ),
                  ),
                  if (onToggle != null)
                    IconButton(
                      tooltip: active == true
                          ? 'Снять активное прохождение'
                          : 'Активное прохождение',
                      icon: Icon(
                        active == true ? Icons.star : Icons.star_border,
                      ),
                      onPressed: onToggle,
                    ),
                  Icon(
                    Icons.chevron_right_rounded,
                    color: scheme.onSurfaceVariant,
                    size: 20,
                  ),
                ],
              ),
              const SizedBox(height: 16),
              Row(
                children: [
                  Text(
                    '${summary.earned} / ${summary.total}',
                    style: Theme.of(context).textTheme.labelLarge
                        ?.copyWith(fontWeight: FontWeight.w700),
                  ),
                  const Spacer(),
                  Flexible(
                    child: Text(
                      summary.unknown > 0
                          ? 'Не получены ${summary.unearned}'
                          : 'Осталось ${summary.remaining}',
                      style: Theme.of(context).textTheme.labelSmall
                          ?.copyWith(color: scheme.onSurfaceVariant),
                    ),
                  ),
                ],
              ),
              const SizedBox(height: 9),
              ProgressBar(earned: summary.earned, total: summary.total),
              const SizedBox(height: 12),
              Text(
                complete
                    ? '${sourceLabel(game.source)} · ${displayDate(game.observedAt)}'
                    : 'Индекс Sony · Каталог ещё загружается',
                style: Theme.of(context).textTheme.labelSmall
                    ?.copyWith(color: scheme.onSurfaceVariant),
              ),
              if (summary.unknown > 0)
                Padding(
                  padding: const EdgeInsets.only(top: 4),
                  child: Text(
                    'У ${summary.unknown} трофеев статус неизвестен',
                    style: Theme.of(context).textTheme.labelSmall,
                  ),
                ),
            ],
          ),
        ),
      ),
    );
  }
}

class _Welcome extends StatelessWidget {
  const _Welcome({required this.onImport, required this.busy, this.error});
  final VoidCallback onImport;
  final bool busy;
  final String? error;

  @override
  Widget build(BuildContext context) => LayoutBuilder(
    builder: (context, size) => SingleChildScrollView(
      child: ConstrainedBox(
        constraints: BoxConstraints(minHeight: size.maxHeight),
        child: Padding(
          padding: const EdgeInsets.all(28),
          child: Column(
            mainAxisAlignment: MainAxisAlignment.center,
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              const GameArtwork(
                seed: 'platinum-companion-welcome',
                height: 190,
                width: double.infinity,
                large: true,
                radius: 32,
              ),
              const SizedBox(height: 36),
              Text(
                'Каждая платина\nначинается здесь.',
                style: Theme.of(context).textTheme.headlineLarge
                    ?.copyWith(height: 1.12),
              ),
              const SizedBox(height: 16),
              Text(
                'Добавьте свой снимок трофеев и держите всю коллекцию под рукой — даже без интернета.',
                style: Theme.of(context).textTheme.bodyLarge?.copyWith(
                  color: Theme.of(context).colorScheme.onSurfaceVariant,
                  height: 1.5,
                ),
              ),
              const SizedBox(height: 26),
              SizedBox(
                width: double.infinity,
                child: FilledButton.icon(
                  key: const Key('empty-import'),
                  onPressed: busy ? null : onImport,
                  icon: const Icon(Icons.file_download_outlined),
                  label: const Text('Импортировать снимок'),
                ),
              ),
              const SizedBox(height: 16),
              const Text(
                'Личные данные хранятся на устройстве.\nПароль и токены PlayStation не нужны.',
                style: TextStyle(fontSize: 12, height: 1.5),
              ),
              if (error != null)
                Padding(
                  padding: const EdgeInsets.only(top: 20),
                  child: InfoCard(
                    title: 'Не удалось загрузить данные',
                    body: error!,
                    icon: Icons.error_outline_rounded,
                  ),
                ),
            ],
          ),
        ),
      ),
    ),
  );
}
