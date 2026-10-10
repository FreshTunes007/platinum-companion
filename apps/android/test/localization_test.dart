import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:platinum_companion/data/data.dart';
import 'package:platinum_companion/ui/trophy_language.dart';
import 'package:platinum_companion/ui/trophy_page.dart';

import 'package:platinum_companion/ui/app.dart';
import 'package:platinum_companion/ui/settings_page.dart';

import 'data_test.dart' show syntheticSnapshot, MemorySnapshotStorage;

Map<String, dynamic> localized() {
  final json = syntheticSnapshot(observedAt: '2026-01-03T10:00:00Z');
  json['schemaVersion'] = 2;
  final t = json['games'][0]['trophies'][0];
  t['name'] = 'Synthetic original';
  t['description'] = 'Original condition';
  t['official'] = {
    'iconUrl': 'https://example.invalid/icon.png',
    'originalLocale': 'en-US',
    'localizations': {
      'en-US': {
        'name': t['name'],
        'description': t['description'],
        'source': 'sony_catalog',
        'observedAt': '2026-01-03T09:00:00Z',
      },
      'ru-RU': {
        'name': 'Тестовое русское название',
        'description': 'Тестовое русское условие',
        'source': 'sony_catalog',
        'observedAt': '2026-01-03T09:00:01Z',
      },
    },
  };
  return json;
}

void main() {
  test('v1 upgrades to v2; locales and earned dates survive repeat import and restart', () async {
    final storage = MemorySnapshotStorage();
    final repository = TrophyRepository(storage: storage);
    await repository.importJson(jsonEncode(syntheticSnapshot()));
    final date = repository.games.single.trophies.first.earnedAt;
    final data = jsonEncode(localized());
    expect((await repository.importJson(data))?.updated, 1);
    expect((await repository.importJson(data))?.unchanged, 1);
    final restarted = TrophyRepository(storage: storage);
    await restarted.initialize();
    final t = restarted.games.single.trophies.first;
    expect(t.earnedAt, date);
    expect(t.displayName(true), 'Тестовое русское название');
    expect(t.displayDescription(false), 'Original condition');
    expect(restarted.games.single.trophies[1].displayName(true), 'Мастер');
    expect(restarted.games.single.summary.earned, 1);
  });
  test('rejects secrets/unsupported fields and mismatched original in locale payload', () {
    for (final mutate in <void Function(dynamic)>[
      (o) => o['token'] = 'SYNTHETIC',
      (o) => o['localizations']['ru-RU']['source'] = 'ai_translation',
      (o) => o['localizations']['en-US']['name'] = 'Mismatch',
      (o) => o['localizations']['ru-RU']['observedAt'] = '2030-01-01T00:00:00Z',
    ]) {
      final j = localized();
      mutate(j['games'][0]['trophies'][0]['official']);
      expect(
        () => SnapshotCodec.decode(jsonEncode(j)),
        throwsA(isA<SnapshotFormatException>()),
      );
    }
  });
  test('newer incomplete metadata or missing earnedAt cannot erase offline data', () async {
    final repository = TrophyRepository(storage: MemorySnapshotStorage());
    await repository.importJson(jsonEncode(localized()));
    final before = repository.games.single.contentSignature;
    for (final field in ['description', 'earnedAt']) {
      final next = jsonDecode(jsonEncode(localized())) as Map<String, dynamic>;
      next['games'][0]['observedAt'] = '2026-01-04T10:00:00Z';
      next['games'][0]['trophies'][0][field] = null;
      if (field == 'description') {
        next['games'][0]['trophies'][0]['official']['localizations']['en-US']['description'] =
            null;
      }
      expect(await repository.importJson(jsonEncode(next)), isNull);
      expect(repository.games.single.contentSignature, before);
    }
  });
  testWidgets('real app settings updates the language inherited by routes', (
    tester,
  ) async {
    final repository = TrophyRepository(storage: MemorySnapshotStorage());
    await repository.importJson(jsonEncode(localized()));
    await tester.pumpWidget(PlatinumApp(repository: repository));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Настройки').last);
    await tester.pumpAndSettle();
    await tester.scrollUntilVisible(
      find.text('Оригинал'),
      250,
      scrollable: find
          .descendant(
            of: find.byType(SettingsPage),
            matching: find.byType(Scrollable),
          )
          .first,
    );
    await tester.tap(find.text('Оригинал'));
    await tester.pumpAndSettle();
    expect(
      TrophyLanguage.useRussian(tester.element(find.byType(SettingsPage))),
      false,
    );
    await tester.tap(find.text('Русский'));
    await tester.pumpAndSettle();
    expect(
      TrophyLanguage.useRussian(tester.element(find.byType(SettingsPage))),
      true,
    );
    expect(repository.games.single.summary.earned, 1);
  });
  testWidgets(
    'language toggles official text without changing progress and preference survives a new host',
    (tester) async {
      String saved = 'ru';
      const channel = MethodChannel('platinum_companion/preferences');
      tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(channel, (
        call,
      ) async {
        if (call.method == 'readTrophyLanguage') return saved;
        if (call.method == 'writeTrophyLanguage') {
          saved = call.arguments['language'] as String;
        }
        return null;
      });
      addTearDown(
        () => tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(
          channel,
          null,
        ),
      );
      final g = SnapshotCodec.decode(jsonEncode(localized())).games.single;
      Widget app() => MaterialApp(
        builder: (_, child) => TrophyLanguageHost(child: child!),
        home: Builder(
          builder: (context) => Column(
            children: [
              TextButton(
                onPressed: () =>
                    TrophyLanguage.of(context)!
                        .onChanged(!TrophyLanguage.useRussian(context)),
                child: const Text('Switch'),
              ),
              Expanded(
                child: TrophyPage(
                  game: g,
                  trophy: g.trophies.first,
                  revealed: true,
                  onReveal: () {},
                ),
              ),
            ],
          ),
        ),
      );
      await tester.pumpWidget(app());
      await tester.pumpAndSettle();
      expect(find.text('Тестовое русское название'), findsOneWidget);
      await tester.tap(find.text('Switch'));
      await tester.pumpAndSettle();
      expect(find.text('Synthetic original'), findsOneWidget);
      expect(saved, 'original');
      await tester.pumpWidget(const SizedBox());
      await tester.pumpWidget(app());
      await tester.pumpAndSettle();
      expect(find.text('Synthetic original'), findsOneWidget);
      expect(g.summary.earned, 1);
      expect(tester.takeException(), isNull);
    },
  );
}
