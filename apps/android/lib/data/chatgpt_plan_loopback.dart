// Device-local listener only. No real OAuth is started by this class.
import 'dart:async';
import 'dart:io';

import 'chatgpt_plan_protocol.dart';

class PlanLoopback {
  PlanLoopback._(this._server, this.attempt);
  final HttpServer _server;
  final PlanAuthorizationAttempt attempt;
  final _result = Completer<PlanCallback>();
  Timer? _expiry;
  Future<PlanCallback> get result => _result.future;
  static Future<PlanLoopback> listen({
    required String hostId,
    String? issuedClientId,
    Duration timeout = const Duration(minutes: 3),
  }) async {
    final server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
    try {
      final callback = Uri.parse(
        'http://127.0.0.1:${server.port}/auth/callback',
      );
      final value = PlanLoopback._(
        server,
        PlanAuthorizationAttempt(
          callback: callback,
          hostId: hostId,
          issuedClientId: issuedClientId,
        ),
      );
      server.listen(value._handle);
      value._expiry = Timer(timeout, () {
        if (!value._result.isCompleted) {
          value._result.completeError(
            const PlanUsageFailure('authorization_timeout'),
          );
        }
        value.close();
      });
      return value;
    } catch (_) {
      await server.close(force: true);
      rethrow;
    }
  }

  Future<void> _handle(HttpRequest request) async {
    request.response.headers.set('Cache-Control', 'no-store');
    request.response.headers.set(
      'Content-Security-Policy',
      "default-src 'none'",
    );
    request.response.headers.set('Referrer-Policy', 'no-referrer');
    request.response.headers.contentType = ContentType.text;
    try {
      if (_result.isCompleted ||
          request.method != 'GET' ||
          request.uri.hasAuthority ||
          request.headers.value('host') != '127.0.0.1:${_server.port}' ||
          request.connectionInfo?.remoteAddress.address != '127.0.0.1' ||
          request.uri.toString().length > 8192) {
        throw const PlanUsageFailure('invalid_callback');
      }
      final uri = attempt.callback.replace(
        path: request.uri.path,
        query: request.uri.hasQuery ? request.uri.query : null,
      );
      final result = attempt.validateCallback(uri);
      request.response.write(
        'Callback received. You can return to Platinum Companion.',
      );
      _result.complete(result);
    } on PlanUsageFailure catch (e) {
      request.response.statusCode = 400;
      request.response.write('Callback rejected.');
      if (e.code == 'authorization_declined' && !_result.isCompleted) {
        _result.completeError(e);
      }
    } catch (_) {
      request.response.statusCode = 400;
      request.response.write('Callback rejected.');
    } finally {
      await request.response.close();
      if (_result.isCompleted) await close();
    }
  }

  Future<void> close() async {
    _expiry?.cancel();
    if (!_result.isCompleted) {
      _result.completeError(const PlanUsageFailure('authorization_cancelled'));
    }
    await _server.close(force: true);
  }
}
