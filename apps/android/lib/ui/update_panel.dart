import 'package:flutter/material.dart';

import '../data/update_controller.dart';

class UpdatePanel extends StatelessWidget {
  const UpdatePanel({super.key, required this.updates});
  final UpdateController updates;
  @override
  Widget build(BuildContext context) => AnimatedBuilder(
    animation: updates,
    builder: (context, _) => Card(
      child: Padding(
        padding: const EdgeInsets.all(20),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Text(
              'Обновления Freshoryx',
              style: Theme.of(context).textTheme.titleMedium,
            ),
            const SizedBox(height: 12),
            Text('Установлена ${updates.installedVersion}'),
            Text(updates.message),
            const SizedBox(height: 12),
            SegmentedButton<String>(
              segments: const [
                ButtonSegment(value: 'stable', label: Text('Stable')),
                ButtonSegment(value: 'beta', label: Text('Beta')),
              ],
              selected: {updates.releaseChannel},
              onSelectionChanged: updates.busy
                  ? null
                  : (value) {
                      updates.releaseChannel = value.first;
                      updates.check(manual: true);
                    },
            ),
            const SizedBox(height: 12),
            OutlinedButton(
              onPressed: updates.busy
                  ? null
                  : () => updates.check(manual: true),
              child: Text(updates.busy ? 'Проверяем…' : 'Проверить обновления'),
            ),
            if (updates.release != null) ...[
              for (final line in updates.release!['changelog'] as List)
                Text('• $line'),
              const SizedBox(height: 12),
              FilledButton(
                onPressed: updates.open,
                child: const Text('Обновить'),
              ),
              TextButton(onPressed: updates.later, child: const Text('Позже')),
            ],
            const Text(
              'Установка — через браузер и подтверждение Android. Проверяем автоматически не чаще раза в сутки.',
              style: TextStyle(fontSize: 12),
            ),
          ],
        ),
      ),
    ),
  );
}
