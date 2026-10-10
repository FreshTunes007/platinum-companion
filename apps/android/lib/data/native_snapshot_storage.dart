import 'package:flutter/services.dart';

import 'snapshot_repository.dart';

class NativeSnapshotStorage implements SnapshotStorage {
  const NativeSnapshotStorage();
  static const channel = MethodChannel('platinum_companion/files');

  @override
  Future<String?> read() => channel.invokeMethod<String>('readSnapshot');

  @override
  Future<void> write(String json) =>
      channel.invokeMethod<void>('writeSnapshot', {'json': json});

  @override
  Future<void> clear() => channel.invokeMethod<void>('clearSnapshot');
}

class NativeSnapshotFilePicker implements SnapshotFilePicker {
  const NativeSnapshotFilePicker();

  @override
  Future<String?> pickSnapshot() =>
      NativeSnapshotStorage.channel.invokeMethod<String>('pickSnapshot');
}
