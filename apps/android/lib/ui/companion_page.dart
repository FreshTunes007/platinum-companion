import 'package:flutter/material.dart';

import '../data/companion_repository.dart';
import 'journey_page.dart';
import 'chatgpt_plan_page.dart';

class CompanionPage extends StatefulWidget {
  const CompanionPage({
    super.key,
    required this.gameId,
    required this.repository,
    this.updateMode = false,
  });
  final String gameId;
  final CompanionRepository repository;
  final bool updateMode;
  @override
  State<CompanionPage> createState() => _CompanionPageState();
}

class _CompanionPageState extends State<CompanionPage> {
  final _message = TextEditingController();
  final _selected = <String>{};
  final _edited = <String, dynamic>{};
  final _manualItems = <Map<String, dynamic>>[];
  List<CompanionImage> _images = [];
  Map<String, dynamic>? data;
  bool busy = true, reveal = false, updateMode = false;
  String? localNotice;
  CompanionRepository get repo => widget.repository;
  bool get pending => repo.pending(widget.gameId);
  Map get fields => data?['fields'] as Map? ?? {};
  Map get provider => data?['provider'] as Map? ?? {};
  bool get externalReady =>
      provider['configured'] == true && provider['textAvailable'] == true;
  bool get visionReady =>
      provider['configured'] == true && provider['visionAvailable'] == true;

  @override
  void initState() {
    super.initState();
    updateMode = widget.updateMode;
    _load();
  }

  @override
  void dispose() {
    _message.dispose();
    _images = [];
    super.dispose();
  }

  Future<void> _load() async {
    setState(() => busy = true);
    final value = await repo.load(widget.gameId, reveal: reveal);
    if (mounted) {
      setState(() {
        data = value;
        busy = false;
      });
    }
  }

  Future<void> _perform(
    Future<Map<String, dynamic>?> Function() operation,
  ) async {
    setState(() {
      busy = true;
      localNotice = null;
    });
    final value = await operation();
    if (mounted) {
      setState(() {
        data = value;
        busy = false;
      });
    }
  }

  Future<void> _send() async {
    final text = _message.text.trim();
    if (text.isEmpty && _images.isEmpty) return;
    if (_images.isNotEmpty && !visionReady) return;
    if (externalReady && !repo.externalTransferConsent) {
      setState(
        () => localNotice = 'Сначала подтвердите передачу текста и изображений внешнему AI-провайдеру.',
      );
      return;
    }
    await _perform(
      () => repo.sendMessage(
        widget.gameId,
        text,
        images: _images,
        reveal: reveal,
      ),
    );
    // Clear transient photographs even if a network reply is uncertain. The
    // repository retains them in RAM for the same idempotent request only.
    if (mounted) {
      setState(() {
        _images = [];
        if (repo.error == null || pending) _message.clear();
      });
    }
  }

  Future<void> _pickImages() async {
    try {
      final images = await repo.picker.pick();
      if (!mounted || images.isEmpty) return;
      setState(() {
        _images = images;
        localNotice = visionReady ? null : 'Vision ещё не подключён. Фотографии выбраны только для предпросмотра и не передаются; автоматического распознавания сейчас нет.';
      });
    } catch (_) {
      if (mounted) {
        setState(
          () => localNotice = 'Не удалось открыть изображения. Выберите до 3 файлов JPEG/PNG, каждый до 3 МБ и 12 мегапикселей.',
        );
      }
    }
  }

  String _value(dynamic value) =>
      value is List ? value.map(journeyLabel).join('; ') : journeyLabel(value);

  Future<dynamic> _editValue(String field, dynamic current) async {
    final definition = fields[field] as Map?;
    if (definition == null) return null;
    final choices = definition['values'] as List?;
    if (choices != null) {
      final result = await showDialog<Map<String, dynamic>>(
        context: context,
        builder: (c) => SimpleDialog(
          title: Text('${definition['label']}'),
          children: [
            for (final value in choices)
              SimpleDialogOption(
                onPressed: () => Navigator.pop(c, {'value': value}),
                child: Text(journeyLabel(value)),
              ),
          ],
        ),
      );
      return result;
    }
    final isArray = definition['type'] == 'array';
    final isNumber = definition['type'] == 'number';
    final controller = TextEditingController(
      text: current is List ? current.join('\n') : current?.toString() ?? '',
    );
    String? validation;
    final route = DialogRoute<Map<String, dynamic>>(
      context: context,
      builder: (c) => StatefulBuilder(
        builder: (c, change) => AlertDialog(
          title: Text('${definition['label']}'),
          content: TextField(
            controller: controller,
            autofocus: true,
            keyboardType: isNumber
                ? TextInputType.number
                : TextInputType.multiline,
            minLines: isArray ? 3 : 1,
            maxLines: isArray ? 6 : 3,
            maxLength: isArray ? 4000 : 300,
            decoration: InputDecoration(
              helperText: isArray
                  ? 'Каждый пункт с новой строки. Добавятся только указанные пункты.'
                  : isNumber
                  ? 'От ${definition['min']} до ${definition['max']}'
                  : null,
              errorText: validation,
            ),
          ),
          actions: [
            TextButton(
              onPressed: () => Navigator.pop(c),
              child: const Text('Отмена'),
            ),
            FilledButton(
              onPressed: () {
                dynamic value = controller.text.trim();
                if (isNumber) {
                  value = int.tryParse(value as String);
                  if (value == null ||
                      value < (definition['min'] as int? ?? 0) ||
                      value > (definition['max'] as int? ?? 100000)) {
                    change(
                      () => validation =
                          'Укажите целое число в допустимом диапазоне.',
                    );
                    return;
                  }
                } else if (isArray) {
                  final entries = (value as String)
                      .split('\n')
                      .map((e) => e.trim())
                      .where((e) => e.isNotEmpty)
                      .toList();
                  if (entries.isEmpty ||
                      entries.length > 100 ||
                      entries.any((e) => e.length > 160)) {
                    change(
                      () => validation =
                          'Укажите 1–100 пунктов, до 160 символов в каждом.',
                    );
                    return;
                  }
                  value = entries;
                } else if ((value as String).isEmpty) {
                  change(() => validation = 'Укажите значение.');
                  return;
                }
                Navigator.pop(c, {'value': value});
              },
              child: const Text('Использовать в черновике'),
            ),
          ],
        ),
      ),
    );
    final result = await Navigator.of(context).push(route);
    await route.completed;
    controller.dispose();
    return result;
  }

  Future<void> _addManualItem() async {
    final field = await showModalBottomSheet<String>(
      context: context,
      isScrollControlled: true,
      builder: (c) => SafeArea(
        child: SizedBox(
          height: MediaQuery.sizeOf(c).height * .7,
          child: ListView(
            padding: const EdgeInsets.all(16),
            children: [
              Text('Что изменилось?', style: Theme.of(c).textTheme.titleLarge),
              const Text('Вы выбираете факт вручную. AI его не извлекал.'),
              for (final entry in fields.entries)
                if ((entry.value as Map)['legacy'] != true)
                  ListTile(
                    title: Text('${entry.value['label']}'),
                    onTap: () => Navigator.pop(c, entry.key as String),
                  ),
            ],
          ),
        ),
      ),
    );
    if (!mounted || field == null) return;
    final existing = _manualItems.where((e) => e['field'] == field).firstOrNull;
    final result = await _editValue(field, existing?['value']);
    if (!mounted || result == null) return;
    setState(() {
      _manualItems.removeWhere((e) => e['field'] == field);
      _manualItems.add({
        'field': field,
        'value': result['value'],
        if (fields[field]?['type'] == 'array') 'operation': 'add',
      });
    });
  }

  Widget _card(Widget child) => Card(
    child: Padding(padding: const EdgeInsets.all(16), child: child),
  );

  Widget _proposal(Map proposal) {
    final items = proposal['items'] as List;
    final hasPending = items.any((i) => i['status'] == 'pending');
    final isManual = proposal['source'] == 'USER_DRAFT';
    return _card(
      Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            isManual ? 'Ваш черновик изменений' : 'Предложенные изменения',
            style: Theme.of(context).textTheme.titleMedium,
          ),
          Text(
            isManual
                ? 'Выбрано вами вручную · ещё не подтверждено'
                : 'Предположение AI · ещё не подтверждено',
          ),
          for (final raw in items)
            Builder(
              builder: (context) {
                final item = raw as Map;
                final key = '${proposal['id']}:${item['id']}';
                final value = _edited.containsKey(key)
                    ? _edited[key]
                    : item['value'];
                final editable =
                    fields.containsKey(item['field']) &&
                    item['spoilerHidden'] != true;
                final active = item['status'] == 'pending';
                return Padding(
                  padding: const EdgeInsets.only(top: 12),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Row(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Checkbox(
                            key: ValueKey(
                              'choose-${proposal['id']}-${item['id']}',
                            ),
                            value: active && _selected.contains(key),
                            onChanged: busy || pending || !active || !editable
                                ? null
                                : (v) => setState(() {
                                    if (v == true) {
                                      _selected.add(key);
                                    } else {
                                      _selected.remove(key);
                                    }
                                  }),
                          ),
                          Expanded(
                            child: Column(
                              crossAxisAlignment: CrossAxisAlignment.start,
                              children: [
                                Text(
                                  '${item['label'] ?? fields[item['field']]?['label'] ?? item['field']}',
                                  style: Theme.of(context).textTheme.labelLarge,
                                ),
                                Text(_value(value)),
                                if (item['previousValue'] != null)
                                  Text(
                                    'Сейчас: ${_value(item['previousValue'])}',
                                    style: Theme.of(context)
                                        .textTheme
                                        .bodySmall,
                                  ),
                                if (item['operation'] == 'add')
                                  const Text(
                                    'Добавить к уже известному списку',
                                  ),
                                if (item['conflict'] == true ||
                                    item['conflict'] is Map)
                                  const Text(
                                    'Расходится с сохранённым фактом. Проверьте перед подтверждением.',
                                  ),
                                if (item['evidence'] != null)
                                  Text(
                                    'Основание: ${item['evidence']}',
                                    style: Theme.of(context)
                                        .textTheme
                                        .bodySmall,
                                  ),
                                if (!active)
                                  Text(
                                    item['status'] == 'accepted'
                                        ? 'Подтверждено вами · запись истории'
                                        : 'Отклонено',
                                  ),
                                if (!editable && active)
                                  const Text(
                                    'Сведения скрыты настройкой спойлеров. Раскройте подробности для редактирования.',
                                  ),
                              ],
                            ),
                          ),
                          if (active && editable)
                            IconButton(
                              key: ValueKey(
                                'edit-${proposal['id']}-${item['id']}',
                              ),
                              tooltip: 'Исправить предложение',
                              icon: const Icon(Icons.edit_outlined),
                              onPressed: busy || pending
                                  ? null
                                  : () async {
                                      final result = await _editValue(
                                        item['field'] as String,
                                        value,
                                      );
                                      if (mounted && result != null) {
                                        setState(() {
                                          _edited[key] = result['value'];
                                          _selected.add(key);
                                        });
                                      }
                                    },
                            ),
                        ],
                      ),
                      if (active)
                        Align(
                          alignment: Alignment.centerRight,
                          child: TextButton(
                            key: ValueKey(
                              'reject-${proposal['id']}-${item['id']}',
                            ),
                            onPressed: busy || pending
                                ? null
                                : () => _perform(
                                    () => repo.resolve(
                                      widget.gameId,
                                      proposal['id'] as String,
                                      [
                                        {
                                          'itemId': item['id'],
                                          'decision': 'reject',
                                        },
                                      ],
                                      reveal: reveal,
                                    ),
                                  ),
                            child: const Text('Отклонить пункт'),
                          ),
                        ),
                    ],
                  ),
                );
              },
            ),
          if (hasPending)
            FilledButton.icon(
              key: ValueKey('accept-${proposal['id']}'),
              onPressed:
                  busy ||
                      pending ||
                      !items.any(
                        (i) =>
                            i['status'] == 'pending' &&
                            _selected.contains('${proposal['id']}:${i['id']}'),
                      )
                  ? null
                  : () => _perform(
                      () => repo.resolve(
                        widget.gameId,
                        proposal['id'] as String,
                        [
                          for (final i in items)
                            if (i['status'] == 'pending' &&
                                _selected.contains(
                                  '${proposal['id']}:${i['id']}',
                                ))
                              {
                                'itemId': i['id'],
                                'decision': 'accept',
                                if (_edited.containsKey(
                                  '${proposal['id']}:${i['id']}',
                                ))
                                  'value':
                                      _edited['${proposal['id']}:${i['id']}'],
                              },
                        ],
                        reveal: reveal,
                      ),
                    ),
              icon: const Icon(Icons.check),
              label: const Text('Подтвердить выбранные пункты'),
            ),
        ],
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final d = data;
    return Scaffold(
      appBar: AppBar(
        title: const Text('Компаньон'),
        actions: [
          IconButton(
            onPressed: busy ? null : _load,
            tooltip: 'Проверить историю сервера',
            icon: const Icon(Icons.refresh),
          ),
        ],
      ),
      body: busy && d == null
          ? const Center(child: CircularProgressIndicator())
          : ListView(
              padding: const EdgeInsets.all(20),
              children: [
                if (busy) const LinearProgressIndicator(),
                OutlinedButton.icon(
                  onPressed: busy
                      ? null
                      : () => Navigator.of(context).push(
                          MaterialPageRoute<void>(
                            builder: (_) => ChatGptPlanPage(
                              gameId: widget.gameId,
                              repository: repo,
                            ),
                          ),
                        ),
                  icon: const Icon(Icons.auto_awesome_outlined),
                  label: const Text('Подключить личный ChatGPT'),
                ),
                if (repo.error != null) _card(Text(repo.error!)),
                if (localNotice != null) _card(Text(localNotice!)),
                if (d == null)
                  const Text(
                    'Для первого открытия подключитесь к серверу. История этой игры пока не сохранена.',
                  ),
                if (d != null) ...[
                  Text(
                    '${d['title'] ?? ''}',
                    style: Theme.of(context).textTheme.headlineSmall,
                  ),
                  Text(
                    '${repo.offline ? 'Сохранённая история · офлайн' : 'Контекст сервера'} · версия ${d['revision']}',
                  ),
                  const SizedBox(height: 12),
                  _card(
                    Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(
                          externalReady
                              ? 'AI-компаньон подключён'
                              : 'Чат и подтверждение прохождения',
                          style: Theme.of(context).textTheme.titleMedium,
                        ),
                        Text(
                          externalReady
                              ? 'Ответ учитывает подтверждённое прохождение и доступные правила. Изменения сохраняются только после вашего подтверждения.'
                              : 'Личный ChatGPT открывается кнопкой выше и работает на устройстве. Здесь можно сохранить сообщение и подготовить изменения с предпросмотром.',
                        ),
                        if (!visionReady)
                          const Text(
                            'Снимки в этом режиме не анализируются. Для AI-анализа используйте личный ChatGPT.',
                          ),
                        if (d['coverage']?['limitation'] != null)
                          Text('${d['coverage']['limitation']}'),
                      ],
                    ),
                  ),
                  if ((d['currentRunFacts'] as Map).isNotEmpty)
                    ExpansionTile(
                      title: const Text('Контекст этого прохождения'),
                      children: [
                        for (final entry
                            in (d['currentRunFacts'] as Map).entries)
                          ListTile(
                            title: Text(
                              '${fields[entry.key]?['label'] ?? entry.key}',
                            ),
                            subtitle: Text(_value(entry.value['value'])),
                          ),
                      ],
                    ),
                  if (d['run'] == null && d['runId'] == null)
                    _card(
                      const Text(
                        'Сначала начните вести прохождение на экране пути к платине. Трофеи аккаунта не определяют текущее сохранение.',
                      ),
                    ),
                  for (final raw in d['messages'] as List)
                    Builder(
                      builder: (context) {
                        final m = raw as Map;
                        final mine = m['role'] == 'user';
                        return Align(
                          alignment: mine
                              ? Alignment.centerRight
                              : Alignment.centerLeft,
                          child: Card(
                            color: mine
                                ? Theme.of(context).colorScheme.primaryContainer
                                : null,
                            child: Padding(
                              padding: const EdgeInsets.all(14),
                              child: Column(
                                crossAxisAlignment: CrossAxisAlignment.start,
                                children: [
                                  Text(
                                    mine
                                        ? 'Вы'
                                        : m['source'] == 'SYSTEM' ||
                                              !externalReady
                                        ? 'Companion'
                                        : 'AI-компаньон',
                                    style: Theme.of(context)
                                        .textTheme
                                        .labelLarge,
                                  ),
                                  SelectableText('${m['text']}'),
                                  for (final question
                                      in m['questions'] as List? ?? [])
                                    Padding(
                                      padding: const EdgeInsets.only(top: 8),
                                      child: Text('Уточните: $question'),
                                    ),
                                  for (final advice
                                      in (m['advice'] as List? ?? []).take(2))
                                    Padding(
                                      padding: const EdgeInsets.only(top: 10),
                                      child: Column(
                                        crossAxisAlignment:
                                            CrossAxisAlignment.start,
                                        children: [
                                          Text(
                                            '${advice['category']} · ${advice['title']}',
                                            style: Theme.of(context)
                                                .textTheme
                                                .labelLarge,
                                          ),
                                          Text('${advice['message']}'),
                                          if (advice['whyNow'] != null)
                                            Text(
                                              'Почему сейчас: ${advice['whyNow']}',
                                            ),
                                          Text(
                                            'Игровой источник · ${advice['certainty'] ?? 'Требует проверки'}',
                                            style: Theme.of(context)
                                                .textTheme
                                                .bodySmall,
                                          ),
                                        ],
                                      ),
                                    ),
                                  if (m['imageCount'] is int &&
                                      m['imageCount'] > 0)
                                    Text(
                                      'Прикреплено снимков: ${m['imageCount']}. Файлы в истории не сохраняются.',
                                    ),
                                  if (m['createdAt'] != null)
                                    Text(
                                      '${m['createdAt']}',
                                      style: Theme.of(context)
                                          .textTheme
                                          .bodySmall,
                                    ),
                                ],
                              ),
                            ),
                          ),
                        );
                      },
                    ),
                  for (final p in d['proposals'] as List) _proposal(p as Map),
                  if (pending)
                    _card(
                      Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          const Text(
                            'Исход предыдущей отправки пока не подтверждён.',
                          ),
                          if (repo.pendingImagesNeedReselection(widget.gameId))
                            const Text(
                              'Фотографии не сохранены на диске. Сначала проверьте, завершилась ли исходная обработка.',
                            ),
                          FilledButton(
                            key: const Key('retry-companion'),
                            onPressed: busy
                                ? null
                                : () => _perform(
                                    () => repo.retry(
                                      widget.gameId,
                                      reveal: reveal,
                                    ),
                                  ),
                            child: const Text('Проверить отправку'),
                          ),
                        ],
                      ),
                    ),
                  const SizedBox(height: 16),
                  SegmentedButton<bool>(
                    segments: const [
                      ButtonSegment(
                        value: false,
                        label: Text('Спросить'),
                        icon: Icon(Icons.chat_bubble_outline),
                      ),
                      ButtonSegment(
                        value: true,
                        label: Text('Обновить'),
                        icon: Icon(Icons.edit_note),
                      ),
                    ],
                    selected: {updateMode},
                    onSelectionChanged: (v) =>
                        setState(() => updateMode = v.first),
                  ),
                  const SizedBox(height: 12),
                  TextField(
                    key: const Key('companion-message'),
                    controller: _message,
                    minLines: 2,
                    maxLines: 5,
                    maxLength: 3000,
                    enabled: !busy && !pending,
                    decoration: InputDecoration(
                      labelText: updateMode
                          ? 'Что изменилось в игре?'
                          : 'Сообщение или вопрос',
                      hintText: updateMode
                          ? 'Получил грамоту от Барона, приехал в Оксенфурт…'
                          : 'Что стоит сделать на этом этапе?',
                    ),
                  ),
                  if (_images.isNotEmpty)
                    Wrap(
                      spacing: 8,
                      children: [
                        for (var i = 0; i < _images.length; i++)
                          SizedBox(
                            width: 100,
                            child: Column(
                              children: [
                                ClipRRect(
                                  borderRadius: BorderRadius.circular(10),
                                  child: Image.memory(
                                    _images[i].bytes,
                                    cacheWidth: 300,
                                    width: 100,
                                    height: 70,
                                    fit: BoxFit.cover,
                                  ),
                                ),
                                Text(
                                  '${_images[i].width} × ${_images[i].height}',
                                  style: Theme.of(context).textTheme.bodySmall,
                                ),
                                TextButton(
                                  onPressed: busy
                                      ? null
                                      : () =>
                                            setState(() => _images.removeAt(i)),
                                  child: const Text('Убрать'),
                                ),
                              ],
                            ),
                          ),
                      ],
                    ),
                  if (_images.isNotEmpty && !visionReady)
                    const Text(
                      'Распознавание не подключено. Уберите снимки, чтобы сохранить текст.',
                    ),
                  if (externalReady)
                    CheckboxListTile(
                      contentPadding: EdgeInsets.zero,
                      value: repo.externalTransferConsent,
                      onChanged: busy || pending
                          ? null
                          : (v) async {
                              await repo.setExternalTransferConsent(v == true);
                              if (mounted) setState(() {});
                            },
                      title: const Text('Разрешаю передачу внешнему AI'),
                      subtitle: const Text(
                        'Текст, выбранные снимки и необходимый игровой контекст передаются через Freshoryx стороннему провайдеру модели. Изображения не сохраняются в истории. Согласие можно снять здесь.',
                      ),
                    ),
                  Row(
                    children: [
                      IconButton(
                        key: const Key('attach-game-images'),
                        tooltip: 'Выбрать до трёх игровых снимков',
                        onPressed: busy || pending ? null : _pickImages,
                        icon: const Icon(Icons.add_photo_alternate_outlined),
                      ),
                      Expanded(
                        child: FilledButton.icon(
                          key: const Key('send-companion'),
                          onPressed:
                              busy ||
                                  pending ||
                                  repo.offline ||
                                  (_images.isNotEmpty && !visionReady)
                              ? null
                              : _send,
                          icon: const Icon(Icons.send_outlined),
                          label: Text(
                            externalReady ? 'Отправить' : 'Сохранить сообщение',
                          ),
                        ),
                      ),
                    ],
                  ),
                  SwitchListTile(
                    contentPadding: EdgeInsets.zero,
                    title: const Text('Разрешить сюжетные подробности'),
                    value: reveal,
                    onChanged: busy || pending
                        ? null
                        : (v) {
                            setState(() {
                              reveal = v;
                              data = null;
                              _selected.clear();
                              _edited.clear();
                              _manualItems.clear();
                            });
                            _load();
                          },
                  ),
                  _card(
                    Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(
                          'Подготовить изменения вручную',
                          style: Theme.of(context).textTheme.titleMedium,
                        ),
                        const Text(
                          'Альтернативный ввод. Вы выбираете конкретные факты, затем отдельно подтверждаете их. AI не участвует.',
                        ),
                        for (final item in _manualItems)
                          ListTile(
                            contentPadding: EdgeInsets.zero,
                            title: Text(
                              '${fields[item['field']]?['label'] ?? item['field']}',
                            ),
                            subtitle: Text(_value(item['value'])),
                            trailing: IconButton(
                              tooltip: 'Убрать из черновика',
                              icon: const Icon(Icons.close),
                              onPressed: busy || pending
                                  ? null
                                  : () => setState(
                                      () => _manualItems.remove(item),
                                    ),
                            ),
                            onTap: busy || pending
                                ? null
                                : () async {
                                    final result = await _editValue(
                                      item['field'],
                                      item['value'],
                                    );
                                    if (mounted && result != null) {
                                      setState(
                                        () => item['value'] = result['value'],
                                      );
                                    }
                                  },
                          ),
                        OutlinedButton.icon(
                          key: const Key('add-manual-fact'),
                          onPressed:
                              busy ||
                                  pending ||
                                  repo.offline ||
                                  (d['run'] == null && d['runId'] == null)
                              ? null
                              : _addManualItem,
                          icon: const Icon(Icons.add),
                          label: const Text('Выбрать факт'),
                        ),
                        if (_manualItems.isNotEmpty)
                          FilledButton(
                            key: const Key('preview-manual-proposal'),
                            onPressed: busy || pending || repo.offline
                                ? null
                                : () async {
                                    await _perform(
                                      () => repo.manualProposal(
                                        widget.gameId,
                                        _manualItems
                                            .map(
                                              (e) =>
                                                  Map<String, dynamic>.from(e),
                                            )
                                            .toList(),
                                        text: _message.text,
                                        reveal: reveal,
                                      ),
                                    );
                                    if (mounted && repo.error == null) {
                                      setState(() => _manualItems.clear());
                                    }
                                  },
                            child: const Text(
                              'Показать черновик для подтверждения',
                            ),
                          ),
                      ],
                    ),
                  ),
                  const SizedBox(height: 30),
                ],
              ],
            ),
    );
  }
}
