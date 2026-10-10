import 'package:flutter/material.dart';

import '../data/cloud_controller.dart';
import 'widgets.dart';

class CloudPanel extends StatelessWidget {
  const CloudPanel({super.key, required this.cloud, this.compact = false});
  final CloudController cloud;
  final bool compact;

  Future<void> _connect(BuildContext context) async {
    final field = TextEditingController(
      text: cloud.configuration?.origin.toString() ?? '',
    );
    final origin = await showDialog<String>(
      context: context,
      builder: (context) => AlertDialog(
        title: const Text('Подключить Companion'),
        content: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            const Text(
              'Укажите адрес своего сервера Companion. Далее откроется браузер для входа в аккаунт приложения. Пароль PSN здесь не нужен.\n\nПодключайте тот же аккаунт, которому принадлежит импортированная библиотека.',
            ),
            const SizedBox(height: 16),
            TextField(
              controller: field,
              keyboardType: TextInputType.url,
              autocorrect: false,
              decoration: const InputDecoration(
                labelText: 'Адрес HTTPS-сервера',
              ),
            ),
          ],
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(context),
            child: const Text('Отмена'),
          ),
          FilledButton(
            onPressed: () => Navigator.pop(context, field.text.trim()),
            child: const Text('Войти через браузер'),
          ),
        ],
      ),
    );
    // The route's TextField may still be animating out after the dialog result.
    if (origin != null) await cloud.connect(origin);
  }

  @override
  Widget build(BuildContext context) => AnimatedBuilder(
    animation: cloud,
    builder: (context, _) {
      final status = cloud.syncStatus;
      final state = switch (status?['lastResult']) {
        'success' => 'Успешно',
        'partial' => 'Частично: часть игр не обновилась',
        'failed' => 'Ошибка: предыдущие снимки сохранены',
        'cooldown' => 'Пауза между запросами',
        _ => 'Нет подтверждённого результата',
      };
      return Card(
        child: Padding(
          padding: const EdgeInsets.all(18),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Row(
                children: [
                  Icon(
                    cloud.connected
                        ? Icons.cloud_outlined
                        : Icons.cloud_off_outlined,
                  ),
                  const SizedBox(width: 10),
                  Expanded(
                    child: Text(
                      cloud.connected
                          ? 'Companion подключён'
                          : 'Офлайн-библиотека',
                      style: Theme.of(context).textTheme.titleMedium,
                    ),
                  ),
                ],
              ),
              const SizedBox(height: 10),
              Text(
                cloud.connected
                    ? 'Снимок сервера · PSN обновляется отдельным запросом.'
                    : 'Сервер не подключён. Игры и трофеи доступны из сохранённого снимка.',
              ),
              if (cloud.busy)
                const Padding(
                  padding: EdgeInsets.symmetric(vertical: 12),
                  child: LinearProgressIndicator(),
                ),
              if (cloud.error != null)
                Padding(
                  padding: const EdgeInsets.symmetric(vertical: 8),
                  child: Text(
                    cloud.error!,
                    style: TextStyle(
                      color: Theme.of(context).colorScheme.error,
                    ),
                  ),
                ),
              if (cloud.notice != null)
                Padding(
                  padding: const EdgeInsets.symmetric(vertical: 8),
                  child: Text(cloud.notice!),
                ),
              if (cloud.connected) ...[
                DetailRow(
                  'Последнее наблюдение PSN',
                  displayDate(cloud.repository.snapshot?.latestObservation),
                ),
                if (status != null)
                  DetailRow(
                    'Последний запрос PSN',
                    status['running'] == true ? 'Выполняется' : state,
                  ),
                if (!compact && status?['lastAttemptAt'] is String)
                  DetailRow(
                    'Попытка обновления',
                    displayDate(
                      DateTime.tryParse(status!['lastAttemptAt'] as String),
                    ),
                  ),
                if (!compact && status?['nextAllowedAt'] is String)
                  DetailRow(
                    'Следующий запрос не раньше',
                    displayDate(
                      DateTime.tryParse(status!['nextAllowedAt'] as String),
                    ),
                  ),
                const SizedBox(height: 10),
                FilledButton.icon(
                  onPressed: cloud.busy
                      ? null
                      : () => cloud.refresh(requestPsn: true),
                  icon: const Icon(Icons.sync),
                  label: const Text('Обновить из PSN'),
                ),
                if (!compact) ...[
                  TextButton(
                    onPressed: cloud.busy ? null : () => cloud.refresh(),
                    child: const Text('Проверить снимок сервера'),
                  ),
                  TextButton(
                    onPressed: cloud.busy ? null : cloud.loadDevices,
                    child: const Text('Устройства и сеансы'),
                  ),
                  for (var i = 0; i < cloud.devices.length; i++)
                    ListTile(
                      contentPadding: EdgeInsets.zero,
                      title: Text(
                        cloud.devices[i]['current'] == true
                            ? 'Этот сеанс'
                            : 'Сеанс ${i + 1}',
                      ),
                      subtitle: Text(
                        cloud.devices[i]['revokedAt'] != null
                            ? 'Доступ отозван'
                            : 'Браузерный вход Companion',
                      ),
                      trailing: cloud.devices[i]['revokedAt'] != null
                          ? null
                          : TextButton(
                              onPressed: cloud.busy
                                  ? null
                                  : () => cloud.revoke(
                                      cloud.devices[i]['id'] as String,
                                    ),
                              child: const Text('Отозвать'),
                            ),
                    ),
                  OutlinedButton(
                    onPressed: cloud.busy ? null : cloud.disconnect,
                    child: const Text('Отключить аккаунт'),
                  ),
                ],
              ] else if (!compact) ...[
                const SizedBox(height: 12),
                FilledButton.icon(
                  onPressed: cloud.busy ? null : () => _connect(context),
                  icon: const Icon(Icons.login),
                  label: const Text('Подключить сервер'),
                ),
                if (cloud.configuration != null)
                  TextButton(
                    onPressed: cloud.busy ? null : cloud.disconnect,
                    child: const Text('Удалить локальный вход'),
                  ),
              ],
            ],
          ),
        ),
      );
    },
  );
}
