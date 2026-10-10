import 'artwork_cache.dart' show ArtworkMetadata;

import 'dart:convert';

enum TrophyGrade { bronze, silver, gold, platinum }

enum TrophyGroupKind { base, dlc, additional }

class TrophyGroup {
  const TrophyGroup({required this.id, required this.name, required this.kind});

  final String id;
  final String? name;
  final TrophyGroupKind kind;

  Map<String, Object?> toJson() => {'id': id, 'name': name, 'kind': kind.name};
}

class TrophyRecord {
  const TrophyRecord({
    required this.id,
    required this.sonyTrophyId,
    required this.groupId,
    required this.name,
    required this.description,
    required this.grade,
    required this.hidden,
    required this.earned,
    required this.earnedAt,
    this.official,
  });

  final String id;
  final int? sonyTrophyId;
  final String groupId;
  final String name;
  final String? description;
  final TrophyGrade grade;
  final bool hidden;
  final bool? earned;
  final DateTime? earnedAt;
  final OfficialMetadata? official;

  String displayName(bool russian) =>
      (russian ? official?.russianName : null) ?? name;
  String? displayDescription(bool russian) =>
      (russian ? official?.russianDescription : null) ?? description;

  bool get isEarned => earned == true;
  bool get isUnearned => earned == false;
  bool get isUnknown => earned == null;

  Map<String, Object?> toJson() => {
    'id': id,
    'sonyTrophyId': sonyTrophyId,
    'groupId': groupId,
    'name': name,
    'description': description,
    'grade': grade.name,
    'hidden': hidden,
    'earned': earned,
    'earnedAt': earnedAt?.toUtc().toIso8601String(),
    if (official != null) 'official': official!.toJson(),
  };
}

class TrophySummary {
  const TrophySummary({
    required this.earned,
    required this.total,
    required this.unknown,
    required this.platinumEarned,
    required this.platinumTotal,
  });

  final int earned;
  final int total;
  final int unknown;
  final int platinumEarned;
  final int platinumTotal;

  // Unknown observations remain unknown, rather than becoming unearned.
  int get unearned => total - earned - unknown;
  int get remaining => total - earned;
  double get progress => total == 0 ? 0 : earned / total;
  bool get hasPlatinum => platinumTotal > 0;
  bool get platinumComplete => hasPlatinum && platinumEarned == platinumTotal;

  Map<String, Object?> toJson() => {
    'earned': earned,
    'total': total,
    'unknown': unknown,
    'platinumEarned': platinumEarned,
    'platinumTotal': platinumTotal,
  };
}

class SonyGameIdentity {
  const SonyGameIdentity({
    required this.npCommunicationId,
    required this.service,
  });

  final String npCommunicationId;
  final String service;

  Map<String, Object?> toJson() => {
    'npCommunicationId': npCommunicationId,
    'service': service,
  };
}

class GameRecord {
  final ArtworkMetadata? artwork;
  GameRecord withArtwork(ArtworkMetadata? value) => GameRecord(
    id: id,
    title: title,
    platform: platform,
    source: source,
    observedAt: observedAt,
    sony: sony,
    coverUrl: coverUrl,
    groups: groups,
    trophies: trophies,
    summary: summary,
    artwork: value,
  );
  GameRecord({
    required this.id,
    required this.title,
    required this.platform,
    required this.source,
    required this.observedAt,
    required this.sony,
    required this.coverUrl,
    required List<TrophyGroup> groups,
    required List<TrophyRecord> trophies,
    required this.summary,
    this.artwork,
  }) : groups = List.unmodifiable(groups),
       trophies = List.unmodifiable(trophies);

  final String id;
  final String title;
  final String platform;
  final String source;
  final DateTime observedAt;
  final SonyGameIdentity sony;
  final String? coverUrl;
  final List<TrophyGroup> groups;
  final List<TrophyRecord> trophies;
  final TrophySummary summary;

  TrophyGroup? groupById(String groupId) {
    for (final group in groups) {
      if (group.id == groupId) return group;
    }
    return null;
  }

  int gradeTotal(TrophyGrade grade) =>
      trophies.where((trophy) => trophy.grade == grade).length;

  int gradeEarned(TrophyGrade grade) => trophies
      .where((trophy) => trophy.grade == grade && trophy.isEarned)
      .length;

  Map<String, Object?> toJson() => {
    'id': id,
    'title': title,
    'platform': platform,
    'source': source,
    'observedAt': observedAt.toUtc().toIso8601String(),
    'sony': sony.toJson(),
    'coverUrl': coverUrl,
    'groups': groups.map((group) => group.toJson()).toList(),
    'trophies': trophies.map((trophy) => trophy.toJson()).toList(),
    'summary': summary.toJson(),
  };

  /// Stable across JSON formatting and list ordering; contains no account data.
  String get contentSignature {
    final data = toJson();
    data['groups'] = (groups.toList()..sort((a, b) => a.id.compareTo(b.id)))
        .map((group) => group.toJson())
        .toList();
    data['trophies'] = (trophies.toList()..sort((a, b) => a.id.compareTo(b.id)))
        .map((trophy) => trophy.toJson())
        .toList();
    return jsonEncode(data);
  }
}

class TrophySnapshot {
  TrophySnapshot({required this.exportedAt, required List<GameRecord> games})
    : games = List.unmodifiable(games);

  static const schemaVersion = 2;
  static const kind = 'platinum_companion_snapshot';
  final DateTime exportedAt;
  final List<GameRecord> games;

  DateTime? get latestObservation {
    DateTime? latest;
    for (final game in games) {
      if (latest == null || game.observedAt.isAfter(latest)) {
        latest = game.observedAt;
      }
    }
    return latest;
  }

  DateTime? get oldestObservation {
    DateTime? oldest;
    for (final game in games) {
      if (oldest == null || game.observedAt.isBefore(oldest)) {
        oldest = game.observedAt;
      }
    }
    return oldest;
  }

  Map<String, Object?> toJson() => {
    'schemaVersion': schemaVersion,
    'exportedAt': exportedAt.toUtc().toIso8601String(),
    'kind': kind,
    'games': games.map((game) => game.toJson()).toList(),
  };
}

/// Sony text only. Companion guidance belongs to a separate model.
class OfficialMetadata {
  OfficialMetadata(Map<String, dynamic> value)
    : _json = jsonDecode(jsonEncode(value)) as Map<String, dynamic>;
  final Map<String, dynamic> _json;
  String? get iconUrl => _json['iconUrl'] as String?;
  String? get russianName =>
      (_json['localizations']['ru-RU'] as Map?)?['name'] as String?;
  String? get russianDescription =>
      (_json['localizations']['ru-RU'] as Map?)?['description'] as String?;
  Map<String, dynamic> toJson() =>
      jsonDecode(jsonEncode(_json)) as Map<String, dynamic>;
}

/// Reserved integration contract; no unverified guides are shipped or displayed.
class CompanionGuide {
  const CompanionGuide({
    required this.trophyId,
    required this.steps,
    required this.missable,
    required this.difficulty,
    required this.requiresNgPlus,
    required this.dependencies,
    required this.spoilerLevel,
    required this.recommendedMoment,
    required this.sources,
  });
  final String trophyId;
  final List<String> steps;
  final bool? missable;
  final String? difficulty;
  final bool? requiresNgPlus;
  final List<String> dependencies;
  final String spoilerLevel;
  final String? recommendedMoment;
  final List<GuideEvidence> sources;
}

class GuideEvidence {
  const GuideEvidence({
    required this.url,
    required this.checkedAt,
    required this.verificationStatus,
  });
  final Uri url;
  final DateTime checkedAt;
  final String verificationStatus;
}
