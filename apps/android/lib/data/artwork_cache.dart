import 'dart:async';
import 'dart:collection';
import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';
import 'dart:ui' as ui;

import 'package:crypto/crypto.dart';
import 'package:flutter/services.dart';

const sonyImageHosts = {
  'image.api.playstation.com',
  'psnobj.prod.dl.playstation.net',
};
Uri? safeArtworkUri(String? value) {
  if (value == null || value.length > 2048) return null;
  final uri = Uri.tryParse(value);
  return uri != null &&
          uri.scheme == 'https' &&
          sonyImageHosts.contains(uri.host) &&
          uri.userInfo.isEmpty &&
          uri.port == 443 &&
          !uri.hasFragment
      ? uri
      : null;
}

class ImageDownload {
  ImageDownload(this.bytes, this.mime);
  final Uint8List bytes;
  final String mime;
}

typedef ImageFetcher = Future<ImageDownload> Function(Uri uri, int maxBytes);
Future<ImageDownload> downloadSonyImage(Uri uri, int maxBytes) async {
  final client = HttpClient()..connectionTimeout = const Duration(seconds: 8);
  try {
    return await (() async {
      final request = await client
          .getUrl(uri)
          .timeout(const Duration(seconds: 8));
      request.followRedirects = false;
      request.headers.set(
        HttpHeaders.acceptHeader,
        'image/png,image/jpeg,image/webp',
      );
      final response = await request.close().timeout(
        const Duration(seconds: 10),
      );
      final mime = response.headers.contentType?.mimeType ?? '';
      if (response.statusCode != 200 ||
          !{'image/png', 'image/jpeg', 'image/webp'}.contains(mime) ||
          response.contentLength > maxBytes) {
        throw const FormatException('image_response_rejected');
      }
      final builder = BytesBuilder(copy: false);
      await for (final chunk in response.timeout(const Duration(seconds: 10))) {
        if (builder.length + chunk.length > maxBytes) {
          throw const FormatException('image_too_large');
        }
        builder.add(chunk);
      }
      return ImageDownload(builder.takeBytes(), mime);
    })().timeout(const Duration(seconds: 16));
  } finally {
    client.close(force: true);
  }
}

Future<void> validateImage(ImageDownload image) async {
  final b = image.bytes;
  final png =
      b.length > 24 && b[0] == 137 && b[1] == 80 && b[2] == 78 && b[3] == 71;
  final jpeg = b.length > 4 && b[0] == 255 && b[1] == 216 && b[2] == 255;
  final webp =
      b.length > 16 &&
      ascii.decode(b.sublist(0, 4), allowInvalid: true) == 'RIFF' &&
      ascii.decode(b.sublist(8, 12), allowInvalid: true) == 'WEBP';
  if (!(image.mime == 'image/png' && png ||
      image.mime == 'image/jpeg' && jpeg ||
      image.mime == 'image/webp' && webp)) {
    throw const FormatException('image_signature_rejected');
  }
  final buffer = await ui.ImmutableBuffer.fromUint8List(b);
  ui.ImageDescriptor? descriptor;
  try {
    descriptor = await ui.ImageDescriptor.encoded(buffer);
    if (descriptor.width < 1 ||
        descriptor.height < 1 ||
        descriptor.width > 4096 ||
        descriptor.height > 4096 ||
        descriptor.width * descriptor.height > 16 * 1024 * 1024) {
      throw const FormatException('image_dimensions_rejected');
    }
  } finally {
    descriptor?.dispose();
    buffer.dispose();
  }
}

class ArtworkCache {
  ArtworkCache({
    required this.directory,
    this.fetcher = downloadSonyImage,
    this.maxBytes = 96 * 1024 * 1024,
    this.maxEntries = 600,
    this.requestBudget = 240,
    this.maxImageBytes = 3 * 1024 * 1024,
  });
  final Directory directory;
  final ImageFetcher fetcher;
  final int maxBytes, maxEntries, requestBudget, maxImageBytes;
  final _pending = <String, Future<File?>>{};
  final _failures = <String, DateTime>{};
  final Queue<Completer<void>> _waiters = Queue();
  int _active = 0, requests = 0, diskHits = 0;
  DateTime _windowStarted = DateTime.now();
  int _windowRequests = 0;
  Future<void>? _ready;
  Future<void> _writing = Future.value();
  Future<void> _initialize() => _ready ??= () async {
    await directory.create(recursive: true);
    await _trim();
  }();
  String key(String url) => sha256.convert(utf8.encode(url)).toString();
  Future<File?> load(String? url, {bool cacheOnly = false}) {
    final uri = safeArtworkUri(url);
    if (uri == null) return Future.value(null);
    final id = key(uri.toString());
    if (_pending.containsKey(id)) return _pending[id]!;
    final work = _load(uri, id, cacheOnly);
    _pending[id] = work;
    work.whenComplete(() => _pending.remove(id));
    return work;
  }

  Future<File?> _load(Uri uri, String id, bool cacheOnly) async {
    try {
      await _initialize();
      final file = File('${directory.path}/$id.img');
      if (await file.exists()) {
        final size = await file.length();
        if (size > 0 && size <= maxImageBytes) {
          diskHits++;
          await file.setLastModified(DateTime.now());
          return file;
        }
        await file.delete();
      }
      if (cacheOnly ||
          _failures[id]?.isAfter(
                DateTime.now().subtract(const Duration(minutes: 10)),
              ) ==
              true) {
        return null;
      }
      if (_active >= 2) {
        if (_waiters.length >= 24) return null;
        final waiter = Completer<void>();
        _waiters.add(waiter);
        await waiter.future;
      } else {
        _active++;
      }
      try {
        if (DateTime.now().difference(_windowStarted) >=
            const Duration(hours: 1)) {
          _windowStarted = DateTime.now();
          _windowRequests = 0;
        }
        if (_windowRequests >= requestBudget) return null;
        _windowRequests++;
        requests++;
        final response = await fetcher(
          uri,
          maxImageBytes,
        ).timeout(const Duration(seconds: 18));
        if (response.bytes.length > maxImageBytes ||
            response.bytes.length > maxBytes) {
          throw const FormatException('image_too_large');
        }
        await validateImage(response);
        final write = _writing.then((_) async {
          final temp = File('${file.path}.part');
          await temp.writeAsBytes(response.bytes, flush: true);
          await temp.rename(file.path);
          await _trim(protect: file.path);
        });
        _writing = write.then<void>(
          (_) {},
          onError: (Object error, StackTrace stack) {},
        );
        await write;
        return file;
      } finally {
        if (_waiters.isNotEmpty) {
          _waiters.removeFirst().complete();
        } else {
          _active--;
        }
      }
    } catch (_) {
      _failures[id] = DateTime.now();
      return null;
    }
  }

  Future<void> _trim({String? protect}) async {
    final files = <FileStatEntry>[];
    await for (final item in directory.list(followLinks: false)) {
      if (item is File && RegExp(r'[a-f0-9]{64}\.img$').hasMatch(item.path)) {
        files.add(FileStatEntry(item, await item.stat()));
      }
    }
    files.sort((a, b) => a.stat.modified.compareTo(b.stat.modified));
    var bytes = files.fold(0, (n, e) => n + e.stat.size), count = files.length;
    for (final entry in files) {
      if (bytes <= maxBytes && count <= maxEntries) break;
      if (entry.file.path == protect) continue;
      try {
        await entry.file.delete();
        bytes -= entry.stat.size;
        count--;
      } catch (_) {}
    }
  }

  Future<void> prefetch(Iterable<String?> urls) async {
    await Future.wait(urls.take(12).map((url) => load(url)));
  }
}

class FileStatEntry {
  FileStatEntry(this.file, this.stat);
  final File file;
  final FileStat stat;
}

Future<ArtworkCache> nativeArtworkCache() async {
  final path = await const MethodChannel('platinum_companion/files')
      .invokeMethod<String>('imageCacheDirectory');
  if (path == null) throw StateError('image_cache_unavailable');
  return ArtworkCache(directory: Directory(path));
}

class ArtworkMetadata {
  ArtworkMetadata(this.value);
  final Map<String, dynamic> value;
  String? _url(String field) =>
      safeArtworkUri((value[field] as Map?)?['url'] as String?)?.toString();
  String? get cover => _url('cover');
  String? get hero => _url('hero');
  String? get titleIcon => _url('titleIcon');
  String? get gameIcon => _url('gameIcon');
  String get coverStatus =>
      (value['cover'] as Map?)?['status'] as String? ?? 'identity_unresolved';
  String? get preferred => cover ?? gameIcon ?? titleIcon;
}
