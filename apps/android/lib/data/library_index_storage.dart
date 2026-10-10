import 'package:flutter/services.dart';

import 'snapshot_repository.dart';

class NativeLibraryIndexStorage implements SnapshotStorage {
  const NativeLibraryIndexStorage();
  static const _channel = MethodChannel('platinum_companion/files');
  @override
  Future<String?> read() => _channel.invokeMethod<String>('readIndex');
  @override
  Future<void> write(String json) =>
      _channel.invokeMethod<void>('writeIndex', {'json': json});
  @override
  Future<void> clear() => write('{}');
}
