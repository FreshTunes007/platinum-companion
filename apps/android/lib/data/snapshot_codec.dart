import 'dart:convert';

import 'models.dart';

class SnapshotFormatException implements Exception {
  const SnapshotFormatException(this.message);
  final String message;

  @override
  String toString() => message;
}

class SnapshotCodec {
  static const maxBytes = 64 * 1024 * 1024;
  static const maxGames = 2000;
  static const maxTrophiesPerGame = 10000;

  static TrophySnapshot decode(String json) {
    if (json.length > maxBytes || utf8.encode(json).length > maxBytes) {
      throw const SnapshotFormatException('Файл превышает допустимые 64 МБ.');
    }
    Object? decoded;
    try {
      decoded = jsonDecode(json);
    } on FormatException {
      throw const SnapshotFormatException('Файл не является корректным JSON.');
    }
    final root = _object(decoded, 'снимок', const {
      'schemaVersion',
      'exportedAt',
      'kind',
      'games',
    });
    if (!const [1, 2].contains(root['schemaVersion']) ||
        root['schemaVersion'] is! int) {
      throw const SnapshotFormatException(
        'Версия формата снимка не поддерживается.',
      );
    }
    if (root['kind'] != TrophySnapshot.kind) {
      throw const SnapshotFormatException('Это не снимок Platinum Companion.');
    }
    final exportedAt = _date(root['exportedAt'], 'дата экспорта');
    final rawGames = _list(root['games'], 'игры', maxGames);
    final ids = <String>{};
    final identities = <String>{};
    final games = <GameRecord>[];
    for (var index = 0; index < rawGames.length; index++) {
      final game = _game(
        rawGames[index],
        index + 1,
        root['schemaVersion'] as int,
      );
      if (!ids.add(game.id)) _fail('Повторяется идентификатор игры.');
      final identity =
          '${game.sony.npCommunicationId}:${game.sony.service}:${game.platform}';
      if (!identities.add(identity)) {
        _fail('Один набор Sony указан несколько раз.');
      }
      if (game.observedAt.isAfter(exportedAt)) {
        _fail('Дата наблюдения игры позже даты экспорта.');
      }
      games.add(game);
    }
    return TrophySnapshot(exportedAt: exportedAt, games: games);
  }

  static String encode(TrophySnapshot snapshot) =>
      jsonEncode(snapshot.toJson());

  static GameRecord _game(Object? value, int number, int version) {
    final path = 'игра $number';
    final data = _object(value, path, const {
      'id',
      'title',
      'platform',
      'source',
      'observedAt',
      'sony',
      'coverUrl',
      'groups',
      'trophies',
      'summary',
    });
    final id = _id(data['id'], '$path: id');
    final title = _text(data['title'], '$path: название', max: 500);
    final platform = _text(data['platform'], '$path: платформа', max: 64);
    if (!const {'PS5', 'PS4', 'PS3', 'PSVITA'}.contains(platform)) {
      _fail('$path: платформа не поддерживается.');
    }
    final source = _text(data['source'], '$path: источник', max: 32);
    if (source != 'direct_psn_api' && source != 'imported') {
      _fail('$path: неизвестный источник.');
    }
    final observedAt = _date(data['observedAt'], '$path: дата наблюдения');
    final sony = _object(data['sony'], '$path: Sony', const {
      'npCommunicationId',
      'service',
    });
    final sonyIdentity = SonyGameIdentity(
      npCommunicationId: _id(sony['npCommunicationId'], '$path: Sony set'),
      service: _id(sony['service'], '$path: Sony service'),
    );
    if (!RegExp(r'^NPWR\d{5,8}_\d{2}$')
            .hasMatch(sonyIdentity.npCommunicationId) ||
        sonyIdentity.service != (platform == 'PS5' ? 'trophy2' : 'trophy') ||
        id != 'psn:${sonyIdentity.npCommunicationId}:$platform') {
      _fail('$path: идентификаторы игры не соответствуют набору Sony.');
    }
    // This schema deliberately carries no remote cover URLs or account data.
    if (data['coverUrl'] != null) {
      _fail(
        '$path: обложки по внешним ссылкам в этом формате не поддерживаются.',
      );
    }
    final groups = <TrophyGroup>[];
    final groupIds = <String>{};
    for (final raw in _list(data['groups'], '$path: группы', 1000)) {
      final group = _object(raw, '$path: группа', const {'id', 'name', 'kind'});
      final groupId = _id(group['id'], '$path: id группы');
      if (!groupIds.add(groupId)) _fail('$path: повторяется группа.');
      if (!groupId.startsWith('$id:group:') ||
          groupId.length <= '$id:group:'.length) {
        _fail('$path: группа относится к другой игре.');
      }
      final kind = switch (group['kind']) {
        'base' => TrophyGroupKind.base,
        'dlc' => TrophyGroupKind.dlc,
        'additional' => TrophyGroupKind.additional,
        _ => throw SnapshotFormatException('$path: неизвестный вид группы.'),
      };
      groups.add(
        TrophyGroup(
          id: groupId,
          name: group['name'] == null
              ? null
              : _text(group['name'], '$path: название группы', max: 500),
          kind: kind,
        ),
      );
    }
    final trophies = <TrophyRecord>[];
    final trophyIds = <String>{};
    final sonyTrophyIds = <int>{};
    for (final raw in _list(
      data['trophies'],
      '$path: трофеи',
      maxTrophiesPerGame,
    )) {
      final trophy = _object(raw, '$path: трофей', {
        'id',
        'sonyTrophyId',
        'groupId',
        'name',
        'description',
        'grade',
        'hidden',
        'earned',
        'earnedAt',
        if (version == 2 && raw is Map && raw.containsKey('official'))
          'official',
      });
      final trophyId = _id(trophy['id'], '$path: id трофея');
      if (!trophyIds.add(trophyId)) _fail('$path: повторяется трофей.');
      final sonyId = trophy['sonyTrophyId'];
      if (sonyId != null && (sonyId is! int || sonyId < 0 || sonyId > 999999)) {
        _fail('$path: неверный идентификатор трофея Sony.');
      }
      if (!trophyId.startsWith('$id:trophy:') ||
          trophyId.length <= '$id:trophy:'.length ||
          (sonyId != null && trophyId != '$id:trophy:$sonyId')) {
        _fail('$path: идентификатор трофея не соответствует игре или Sony.');
      }
      if (sonyId is int && !sonyTrophyIds.add(sonyId)) {
        _fail('$path: повторяется идентификатор трофея Sony.');
      }
      final groupId = _id(trophy['groupId'], '$path: группа трофея');
      if (!groupIds.contains(groupId)) {
        _fail('$path: группа трофея не найдена.');
      }
      final grade = switch (trophy['grade']) {
        'bronze' => TrophyGrade.bronze,
        'silver' => TrophyGrade.silver,
        'gold' => TrophyGrade.gold,
        'platinum' => TrophyGrade.platinum,
        _ => throw SnapshotFormatException('$path: неизвестный тип трофея.'),
      };
      if (trophy['hidden'] is! bool) {
        _fail('$path: неверный признак скрытого трофея.');
      }
      final earned = trophy['earned'];
      if (earned != null && earned is! bool) {
        _fail('$path: неверный статус трофея.');
      }
      final earnedAt = trophy['earnedAt'] == null
          ? null
          : _date(trophy['earnedAt'], '$path: дата получения');
      if (earnedAt != null && earned != true) {
        _fail('$path: дата получения есть у неподтверждённого трофея.');
      }
      if (earnedAt != null && earnedAt.isAfter(observedAt)) {
        _fail('$path: трофей получен позже даты наблюдения.');
      }
      trophies.add(
        TrophyRecord(
          id: trophyId,
          sonyTrophyId: sonyId as int?,
          groupId: groupId,
          name: _text(trophy['name'], '$path: название трофея', max: 1000),
          description: _nullableText(
            trophy['description'],
            '$path: описание',
            max: 10000,
          ),
          grade: grade,
          hidden: trophy['hidden'] as bool,
          earned: earned as bool?,
          earnedAt: earnedAt,
          official: trophy['official'] == null
              ? null
              : _official(
                  trophy['official'],
                  exportedLimit: observedAt,
                  name: trophy['name'],
                  description: trophy['description'],
                ),
        ),
      );
    }
    if (groups.any(
      (group) => !trophies.any((trophy) => trophy.groupId == group.id),
    )) {
      _fail('$path: группа не содержит трофеев.');
    }
    final rawSummary = _object(data['summary'], '$path: итог', const {
      'earned',
      'total',
      'unknown',
      'platinumEarned',
      'platinumTotal',
    });
    final expected = <String, int>{
      'earned': trophies.where((trophy) => trophy.isEarned).length,
      'total': trophies.length,
      'unknown': trophies.where((trophy) => trophy.isUnknown).length,
      'platinumEarned': trophies
          .where(
            (trophy) => trophy.grade == TrophyGrade.platinum && trophy.isEarned,
          )
          .length,
      'platinumTotal': trophies
          .where((trophy) => trophy.grade == TrophyGrade.platinum)
          .length,
    };
    for (final field in expected.keys) {
      if (rawSummary[field] is! int || rawSummary[field] != expected[field]) {
        _fail('$path: итоговые числа не совпадают с трофеями.');
      }
    }
    return GameRecord(
      id: id,
      title: title,
      platform: platform,
      source: source,
      observedAt: observedAt,
      sony: sonyIdentity,
      coverUrl: null,
      groups: groups,
      trophies: trophies,
      summary: TrophySummary(
        earned: expected['earned']!,
        total: expected['total']!,
        unknown: expected['unknown']!,
        platinumEarned: expected['platinumEarned']!,
        platinumTotal: expected['platinumTotal']!,
      ),
    );
  }

  static OfficialMetadata _official(
    Object? value, {
    required DateTime exportedLimit,
    required Object? name,
    required Object? description,
  }) {
    final data = _object(value, 'официальный текст', {
      'iconUrl',
      'originalLocale',
      'localizations',
    });
    if (data['originalLocale'] != 'en-US') _fail('Неизвестный исходный язык.');
    final icon = data['iconUrl'];
    if (icon != null &&
        (icon is! String ||
            icon.length > 2048 ||
            Uri.tryParse(icon)?.scheme != 'https')) {
      _fail('Неверный адрес значка.');
    }
    final variants = data['localizations'];
    if (variants is! Map<String, dynamic> ||
        !variants.containsKey('en-US') ||
        variants.keys.any((key) => !{'en-US', 'ru-RU'}.contains(key))) {
      _fail('Неверные языковые варианты.');
    }
    for (final variant in variants.values) {
      final text = _object(variant, 'локализация', {
        'name',
        'description',
        'source',
        'observedAt',
      });
      _nullableText(text['name'], 'название', max: 1000);
      _nullableText(text['description'], 'условие', max: 10000);
      if (text['source'] != 'sony_catalog' ||
          _date(text['observedAt'], 'дата каталога').isAfter(exportedLimit)) {
        _fail('Неверный источник каталога.');
      }
    }
    if (variants['en-US']['name'] != name ||
        variants['en-US']['description'] != description) {
      _fail('Исходный текст не совпадает.');
    }
    return OfficialMetadata(data);
  }

  static Map<String, dynamic> _object(
    Object? value,
    String path,
    Set<String> keys,
  ) {
    if (value is! Map<String, dynamic>) _fail('$path: ожидается объект.');
    final map = value;
    if (map.length != keys.length || !keys.every(map.containsKey)) {
      // Never echo untrusted field names or values: extra keys may be secrets.
      _fail('$path: состав полей не соответствует безопасной схеме.');
    }
    return map;
  }

  static List<dynamic> _list(Object? value, String path, int maximum) {
    if (value is! List || value.isEmpty || value.length > maximum) {
      _fail('$path: неверный размер списка.');
    }
    return value;
  }

  static String _text(Object? value, String path, {required int max}) {
    if (value is! String ||
        value.trim().isEmpty ||
        value.length > max ||
        value.contains('\u0000')) {
      _fail('$path: неверное текстовое значение.');
    }
    return value;
  }

  static String? _nullableText(Object? value, String path, {required int max}) {
    if (value == null) return null;
    if (value is! String || value.length > max || value.contains('\u0000')) {
      _fail('$path: неверное текстовое значение.');
    }
    return value;
  }

  static String _id(Object? value, String path) {
    final id = _text(value, path, max: 128);
    if (!RegExp(r'^[A-Za-z0-9][A-Za-z0-9_.:-]*$').hasMatch(id)) {
      _fail('$path: неверный идентификатор.');
    }
    return id;
  }

  static DateTime _date(Object? value, String path) {
    if (value is! String) _fail('$path: ожидается дата UTC.');
    final text = value;
    final match = RegExp(
      r'^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?Z$',
    ).firstMatch(text);
    if (match == null) _fail('$path: ожидается дата UTC с суффиксом Z.');
    final parsed = DateTime.tryParse(text);
    if (parsed == null ||
        !parsed.isUtc ||
        parsed.year != int.parse(match.group(1)!) ||
        parsed.month != int.parse(match.group(2)!) ||
        parsed.day != int.parse(match.group(3)!) ||
        parsed.hour != int.parse(match.group(4)!) ||
        parsed.minute != int.parse(match.group(5)!) ||
        parsed.second != int.parse(match.group(6)!)) {
      _fail('$path: недопустимая дата.');
    }
    return parsed;
  }

  static Never _fail(String message) => throw SnapshotFormatException(message);
}
