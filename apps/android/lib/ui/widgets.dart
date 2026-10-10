import 'dart:math' as math;

import 'package:flutter/material.dart';

String displayDate(DateTime? value, {bool withTime = true}) {
  if (value == null) return 'Дата неизвестна';
  final local = value.toLocal();
  String two(int number) => number.toString().padLeft(2, '0');
  final day = '${two(local.day)}.${two(local.month)}.${local.year}';
  return withTime ? '$day, ${two(local.hour)}:${two(local.minute)}' : day;
}

String sourceLabel(String source) => switch (source) {
  'direct_psn_api' => 'PSN · из снимка',
  'stratege_session_snapshot' => 'Снимок Stratege',
  'imported' => 'Импортированный источник',
  _ => source,
};

String gradeLabel(String grade) => switch (grade) {
  'platinum' => 'Платиновый',
  'gold' => 'Золотой',
  'silver' => 'Серебряный',
  'bronze' => 'Бронзовый',
  _ => 'Тип неизвестен',
};

Color gradeColor(String grade) => switch (grade) {
  'platinum' => const Color(0xFF9EC9FF),
  'gold' => const Color(0xFFE7BA62),
  'silver' => const Color(0xFFB6C5DD),
  'bronze' => const Color(0xFFCB917C),
  _ => const Color(0xFF93A0B7),
};

class SourcePill extends StatelessWidget {
  const SourcePill({
    super.key,
    required this.label,
    this.icon = Icons.offline_bolt_outlined,
  });
  final String label;
  final IconData icon;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 6),
      decoration: BoxDecoration(
        color: scheme.primary.withValues(alpha: .1),
        borderRadius: BorderRadius.circular(10),
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          Icon(icon, size: 14, color: scheme.primary),
          const SizedBox(width: 6),
          Flexible(
            child: Text(
              label,
              style: Theme.of(context).textTheme.labelSmall
                  ?.copyWith(color: scheme.primary),
            ),
          ),
        ],
      ),
    );
  }
}

class TrophyBadge extends StatelessWidget {
  const TrophyBadge({
    super.key,
    required this.grade,
    this.size = 46,
    this.earned,
  });
  final String grade;
  final double size;
  final bool? earned;

  @override
  Widget build(BuildContext context) {
    final color = gradeColor(grade);
    return Semantics(
      label: gradeLabel(grade),
      child: Container(
        width: size,
        height: size,
        decoration: BoxDecoration(
          borderRadius: BorderRadius.circular(size * .3),
          gradient: LinearGradient(
            begin: Alignment.topLeft,
            end: Alignment.bottomRight,
            colors: [
              color.withValues(alpha: .22),
              color.withValues(alpha: .07),
            ],
          ),
          border: Border.all(color: color.withValues(alpha: .18)),
        ),
        child: Icon(
          grade == 'platinum'
              ? Icons.workspace_premium_rounded
              : Icons.emoji_events_rounded,
          size: size * .55,
          color: earned == false ? color.withValues(alpha: .65) : color,
        ),
      ),
    );
  }
}

/// Local artwork, not a publisher cover: no network requests or licensed assets.
class GameArtwork extends StatelessWidget {
  const GameArtwork({
    super.key,
    required this.seed,
    this.height = 124,
    this.width,
    this.radius = 20,
    this.large = false,
  });
  final String seed;
  final double height;
  final double? width;
  final double radius;
  final bool large;

  @override
  Widget build(BuildContext context) {
    final hash = seed.codeUnits.fold(
      0,
      (result, value) => (result * 31 + value) & 0x7fffffff,
    );
    final hue = (hash % 280 + 170) % 360;
    final first = HSLColor.fromAHSL(1, hue.toDouble(), .46, .24).toColor();
    final second = HSLColor.fromAHSL(
      1,
      ((hue + 45) % 360).toDouble(),
      .56,
      .1,
    ).toColor();
    return ExcludeSemantics(
      child: ClipRRect(
        borderRadius: BorderRadius.circular(radius),
        child: Container(
          width: width,
          height: height,
          decoration: BoxDecoration(
            gradient: LinearGradient(
              begin: Alignment.topLeft,
              end: Alignment.bottomRight,
              colors: [first, second],
            ),
          ),
          child: CustomPaint(
            painter: _ArtworkPainter(hash, first),
            child: Center(
              child: Icon(
                Icons.workspace_premium_outlined,
                size: large ? 84 : 42,
                color: Colors.white.withValues(alpha: .8),
              ),
            ),
          ),
        ),
      ),
    );
  }
}

class _ArtworkPainter extends CustomPainter {
  _ArtworkPainter(this.seed, this.color);
  final int seed;
  final Color color;

  @override
  void paint(Canvas canvas, Size size) {
    final random = math.Random(seed);
    final line = Paint()
      ..color = Colors.white.withValues(alpha: .1)
      ..strokeWidth = 1.2
      ..style = PaintingStyle.stroke;
    for (var i = 0; i < 7; i++) {
      final offset = (i - 2) * size.width * .22;
      final path = Path()
        ..moveTo(offset, -20)
        ..cubicTo(
          offset + size.width * .8,
          size.height * .3,
          offset - size.width * .1,
          size.height * .65,
          offset + size.width * .45,
          size.height + 30,
        );
      canvas.drawPath(path, line);
    }
    final glow = Paint()..color = Colors.white.withValues(alpha: .055);
    canvas.drawCircle(
      Offset(size.width * .9, size.height * .2),
      size.height * .7,
      glow,
    );
    for (var i = 0; i < 10; i++) {
      canvas.drawCircle(
        Offset(
          random.nextDouble() * size.width,
          random.nextDouble() * size.height,
        ),
        1.5,
        Paint()..color = Colors.white.withValues(alpha: .12),
      );
    }
  }

  @override
  bool shouldRepaint(covariant _ArtworkPainter oldDelegate) =>
      oldDelegate.seed != seed || oldDelegate.color != color;
}

class InfoCard extends StatelessWidget {
  const InfoCard({
    super.key,
    required this.title,
    required this.body,
    this.icon = Icons.info_outline_rounded,
    this.trailing,
  });
  final String title;
  final String body;
  final IconData icon;
  final Widget? trailing;

  @override
  Widget build(BuildContext context) => Card(
    child: Padding(
      padding: const EdgeInsets.all(18),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Icon(icon, color: Theme.of(context).colorScheme.primary, size: 22),
          const SizedBox(width: 12),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  title,
                  style: Theme.of(context).textTheme.titleSmall
                      ?.copyWith(fontWeight: FontWeight.w700),
                ),
                const SizedBox(height: 6),
                Text(
                  body,
                  style: Theme.of(context).textTheme.bodySmall?.copyWith(
                    color: Theme.of(context).colorScheme.onSurfaceVariant,
                  ),
                ),
                if (trailing != null)
                  Padding(
                    padding: const EdgeInsets.only(top: 12),
                    child: trailing,
                  ),
              ],
            ),
          ),
        ],
      ),
    ),
  );
}

class DetailRow extends StatelessWidget {
  const DetailRow(this.label, this.value, {super.key, this.selectable = false});
  final String label;
  final String value;
  final bool selectable;

  @override
  Widget build(BuildContext context) => Padding(
    padding: const EdgeInsets.symmetric(vertical: 10),
    child: Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(
          label,
          style: Theme.of(context).textTheme.labelMedium
              ?.copyWith(color: Theme.of(context).colorScheme.onSurfaceVariant),
        ),
        const SizedBox(height: 3),
        if (selectable)
          SelectableText(value, style: Theme.of(context).textTheme.bodyMedium)
        else
          Text(value, style: Theme.of(context).textTheme.bodyMedium),
      ],
    ),
  );
}

class SectionTitle extends StatelessWidget {
  const SectionTitle(this.title, {super.key, this.trailing});
  final String title;
  final Widget? trailing;

  @override
  Widget build(BuildContext context) => Row(
    children: [
      Expanded(
        child: Text(title, style: Theme.of(context).textTheme.titleLarge),
      ),
      ?trailing,
    ],
  );
}

class ProgressBar extends StatelessWidget {
  const ProgressBar({super.key, required this.earned, required this.total});
  final int earned;
  final int total;

  @override
  Widget build(BuildContext context) => Semantics(
    label: 'Получено $earned из $total трофеев',
    child: LinearProgressIndicator(
      value: total == 0 ? 0 : (earned / total).clamp(0, 1),
    ),
  );
}

class EmptyResults extends StatelessWidget {
  const EmptyResults({super.key, required this.message});
  final String message;

  @override
  Widget build(BuildContext context) => Padding(
    padding: const EdgeInsets.symmetric(horizontal: 24, vertical: 40),
    child: Column(
      children: [
        Icon(
          Icons.search_off_rounded,
          size: 42,
          color: Theme.of(context).colorScheme.onSurfaceVariant,
        ),
        const SizedBox(height: 14),
        Text(
          message,
          textAlign: TextAlign.center,
          style: Theme.of(context).textTheme.bodyMedium,
        ),
      ],
    ),
  );
}
