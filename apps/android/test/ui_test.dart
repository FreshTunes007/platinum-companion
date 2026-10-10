import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:platinum_companion/data/data.dart';
import 'package:platinum_companion/ui/app.dart';
import 'package:platinum_companion/ui/game_page.dart';
import 'package:platinum_companion/ui/trophy_page.dart';
import 'package:platinum_companion/ui/theme.dart';

import 'data_test.dart'
    show MemorySnapshotStorage, syntheticSnapshot, syntheticSnapshotJson;

class _Picker implements SnapshotFilePicker {
  String? value;
  int calls = 0;
  @override
  Future<String?> pickSnapshot() async {
    calls++;
    return value;
  }
}

void _phone(WidgetTester tester, {double width = 430}) {
  tester.view.physicalSize = Size(width, 980);
  tester.view.devicePixelRatio = 1;
  addTearDown(tester.view.resetPhysicalSize);
  addTearDown(tester.view.resetDevicePixelRatio);
}

Future<TrophyRepository> _repository({
  bool populated = true,
  _Picker? picker,
  MemorySnapshotStorage? storage,
}) async {
  final repository = TrophyRepository(
    storage: storage ?? MemorySnapshotStorage(),
    picker: picker,
  );
  await repository.initialize();
  if (populated) await repository.importJson(syntheticSnapshotJson());
  addTearDown(repository.dispose);
  return repository;
}

Future<void> _visible(WidgetTester tester, Finder target) async {
  await tester.scrollUntilVisible(
    target,
    260,
    scrollable: find.byType(Scrollable).first,
    maxScrolls: 30,
  );
  await tester.pumpAndSettle();
}

void main() {
  testWidgets('unknown platinum remains unknown in library and game summary', (
    tester,
  ) async {
    _phone(tester);
    final repository = await _repository(populated: false);
    final json = syntheticSnapshot();
    final gameJson = (json['games'] as List).single as Map<String, dynamic>;
    ((gameJson['trophies'] as List)[1] as Map<String, dynamic>)['earned'] =
        null;
    (gameJson['summary'] as Map<String, dynamic>)['unknown'] = 2;
    await repository.importJson(jsonEncode(json));
    expect(repository.error, isNull);
    await tester.pumpWidget(PlatinumApp(repository: repository));
    await tester.pumpAndSettle();
    expect(find.text('Статус платины неизвестен'), findsOneWidget);
    expect(find.text('Платина впереди'), findsNothing);
    expect(find.text('Не получены 0'), findsOneWidget);
    expect(find.text('У 2 трофеев статус неизвестен'), findsOneWidget);
    expect(find.text('Осталось 2'), findsNothing);
    await tester.tap(
      find.byKey(ValueKey('game-${repository.games.single.id}')),
    );
    await tester.pumpAndSettle();
    expect(find.text('Статус платины неизвестен'), findsOneWidget);
    expect(find.text('Платина ещё не получена'), findsNothing);
    expect(
      find.textContaining('не получены 0 · статус неизвестен 2'),
      findsOneWidget,
    );
    expect(find.textContaining('осталось 2'), findsNothing);
    expect(tester.takeException(), isNull);
  });

  testWidgets(
    'empty install requests explicit import consent and never displays sample games',
    (tester) async {
      _phone(tester);
      final picker = _Picker();
      final repository = await _repository(populated: false, picker: picker);
      await tester.pumpWidget(PlatinumApp(repository: repository));
      await tester.pumpAndSettle();
      expect(find.text('Каждая платина\nначинается здесь.'), findsOneWidget);
      expect(find.text('Синтетическая игра'), findsNothing);
      await tester.tap(find.byKey(const Key('empty-import')));
      await tester.pumpAndSettle();
      expect(find.text('Импорт личного прогресса'), findsOneWidget);
      expect(picker.calls, 0);
      await tester.tap(find.text('Отмена'));
      await tester.pumpAndSettle();
      expect(picker.calls, 0);
      expect(repository.games, isEmpty);
    },
  );

  testWidgets(
    'library renders imported counts and source date; search filters real model',
    (tester) async {
      _phone(tester);
      final repository = await _repository();
      await tester.pumpWidget(PlatinumApp(repository: repository));
      await tester.pumpAndSettle();
      expect(find.text('Синтетическая игра'), findsOneWidget);
      expect(find.text('1 / 3'), findsWidgets);
      expect(
        find.textContaining('PSN · из снимка · 02.01.2026'),
        findsOneWidget,
      );
      expect(find.text('На устройстве'), findsOneWidget);
      await tester.enterText(
        find.byKey(const Key('library-search')),
        'нет такой игры',
      );
      await tester.pumpAndSettle();
      expect(find.text('Синтетическая игра'), findsNothing);
      expect(find.textContaining('Такой игры пока нет'), findsOneWidget);
      await tester.enterText(
        find.byKey(const Key('library-search')),
        'Синтетическая',
      );
      await tester.pumpAndSettle();
      expect(find.text('Синтетическая игра'), findsOneWidget);
      expect(tester.takeException(), isNull);
    },
  );

  testWidgets(
    'unearned filter excludes unknown and earned; hidden content is revealed explicitly',
    (tester) async {
      _phone(tester);
      final repository = await _repository();
      final game = repository.games.single;
      await tester.pumpWidget(
        MaterialApp(
          theme: companionTheme(Brightness.dark),
          home: GamePage(game: game),
        ),
      );
      await tester.pumpAndSettle();
      await _visible(tester, find.byKey(const Key('filter-unearned')));
      await tester.tap(find.byKey(const Key('filter-unearned')));
      await tester.pumpAndSettle();
      final hidden = find.byKey(ValueKey('trophy-${game.trophies[1].id}'));
      await _visible(tester, hidden);
      expect(
        find.byKey(ValueKey('trophy-${game.trophies[0].id}')),
        findsNothing,
      );
      expect(
        find.byKey(ValueKey('trophy-${game.trophies[2].id}')),
        findsNothing,
      );
      expect(find.text('Мастер'), findsNothing);
      expect(find.text('Собрать тестовые трофеи.'), findsNothing);
      await tester.tap(hidden);
      await tester.pumpAndSettle();
      expect(find.text('Скрытый трофей'), findsOneWidget);
      await tester.tap(find.byKey(const Key('reveal-trophy')));
      await tester.pumpAndSettle();
      expect(find.text('Мастер'), findsOneWidget);
      expect(find.text('Собрать тестовые трофеи.'), findsOneWidget);
      expect(find.text('Не получен'), findsOneWidget);
      expect(tester.takeException(), isNull);
    },
  );

  testWidgets(
    'missing hidden description and unknown earned state are shown honestly',
    (tester) async {
      _phone(tester);
      final repository = await _repository();
      final game = repository.games.single;
      await tester.pumpWidget(
        MaterialApp(
          theme: companionTheme(Brightness.dark),
          home: TrophyPage(
            game: game,
            trophy: game.trophies.last,
            revealed: false,
            onReveal: () {},
          ),
        ),
      );
      await tester.pumpAndSettle();
      expect(find.text('Статус неизвестен'), findsOneWidget);
      await tester.tap(find.byKey(const Key('reveal-trophy')));
      await tester.pumpAndSettle();
      expect(
        find.text('Описание отсутствует в снимке. Условие не подтверждено.'),
        findsOneWidget,
      );
      expect(find.text('Получен'), findsNothing);
      expect(find.text('Не получен'), findsNothing);
      expect(find.text('Дополнение 1 (название не указано)'), findsOneWidget);
      expect(find.textContaining('Дополнение · psn:'), findsNothing);
    },
  );

  testWidgets(
    'repeat import picker cancellation preserves existing snapshot and freshness',
    (tester) async {
      _phone(tester);
      final picker = _Picker();
      final repository = await _repository(picker: picker);
      final snapshot = repository.snapshot;
      final importedAt = repository.importedAt;
      await tester.pumpWidget(PlatinumApp(repository: repository));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Настройки'));
      await tester.pumpAndSettle();
      expect(find.text('Офлайн-режим'), findsOneWidget);
      await tester.ensureVisible(find.byKey(const Key('settings-import')));
      await tester.tap(find.byKey(const Key('settings-import')));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Выбрать файл'));
      await tester.pumpAndSettle();
      expect(picker.calls, 1);
      expect(repository.snapshot, same(snapshot));
      expect(repository.importedAt, importedAt);
      expect(repository.error, isNull);
      expect(find.textContaining('Этот прогресс уже сохранён.'), findsNothing);
    },
  );

  testWidgets(
    'offline restart renders persisted library without any file picker or network',
    (tester) async {
      _phone(tester);
      final storage = MemorySnapshotStorage();
      final first = await _repository(storage: storage);
      final observed = first.games.single.observedAt;
      final next = await _repository(storage: storage, populated: false);
      await tester.pumpWidget(PlatinumApp(repository: next));
      await tester.pumpAndSettle();
      expect(find.text('Синтетическая игра'), findsOneWidget);
      expect(find.text('На устройстве'), findsOneWidget);
      expect(next.games.single.observedAt, observed);
      expect(next.games.single.summary.earned, 1);
      expect(tester.takeException(), isNull);
    },
  );

  testWidgets('library supports a narrow display without overflow', (
    tester,
  ) async {
    _phone(tester, width: 320);
    final repository = await _repository();
    await tester.pumpWidget(PlatinumApp(repository: repository));
    await tester.pumpAndSettle();
    await _visible(tester, find.text('Синтетическая игра'));
    expect(tester.takeException(), isNull);
  });
}
