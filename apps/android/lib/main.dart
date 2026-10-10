import 'data/artwork_cache.dart';
import 'ui/official_image.dart';

import 'package:flutter/material.dart';

import 'data/data.dart';
import 'ui/app.dart';
import 'data/cloud_api.dart';
import 'data/cloud_auth.dart';
import 'data/cloud_controller.dart';
import 'data/update_controller.dart';
import 'data/library_index_storage.dart';

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  final repository = TrophyRepository(
    storage: NativeSnapshotStorage(),
    picker: NativeSnapshotFilePicker(),
  );
  await repository.initialize();
  final artworkCache = await nativeArtworkCache();
  PaintingBinding.instance.imageCache.maximumSizeBytes = 32 * 1024 * 1024;
  final cloud = CloudController(
    repository: repository,
    auth: NativeCompanionAuth(),
    transport: HttpsCloudTransport(),
    libraryStorage: const NativeLibraryIndexStorage(),
    artworkCache: artworkCache,
  );
  runApp(
    ArtworkScope(
      cache: artworkCache,
      child: PlatinumApp(
        repository: repository,
        cloud: cloud,
        updates: UpdateController(),
      ),
    ),
  );
  await cloud.initialize();
}
