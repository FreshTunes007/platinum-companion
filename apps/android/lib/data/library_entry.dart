import 'artwork_cache.dart';
import 'models.dart';

class LibraryEntry {
  LibraryEntry(this.value);
  final Map<String, dynamic> value;
  String get gameId => value['gameId'] as String;
  String get id => value['id'] as String;
  bool get active => value['active'] == true;
  bool get complete => value['catalogComplete'] == true;
  String get title => value['title'] as String;
  String get platform => value['platform'] as String;
  ArtworkMetadata? get artwork => value['artwork'] is Map<String, dynamic>
      ? ArtworkMetadata(value['artwork'])
      : null;
  GameRecord get preview {
    final summary = value['summary'] as Map;
    return GameRecord(
      id: id,
      title: title,
      platform: platform,
      source: value['source'] as String,
      observedAt:
          DateTime.tryParse(value['observedAt'] as String? ?? '') ??
          DateTime.fromMillisecondsSinceEpoch(0, isUtc: true),
      sony: SonyGameIdentity(
        npCommunicationId: value['sony']['npCommunicationId'] as String,
        service: value['sony']['service'] as String,
      ),
      coverUrl: null,
      artwork: artwork,
      groups: [],
      trophies: [],
      summary: TrophySummary(
        earned: summary['earned'] as int,
        total: summary['total'] as int,
        unknown: complete
            ? 0
            : (summary['total'] as int) - (summary['earned'] as int),
        platinumTotal: summary['platinumTotal'] as int,
        platinumEarned: summary['platinumEarned'] as int,
      ),
    );
  }

  static LibraryEntry parse(dynamic raw) {
    if (raw is! Map<String, dynamic> ||
        raw['gameId'] is! String ||
        !RegExp(r'^[a-f0-9]{24}$').hasMatch(raw['gameId'] as String) ||
        raw['title'] is! String ||
        raw['platform'] is! String ||
        raw['id'] is! String ||
        raw['active'] is! bool ||
        raw['catalogComplete'] is! bool ||
        raw['source'] is! String ||
        raw['sony'] is! Map ||
        raw['summary'] is! Map) {
      throw const FormatException('invalid_library_index');
    }
    final s = raw['summary'] as Map;
    final sony = raw['sony'] as Map;
    if (!['PS4', 'PS5', 'PS3', 'PSVITA'].contains(raw['platform']) ||
        ![
          'direct_psn_api',
          'imported',
          'sony_inventory',
        ].contains(raw['source']) ||
        sony['npCommunicationId'] is! String ||
        !RegExp(r'^NPWR\d{5,8}_\d{2}$')
            .hasMatch(sony['npCommunicationId'] as String) ||
        sony['service'] != (raw['platform'] == 'PS5' ? 'trophy2' : 'trophy') ||
        raw['id'] != 'psn:${sony['npCommunicationId']}:${raw['platform']}' ||
        raw['observedAt'] != null &&
            (raw['observedAt'] is! String ||
                DateTime.tryParse(raw['observedAt'] as String) == null)) {
      throw const FormatException('invalid_library_index');
    }
    for (final key in ['total', 'earned', 'platinumTotal', 'platinumEarned']) {
      if (s[key] is! int || (s[key] as int) < 0) {
        throw const FormatException('invalid_library_index');
      }
    }
    if ((s['earned'] as int) > (s['total'] as int) ||
        (s['platinumEarned'] as int) > (s['platinumTotal'] as int)) {
      throw const FormatException('invalid_library_index');
    }
    return LibraryEntry({
      for (final key in [
        'gameId',
        'id',
        'title',
        'platform',
        'active',
        'catalogComplete',
        'source',
        'observedAt',
        'sony',
        'summary',
        'iconUrl',
        'artwork',
        'lastError',
      ])
        key: raw[key],
    });
  }
}
