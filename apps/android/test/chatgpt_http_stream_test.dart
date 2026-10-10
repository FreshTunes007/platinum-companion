// Real local HTTP framing with synthetic Responses events, not inference proof.
import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:platinum_companion/data/chatgpt_plan_client.dart';
import 'package:platinum_companion/data/chatgpt_plan_protocol.dart';

void main() {
  Future<String> receive(String body, {String? mime}) async {
    // Raw local wire prevents HttpServer from injecting a default MIME header.
    final server = await ServerSocket.bind(InternetAddress.loopbackIPv4, 0);
    final client = HttpClient();
    server.listen((socket) {
      var sent = false;
      socket.listen((_) async {
        if (sent) return;
        sent = true;
        final bytes = utf8.encode(body);
        socket.write(
          'HTTP/1.1 200 OK\r\nContent-Length: ${bytes.length}\r\n'
          '${mime == null ? '' : 'Content-Type: $mime\r\n'}Connection: close\r\n\r\n',
        );
        socket.add(bytes);
        await socket.flush();
        await socket.close();
      });
    });
    try {
      final request = await client.getUrl(
        Uri.parse('http://127.0.0.1:${server.port}/fixture'),
      );
      final response = await request.close();
      return await consumePlanHttpStream(response);
    } finally {
      client.close(force: true);
      await server.close();
    }
  }

  const completed =
      'data: {"type":"response.output_text.delta","delta":"Fixture answer"}\n\n'
      'data: {"type":"response.completed","response":{"status":"completed"}}\n\n';
  test(
    'missing MIME still requires actual SSE text and completed event',
    () async {
      expect(await receive(completed), 'Fixture answer');
      expect(
        await receive(completed, mime: 'text/event-stream; charset=utf-8'),
        'Fixture answer',
      );
      for (final body in [
        '{"status":"completed"}',
        'data: {"type":"response.output_text.delta","delta":"Partial"}\n\n',
      ]) {
        await expectLater(receive(body), throwsA(isA<PlanUsageFailure>()));
      }
    },
  );
  test(
    'explicit incompatible MIME cannot masquerade as a valid stream',
    () async {
      await expectLater(
        receive(completed, mime: 'text/html'),
        throwsA(isA<PlanUsageFailure>()),
      );
    },
  );
}
