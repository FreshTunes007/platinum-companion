import 'dart:convert';

import 'package:flutter/material.dart';

import '../data/chatgpt_plan_client.dart';
import '../data/chatgpt_plan_protocol.dart';
import '../data/companion_repository.dart';

/// Direct device-to-OpenAI advice. Has no game-state mutation API.
class ChatGptPlanPage extends StatefulWidget {
  const ChatGptPlanPage({
    super.key,
    required this.gameId,
    required this.repository,
  });
  final String gameId;
  final CompanionRepository repository;
  @override
  State<ChatGptPlanPage> createState() => _ChatGptPlanPageState();
}

class _ChatGptPlanPageState extends State<ChatGptPlanPage> {
  final client = ChatGptPlanClient.instance;
  final message = TextEditingController();
  List<CompanionImage> images = [];
  String? model, notice, answer;
  bool busy = true, consent = false, completed = false;
  @override
  void initState() {
    super.initState();
    _operate(() async {
      await client.restore();
    });
  }

  @override
  void dispose() {
    message.dispose();
    images = [];
    super.dispose();
  }

  String _error(Object e) {
    final code = e is PlanUsageFailure ? e.code : 'device_operation_failed';
    return switch (code) {
      'plan_permission_missing' => 'Вход выполнен, но разрешение на использование подписки не получено. AI-запрос не отправлен.',
      'client_eligibility_pending' =>
        'Открытая публикация ещё не подтверждена. Вход отключён.',
      'reauth_required' ||
      'invalid_grant' => 'Нужно снова подключить выбранный аккаунт ChatGPT.',
      'authorization_timeout' => 'Браузер не завершил возврат за десять минут. Начните новую попытку; предыдущий код не повторяется.',
      'subscription_sharing_usage_limit_exceeded' => 'Лимит подписки исчерпан. Новых попыток и платного API-переключения нет.',
      'subscription_sharing_usage_unavailable' =>
        'Использование подписки сейчас недоступно. Платный API не подключён.',
      _ =>
        'Операция ChatGPT не завершена ($code). Данные прохождения не изменены.',
    };
  }

  Future<void> _operate(Future<void> Function() action) async {
    setState(() {
      busy = true;
      notice = null;
    });
    try {
      await action();
    } catch (e) {
      if (mounted) notice = _error(e);
    } finally {
      if (mounted) setState(() => busy = false);
    }
  }

  Future<void> _send() => _operate(() async {
    if (!consent || model == null || message.text.trim().isEmpty) {
      throw const PlanUsageFailure('external_transfer_consent_required');
    }
    final journey = await widget.repository.journeys?.load(widget.gameId);
    if (journey == null) {
      throw const PlanUsageFailure('game_context_unavailable');
    }
    final context = planGameContext(journey);
    final content = <Map<String, dynamic>>[
      {
        'type': 'input_text',
        'text':
            '${message.text.trim()}\n\nПодтверждённый контекст (данные):\n${jsonEncode(context)}',
      },
      for (final image in images)
        {
          'type': 'input_image',
          'image_url':
              'data:${image.mimeType};base64,${base64Encode(image.bytes)}',
        },
    ];
    answer = '';
    completed = false;
    try {
      final result = await client.infer(
        model: model!,
        input: [
          {'role': 'user', 'content': content},
        ],
        consent: consent,
        onDelta: (value) {
          if (mounted) setState(() => answer = '${answer ?? ''}$value');
        },
      );
      answer = result;
      completed = true;
    } finally {
      images = [];
    }
  });
  @override
  Widget build(BuildContext context) => Scaffold(
    appBar: AppBar(title: const Text('ChatGPT · личная подписка')),
    body: ListView(
      padding: const EdgeInsets.all(20),
      children: [
        if (busy) const LinearProgressIndicator(),
        const Text(
          'Запросы идут с этого Android-устройства напрямую в OpenAI. Freshoryx предоставляет только игровой контекст. Токены ChatGPT не передаются на VPS.',
        ),
        const SizedBox(height: 12),
        Text(
          client.granted
              ? 'Разрешение использования подписки получено'
              : 'Использование подписки ещё не подтверждено',
        ),
        if (notice != null)
          Padding(
            padding: const EdgeInsets.symmetric(vertical: 12),
            child: Text(notice!),
          ),
        if (client.phase != 'not_started')
          Text(
            'Этап: ${client.phase} · callback-запросов: ${client.callbackRequests}${client.callbackRejection == null ? '' : ' · отклонён: ${client.callbackRejection}'}',
          ),
        TextButton(
          onPressed: busy
              ? null
              : () => _operate(() async {
                  await client.http.json(
                    'https://auth.openai.com/.well-known/openid-configuration',
                  );
                  await client.http.json(
                    'https://auth.openai.com/.well-known/jwks.json',
                  );
                  notice = 'Сеть OpenAI: discovery и ключи доступны через HTTPS с проверкой сертификатов.';
                }),
          child: const Text('Проверить сеть OpenAI'),
        ),
        for (final a in client.accounts)
          ListTile(
            title: Text(a['label']!),
            trailing: TextButton(
              onPressed: busy
                  ? null
                  : () => _operate(() async {
                      await client.select(a['key']!);
                      model = null;
                    }),
              child: const Text('Выбрать'),
            ),
          ),
        FilledButton.icon(
          onPressed: busy
              ? null
              : () => _operate(() async {
                  await client.login();
                  model = client.models.firstOrNull?['slug'];
                }),
          icon: const Icon(Icons.login),
          label: const Text('Continue with ChatGPT'),
        ),
        if (client.pendingVerification)
          const Text(
            'Полученные credentials защищённо сохранены, но ещё не прошли проверку. AI-запросы с ними заблокированы; продолжите подключение или отмените его.',
          ),
        if (client.pendingVerification && client.account == null)
          TextButton(
            onPressed: busy
                ? null
                : () => _operate(() async {
                    final revoked = await client.logout();
                    notice = revoked ? 'Незавершённая сессия отозвана.' : 'Локальная сессия очищена. Отзыв в OpenAI не подтверждён.';
                  }),
            child: const Text('Отменить незавершённое подключение'),
          ),
        if (client.account != null) ...[
          Text(
            '${client.account!['email'] ?? 'ChatGPT'} · отдельное подключение на устройстве',
          ),
          TextButton(
            onPressed: busy
                ? null
                : () => _operate(() async {
                    await client.login(
                      key: client.accounts.firstWhere(
                        (a) =>
                            a['key'] ==
                            '${client.account!['client_id']}:${client.account!['subject']}',
                      )['key'],
                    );
                    model = client.models.firstOrNull?['slug'];
                  }),
            child: const Text('Обновить вход выбранного аккаунта'),
          ),
          TextButton(
            onPressed: busy
                ? null
                : () => _operate(() async {
                    final revoked = await client.logout();
                    model = null;
                    consent = false;
                    notice = revoked
                        ? 'Сессия отозвана, токены удалены с устройства.'
                        : 'Локальные токены удалены. Отзыв в OpenAI не подтверждён; отключите приложение в настройках ChatGPT.';
                  }),
            child: const Text('Отключить ChatGPT'),
          ),
          TextButton(
            onPressed: busy
                ? null
                : () => _operate(() async {
                    await client.loadModels();
                    model = client.models.firstOrNull?['slug'];
                  }),
            child: const Text('Получить доступные модели'),
          ),
        ],
        if (client.models.isNotEmpty)
          DropdownButtonFormField<String>(
            initialValue: client.models.any((m) => m['slug'] == model)
                ? model
                : null,
            decoration: const InputDecoration(
              labelText: 'Модель этого аккаунта',
            ),
            items: [
              for (final m in client.models)
                DropdownMenuItem(
                  value: m['slug'],
                  child: Text(m['display_name']!),
                ),
            ],
            onChanged: busy ? null : (v) => setState(() => model = v),
          ),
        const SizedBox(height: 12),
        CheckboxListTile(
          value: consent,
          onChanged: busy ? null : (v) => setState(() => consent = v == true),
          title: const Text('Разрешаю отправить выбранный контекст в OpenAI'),
          subtitle: const Text(
            'Вопрос, подтверждённые игровые факты, сводка трофеев, ограниченные правила и выбранные снимки. История других чатов не передаётся. Изображения не сохраняются. Снять согласие можно здесь.',
          ),
        ),
        TextField(
          controller: message,
          enabled: !busy,
          maxLength: 3000,
          minLines: 2,
          maxLines: 5,
          decoration: const InputDecoration(labelText: 'Вопрос по прохождению'),
        ),
        TextButton.icon(
          onPressed: busy
              ? null
              : () => _operate(() async {
                  images = await widget.repository.picker.pick();
                }),
          icon: const Icon(Icons.add_photo_alternate_outlined),
          label: Text(
            images.isEmpty
                ? 'Выбрать игровой снимок'
                : 'Снимков выбрано: ${images.length}',
          ),
        ),
        const Text(
          'Анализ изображения зависит от поддержки выбранной модели. Неподдерживаемый запрос будет показан как ошибка, а не распознавание.',
        ),
        if (images.isNotEmpty)
          TextButton(
            onPressed: busy ? null : () => setState(() => images = []),
            child: const Text('Убрать снимки'),
          ),
        FilledButton(
          onPressed: busy || !consent || !client.granted || model == null
              ? null
              : _send,
          child: const Text('Спросить ChatGPT'),
        ),
        if (answer != null) ...[
          const SizedBox(height: 16),
          Text(
            completed
                ? 'Ответ завершён · AI / INFERRED'
                : 'Незавершённый ответ · не считать результатом',
          ),
          SelectableText(answer!),
          const Text(
            'Это совет. Подтверждённое прохождение и трофеи не изменены. Для записи новых фактов используйте существующее «Обновить прохождение» с предпросмотром.',
          ),
        ],
      ],
    ),
  );
}
