import 'dart:io';

import 'package:flutter/material.dart';

import '../data/artwork_cache.dart';
import '../data/models.dart';
import 'widgets.dart' show GameArtwork, TrophyBadge;

class ArtworkScope extends InheritedWidget {
  const ArtworkScope({super.key, required this.cache, required super.child});
  final ArtworkCache cache;
  static ArtworkCache? maybeOf(BuildContext context) =>
      context.dependOnInheritedWidgetOfExactType<ArtworkScope>()?.cache;
  @override
  bool updateShouldNotify(ArtworkScope oldWidget) => oldWidget.cache != cache;
}

class OfficialImage extends StatefulWidget {
  const OfficialImage({
    super.key,
    required this.url,
    required this.placeholder,
    required this.width,
    required this.height,
    this.radius = 12,
    this.fit = BoxFit.contain,
  });
  final String? url;
  final Widget placeholder;
  final double width, height, radius;
  final BoxFit fit;
  @override
  State<OfficialImage> createState() => _OfficialImageState();
}

class _OfficialImageState extends State<OfficialImage> {
  Future<File?>? _file;
  ArtworkCache? _cache;
  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    final next = ArtworkScope.maybeOf(context);
    if (next != _cache) {
      _cache = next;
      _file = next?.load(widget.url);
    }
  }

  @override
  void didUpdateWidget(OfficialImage oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.url != widget.url) _file = _cache?.load(widget.url);
  }

  @override
  Widget build(BuildContext context) => ClipRRect(
    borderRadius: BorderRadius.circular(widget.radius),
    child: SizedBox(
      width: widget.width,
      height: widget.height,
      child: FutureBuilder<File?>(
        future: _file,
        builder: (context, snapshot) {
          if (snapshot.data == null) return widget.placeholder;
          final target = widget.width.isFinite
              ? (widget.width * MediaQuery.devicePixelRatioOf(context))
                    .ceil()
                    .clamp(64, 1280)
              : 1280;
          return Image.file(
            snapshot.data!,
            fit: widget.fit,
            cacheWidth: target,
            errorBuilder: (_, error, stack) => widget.placeholder,
            frameBuilder: (context, child, frame, synchronous) =>
                AnimatedOpacity(
                  opacity: frame == null ? 0 : 1,
                  duration: const Duration(milliseconds: 160),
                  child: child,
                ),
          );
        },
      ),
    ),
  );
}

class OfficialGameArtwork extends StatelessWidget {
  const OfficialGameArtwork({
    super.key,
    required this.game,
    required this.width,
    required this.height,
    this.radius = 16,
    this.large = false,
  });
  final GameRecord game;
  final double width, height, radius;
  final bool large;
  @override
  Widget build(BuildContext context) {
    final art = game.artwork, cover = art?.cover;
    final url = large
        ? (art?.hero ?? cover ?? art?.gameIcon ?? art?.titleIcon)
        : (cover ?? art?.gameIcon ?? art?.titleIcon);
    return Semantics(
      label: cover != null ? 'Официальная обложка' : 'Официальная иконка',
      child: ColoredBox(
        color: const Color(0xFF141F31),
        child: OfficialImage(
          url: url,
          width: width,
          height: height,
          radius: radius,
          fit: cover != null || large && art?.hero != null
              ? BoxFit.cover
              : BoxFit.contain,
          placeholder: GameArtwork(
            seed: game.id,
            width: width,
            height: height,
            radius: radius,
            large: large,
          ),
        ),
      ),
    );
  }
}

class OfficialTrophyIcon extends StatelessWidget {
  const OfficialTrophyIcon({
    super.key,
    required this.trophy,
    this.size = 52,
    this.concealed = false,
  });
  final TrophyRecord trophy;
  final double size;
  final bool concealed;
  @override
  Widget build(BuildContext context) {
    if (concealed) {
      return SizedBox(
        width: size,
        height: size,
        child: const Icon(Icons.lock_outline_rounded, color: Color(0xFF8F9DB5)),
      );
    }
    return Stack(
      children: [
        OfficialImage(
          url: trophy.official?.iconUrl,
          width: size,
          height: size,
          placeholder: TrophyBadge(
            grade: trophy.grade.name,
            size: size,
            earned: trophy.earned,
          ),
        ),
        if (trophy.isEarned)
          const Positioned(
            right: 0,
            bottom: 0,
            child: Icon(
              Icons.check_circle_rounded,
              color: Color(0xFF68DECB),
              size: 18,
            ),
          ),
      ],
    );
  }
}
