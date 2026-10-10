import 'package:flutter/material.dart';

import '../data/journey_repository.dart';
import 'widgets.dart';

const _labels = {
  'yes': 'Да',
  'no': 'Нет',
  'NG': 'Первое прохождение',
  'NG+': 'Новая игра +',
  'base_platinum': 'Платина основной игры',
  '100_percent': '100% с дополнениями',
  'dlc_only': 'Дополнения',
  'minimal': 'Минимум спойлеров',
  'full': 'Все подробности',
  'new': 'Новое',
  'existing': 'Уже начатое',
  'before_start': 'До начала',
  'before_griffin': 'Перед грифоном',
  'vizima_audience': 'Вызима · аудиенция',
  'first_visit_crow_perch': 'Первый визит во Вроницы',
  'keira_chain': 'Цепочка Кейры',
  'keira_final_choice': 'Решение в цепочке Кейры',
  'outside_pack_scope': 'Дальше раннего Велена',
  'not_started': 'Не начато',
  'active': 'В процессе',
  'in_progress': 'В процессе',
  'completed': 'Выполнено',
  'failed': 'Провалено',
  'pending': 'Решение впереди',
  'kaer_morhen': 'Каэр Морхен',
  'other': 'Другой исход',
  'Vizima': 'Вызима',
  'travel_to_velen': 'Отправиться в Велен',
};
String journeyLabel(dynamic value) => value is List
    ? value.map(journeyLabel).join(', ')
    : value == true
    ? 'Да'
    : value == false
    ? 'Нет'
    : _labels['$value'] ?? '$value';

class JourneyPage extends StatefulWidget {
  const JourneyPage({
    super.key,
    required this.gameId,
    required this.repository,
  });
  final String gameId;
  final JourneyRepository repository;
  @override
  State<JourneyPage> createState() => _JourneyPageState();
}

class _JourneyPageState extends State<JourneyPage> {
  Map<String, dynamic>? data;
  bool busy = true, reveal = false;
  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    setState(() => busy = true);
    final d = await widget.repository.load(widget.gameId, reveal: reveal);
    if (mounted) {
      setState(() {
        data = d;
        busy = false;
      });
    }
  }

  Future<void> _confirm(Map<String, dynamic> command) async {
    setState(() => busy = true);
    final d = await widget.repository.confirm(
      widget.gameId,
      command,
      reveal: reveal,
    );
    if (mounted) {
      setState(() {
        data = d;
        busy = false;
      });
    }
  }

  Future<void> _edit(String field, Map definition) async {
    dynamic answer;
    if (definition['values'] is List) {
      answer = await showDialog<dynamic>(
        context: context,
        builder: (c) => SimpleDialog(
          title: Text('${definition['label']}'),
          children: [
            for (final v in definition['values'])
              SimpleDialogOption(
                onPressed: () => Navigator.pop(c, {'value': v}),
                child: Text(journeyLabel(v)),
              ),
          ],
        ),
      );
    } else {
      final number = definition['type'] == 'number';
      final collection = definition['type'] == 'array';
      final current = data?['currentRunFacts']?[field]?['value'];
      final text = TextEditingController(
        text: current is List ? current.join('\n') : current?.toString() ?? '',
      );
      final route = DialogRoute<dynamic>(
        context: context,
        builder: (c) => AlertDialog(
          title: Text('${definition['label']}'),
          content: TextField(
            controller: text,
            maxLength: collection ? 4000 : 300,
            maxLines: collection ? 5 : 1,
            autofocus: true,
            keyboardType: number
                ? TextInputType.number
                : TextInputType.multiline,
            decoration: InputDecoration(
              helperText: number
                  ? 'Подтверждённое количество: ${definition['min']}–${definition['max']}'
                  : collection
                  ? 'По одному названию на строку. Это явная замена списка.'
                  : null,
            ),
          ),
          actions: [
            TextButton(
              onPressed: () => Navigator.pop(c),
              child: const Text('Отмена'),
            ),
            FilledButton(
              onPressed: () {
                final value = text.text.trim();
                if (number) {
                  final n = int.tryParse(value);
                  if (n != null &&
                      n >= definition['min'] &&
                      n <= definition['max']) {
                    Navigator.pop(c, {'value': n});
                  }
                } else if (collection) {
                  Navigator.pop(c, {
                    'value': value
                        .split('\n')
                        .map((v) => v.trim())
                        .where((v) => v.isNotEmpty)
                        .toSet()
                        .toList(),
                  });
                } else if (value.isNotEmpty) {
                  Navigator.pop(c, {'value': value});
                }
              },
              child: const Text('Подтвердить'),
            ),
          ],
        ),
      );
      answer = await Navigator.of(context).push(route);
      await route.completed;
      text.dispose();
    }
    if (answer != null) {
      await _confirm({
        'type': 'fact',
        'field': field,
        'value': answer['value'],
      });
    }
  }

  Widget _card(Widget child) => Card(
    child: Padding(padding: const EdgeInsets.all(18), child: child),
  );
  Future<void> _progress(Map action) async {
    final p = action['progress'] as Map;
    final counter = p['counter'];
    if (counter is Map) {
      await _edit(counter['field'], {
        'type': 'number',
        'label': '${action['title']} · изучено типов',
        'min': counter['min'],
        'max': counter['max'],
      });
    } else {
      await _edit(p['field'], {
        'label': 'Состояние: ${action['title']}',
        'values': ['not_started', 'in_progress', 'completed'],
      });
    }
  }

  Widget _action(Map a) {
    final category = a['category'];
    final label =
        {
          'MUST': '🔴 MUST · Обязательно',
          'RECOMMENDED': '🟡 RECOMMENDED · Рекомендуется',
          'OPTIONAL': '⚪ OPTIONAL · По желанию',
          'UPDATE_NEEDED': '🔄 UPDATE NEEDED · Нужно уточнение',
          'TIP': '💡 TIP · Совет',
        }[category] ??
        '$category';
    return _card(
      Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(label, style: Theme.of(context).textTheme.labelLarge),
          const SizedBox(height: 8),
          Text(
            '${a['title'] ?? ''}',
            style: Theme.of(context).textTheme.titleMedium,
          ),
          const SizedBox(height: 8),
          Text('${a['message'] ?? ''}'),
          if (a['whyNow'] != null) ...[
            const SizedBox(height: 8),
            Text(
              'Почему сейчас: ${a['whyNow']}',
              style: Theme.of(context).textTheme.bodySmall,
            ),
          ],
          if (a['category'] != 'MUST' &&
              a['progress'] is Map &&
              data?['run'] != null) ...[
            const SizedBox(height: 8),
            Text('Ваш прогресс: ${journeyLabel(a['progress']['status'])}'),
            if (a['progress']['counter'] is Map)
              Text(
                '${a['progress']['counter']['value'] ?? 'Не указано'} / ${a['progress']['counter']['target']} ${a['progress']['counter']['unit']}',
              ),
            if (a['progress']['legacyUnknownCount'] == true)
              const Text(
                'Старая отметка выполнения; количество ещё не подтверждено.',
              ),
            TextButton(
              key: Key('action-progress-${a['id']}'),
              onPressed: busy || widget.repository.pending(widget.gameId)
                  ? null
                  : () => _progress(a),
              child: Text(
                a['progress']['counter'] is Map
                    ? 'Указать изученное количество'
                    : 'Изменить прогресс действия',
              ),
            ),
          ],
          ExpansionTile(
            tilePadding: EdgeInsets.zero,
            title: const Text('Основание и достоверность'),
            children: [
              SelectableText(
                '${a['source'] == 'PSN_VERIFIED' ? 'Условие Sony' : 'Игровой источник'} · ${a['certainty'] == 'VERSION_UNCERTAIN'
                    ? 'Версия требует проверки'
                    : a['certainty'] == 'SUPPORTED'
                    ? 'Поддержано источником'
                    : a['certainty'] ?? 'Проверить применимость'}\n${(a['evidence'] as List? ?? []).map((e) => e['url'] ?? e['sourceId']).join('\n')}',
              ),
              if (a['missable'] != null)
                Text(
                  a['missable'] == 'UNKNOWN'
                      ? 'Пропускаемость не проверена'
                      : a['missable'] == 'not_missable'
                      ? 'Источник не относит условие к пропускаемым; учитывайте статус проверки версии.'
                      : 'Есть ограничение прохождения; смотрите основание и статус проверки.',
                ),
            ],
          ),
        ],
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final d = data, repo = widget.repository;
    final fields = d?['fields'] as Map? ?? {};
    final facts = d?['currentRunFacts'] as Map? ?? {};
    return Scaffold(
      appBar: AppBar(
        title: const Text('Путь к платине'),
        actions: [
          IconButton(
            onPressed: busy ? null : _load,
            icon: const Icon(Icons.refresh),
            tooltip: 'Проверить контекст сервера',
          ),
        ],
      ),
      body: busy && d == null
          ? const Center(child: CircularProgressIndicator())
          : ListView(
              padding: const EdgeInsets.all(20),
              children: [
                if (busy) const LinearProgressIndicator(),
                if (repo.error != null) _card(Text(repo.error!)),
                if (d == null)
                  const Text(
                    'Путь ещё не сохранён на телефоне. Откройте его с подключением к серверу.',
                  ),
                if (d != null) ...[
                  Text(
                    '${d['title']}',
                    style: Theme.of(context).textTheme.headlineSmall,
                  ),
                  const SizedBox(height: 8),
                  Text(
                    '${repo.offline ? 'Сохранённый контекст · офлайн' : 'Контекст сервера'} · версия ${d['revision']}',
                  ),
                  _card(
                    Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(
                          '${d['trophySummary']?['earned'] ?? 0} / ${d['trophySummary']?['total'] ?? 0} трофеев',
                          style: Theme.of(context).textTheme.headlineSmall,
                        ),
                        Text(
                          'Осталось: ${d['remainingCount']} · источник ${d['trophySource']}',
                        ),
                        Text(
                          'Наблюдение PSN: ${d['lastSuccessfulSyncAt'] ?? 'неизвестно'}',
                          style: Theme.of(context).textTheme.bodySmall,
                        ),
                        const SizedBox(height: 10),
                        Text(
                          'Правила с подтверждённым трофеем: ${d['progress']?['providerConfirmed']} / ${d['progress']?['total']}',
                        ),
                        const Text(
                          'Это покрытие маршрута, а не процент прохождения игры.',
                        ),
                      ],
                    ),
                  ),
                  if (d['run'] == null)
                    _card(
                      Column(
                        children: [
                          const Text(
                            'Профиль доступен. Игровое прохождение ещё не подтверждено — трофеи не определяют текущее сохранение.',
                          ),
                          FilledButton(
                            onPressed: busy
                                ? null
                                : () => _confirm({'type': 'start'}),
                            child: const Text('Начать вести это прохождение'),
                          ),
                        ],
                      ),
                    ),
                  SwitchListTile(
                    contentPadding: EdgeInsets.zero,
                    title: const Text('Показать сюжетные подробности'),
                    value: reveal,
                    onChanged: busy
                        ? null
                        : (v) {
                            setState(() {
                              reveal = v;
                              data = null;
                            });
                            _load();
                          },
                  ),
                  if (repo.pending(widget.gameId))
                    FilledButton(
                      onPressed: busy ? null : () => _confirm({}),
                      child: const Text('Проверить отправку'),
                    ),
                  const SectionTitle('Ближайшие действия'),
                  if ((d['confirmedActions'] as List? ?? []).isNotEmpty)
                    ExpansionTile(
                      title: const Text('Действия, отмеченные вами'),
                      children: [
                        const Text(
                          'Это ваши подтверждения действий, а не подтверждение трофеев Sony.',
                        ),
                        for (final a in d['confirmedActions'] as List)
                          _action(a as Map),
                      ],
                    ),
                  for (final a in d['actions'] as List) _action(a as Map),
                  if ((d['actions'] as List).isEmpty)
                    const Text(
                      'Нет подтверждённых ближайших действий в текущем покрытии.',
                    ),
                  if ((d['updateRequests'] as List).isNotEmpty) ...[
                    const SectionTitle('Нужно уточнение'),
                    for (final u in d['updateRequests'] as List)
                      _card(
                        Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            Text('🔄 ${u['message']}'),
                            Text(
                              '${u['whyNow']}',
                              style: Theme.of(context).textTheme.bodySmall,
                            ),
                            if (u['field'] != null &&
                                fields[u['field']] != null &&
                                d['run'] != null)
                              TextButton(
                                onPressed: busy || repo.pending(widget.gameId)
                                    ? null
                                    : () =>
                                          _edit(u['field'], fields[u['field']]),
                                child: const Text('Указать факт'),
                              ),
                          ],
                        ),
                      ),
                  ],
                  for (final tip in d['coach'] as List)
                    _action({
                      ...tip,
                      'title': 'Контекстный совет',
                      'category': 'TIP',
                      'source': 'INFERRED',
                      'certainty': 'Совет, не условие платины',
                    }),
                  if ((d['criticalUnknowns'] as List).isNotEmpty)
                    _card(
                      Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          const Text('Ограничения и риски'),
                          for (final u in d['criticalUnknowns'] as List)
                            Text('• ${u['message'] ?? 'Требуется уточнение'}'),
                          if (d['coverage']?['limitation'] != null)
                            Text('${d['coverage']['limitation']}'),
                          const Text(
                            'Непроверенные условия не считаются безопасными для отсрочки.',
                          ),
                        ],
                      ),
                    ),
                  if (d['run'] != null) ...[
                    const SectionTitle('Моё прохождение'),
                    for (final entry in facts.entries)
                      ListTile(
                        contentPadding: EdgeInsets.zero,
                        title: Text(
                          '${fields[entry.key]?['label'] ?? entry.key}',
                        ),
                        subtitle: Text(
                          '${entry.value['reportedAnswer'] ?? journeyLabel(entry.value['value'])}\nПодтверждено игроком · ${entry.value['observedAt']}',
                        ),
                        trailing: fields[entry.key] == null
                            ? null
                            : IconButton(
                                tooltip: 'Исправить факт',
                                icon: const Icon(Icons.edit_outlined),
                                onPressed: busy || repo.pending(widget.gameId)
                                    ? null
                                    : () => _edit(entry.key, fields[entry.key]),
                              ),
                      ),
                    OutlinedButton.icon(
                      onPressed: busy || repo.pending(widget.gameId)
                          ? null
                          : () async {
                              final field = await showModalBottomSheet<String>(
                                context: context,
                                isScrollControlled: true,
                                builder: (c) => SafeArea(
                                  child: SizedBox(
                                    height: 500,
                                    child: ListView(
                                      children: [
                                        for (final e in fields.entries)
                                          ListTile(
                                            title: Text('${e.value['label']}'),
                                            onTap: () =>
                                                Navigator.pop(c, e.key),
                                          ),
                                      ],
                                    ),
                                  ),
                                ),
                              );
                              if (field != null) {
                                await _edit(field, fields[field]);
                              }
                            },
                      icon: const Icon(Icons.add),
                      label: const Text('Подтвердить игровой факт'),
                    ),
                  ],
                  ExpansionTile(
                    title: Text('Уже получено · ${d['completedTotal']}'),
                    children: [
                      for (final t in d['completed'] as List)
                        ListTile(
                          leading: const Icon(Icons.check_circle_outline),
                          title: Text('${t['name']}'),
                          subtitle: Text(
                            '${t['source']} · ${t['earnedAt'] ?? 'дата неизвестна'}',
                          ),
                        ),
                      if ((d['completedTotal'] as int) >
                          (d['completed'] as List).length)
                        const Text('Полный список — на экране игры.'),
                    ],
                  ),
                  ExpansionTile(
                    title: const Text('История подтверждений'),
                    children: [
                      for (final e in d['history'] as List)
                        ListTile(
                          title: Text(
                            e['type'] == 'retract'
                                ? 'Отменено ошибочное событие'
                                : e['type'] == 'start'
                                ? 'Начато ведение прохождения'
                                : '${fields[e['field']]?['label'] ?? e['field']} · ${e['wording'] ?? journeyLabel(e['value'])}',
                          ),
                          subtitle: Text(
                            '${e['observedAt']} · версия ${e['revision']} ${e['retracted'] == true ? '· отменено' : ''}',
                          ),
                          trailing:
                              e['type'] == 'fact' && e['retracted'] != true
                              ? IconButton(
                                  tooltip: 'Отменить ошибочное подтверждение',
                                  icon: const Icon(Icons.undo),
                                  onPressed: busy || repo.pending(widget.gameId)
                                      ? null
                                      : () async {
                                          final yes = await showDialog<bool>(
                                            context: context,
                                            builder: (c) => AlertDialog(
                                              title: const Text(
                                                'Отменить ошибочное подтверждение?',
                                              ),
                                              content: const Text(
                                                'Предыдущее значение восстановится. Запись останется в истории.',
                                              ),
                                              actions: [
                                                TextButton(
                                                  onPressed: () =>
                                                      Navigator.pop(c, false),
                                                  child: const Text('Назад'),
                                                ),
                                                TextButton(
                                                  onPressed: () =>
                                                      Navigator.pop(c, true),
                                                  child: const Text(
                                                    'Отменить событие',
                                                  ),
                                                ),
                                              ],
                                            ),
                                          );
                                          if (yes == true) {
                                            await _confirm({
                                              'type': 'retract',
                                              'targetId': e['id'],
                                              if (e['batch'] == true)
                                                'field': e['field'],
                                            });
                                          }
                                        },
                                )
                              : null,
                        ),
                    ],
                  ),
                  const SizedBox(height: 30),
                ],
              ],
            ),
    );
  }
}
