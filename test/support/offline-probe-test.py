"""No native binary/provider calls: exercise fixtures, CLI protocol and localhost mock."""
import http.client
import importlib.util
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch
from types import SimpleNamespace

sys.dont_write_bytecode = True
FILE = Path(__file__).resolve().parents[2] / "scripts/offline-kernel-probe.py"
spec = importlib.util.spec_from_file_location("probe", FILE)
probe = importlib.util.module_from_spec(spec)
spec.loader.exec_module(probe)


class ProbeTests(unittest.TestCase):
    def stage(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        path = Path(temp.name)
        (path / "spec.json").write_text(json.dumps({"model": "claude-opus-4-6", "mock_url": "http://127.0.0.1:9"}))
        return path

    def run_cli(self, frames, native=False, extra_args=()):
        stage = self.stage()
        env = dict(os.environ, PYTHONIOENCODING="utf-8", PYTHONDONTWRITEBYTECODE="1")
        env.pop("CLAUDE_CODE_KIN_NATIVE_SLOTS", None)
        if native:
            env.update(CLAUDE_CODE_KIN_NATIVE_SLOTS="2", CLAUDE_CODE_SYSTEM_LAYOUT="zero", CLAUDE_CODE_KIN_CONFIG_HASH="expected-test-hash")
        raw = "".join(probe.dump(frame) + "\n" for frame in frames).encode()
        child = subprocess.run([sys.executable, "-I", "-S", str(FILE), "--fake-cli", str(stage), "--include-partial-messages", *extra_args], input=raw, capture_output=True, env=env, timeout=15)
        self.assertEqual(child.returncode, 0, child.stderr.decode("utf-8", "replace"))
        return stage, raw, [json.loads(line) for line in child.stdout.splitlines()]

    def test_long_fixture_has_small_usage_and_exact_initial_text(self):
        message = probe.fixture_message(thinking=True)
        text = ""
        for event in probe.message_events(message, initial_text=True):
            if event["type"] == "content_block_start" and event["content_block"]["type"] == "text":
                text += event["content_block"]["text"]
            if event["type"] == "content_block_delta" and event["delta"]["type"] == "text_delta":
                text += event["delta"]["text"]
        self.assertEqual(text, message["content"][-1]["text"])
        self.assertGreater(len(text), 16000)
        self.assertIn("🙂", text)
        self.assertTrue(text.endswith("[OFFLINE_END]"))
        self.assertEqual(message["usage"]["output_tokens"], 148)

    def test_native_handshake_and_exact_input_capture(self):
        request = {"model": "claude-opus-4-6", "system": [{"type": "text", "text": "规则甲"}, {"type": "text", "text": "规则乙"}],
                   "messages": [{"role": "user", "content": "hello"}], "thinking": {"type": "adaptive"}, "output_config": {"effort": "max"}}
        stage, raw, lines = self.run_cli([{"type": "kin_job_start", "slot_id": "s00", "job_id": "job0", "request": request}], True)
        self.assertEqual(lines[0]["protocol_version"], 2)
        self.assertEqual(lines[0]["config_hash"], "expected-test-hash")
        self.assertEqual([x["slot_id"] for x in lines if x["type"] == "kin_slot_ready"], ["s00", "s01"])
        self.assertEqual(lines[-1]["type"], "kin_job_done")
        records, budget = probe.read_capture(stage)
        self.assertEqual(next(r["text"] for r in records if r["kind"] == "cli_stdin"), raw.decode())
        output = "".join(r["text"] for r in records if r["kind"] == "cli_stdout")
        self.assertEqual([json.loads(x) for x in output.splitlines()], lines)
        self.assertEqual(budget["omitted"], 0)

    def test_common_stream_json_and_unknown_frames(self):
        stage, _, lines = self.run_cli([
            {"type": "control_request", "request_id": "init1", "request": {"subtype": "initialize"}},
            {"type": "user", "message": {"role": "user", "content": "hello"}},
            {"mystery": True},
        ])
        self.assertEqual(lines[0]["type"], "control_response")
        self.assertTrue(any(x["type"] == "assistant" for x in lines))
        records, _ = probe.read_capture(stage)
        self.assertTrue(any(x["kind"] == "unsupported_cli_frame" for x in records))

    def test_crag_stream_frames_echo_each_requested_session(self):
        # The supplied Crag trace had a real UUID but our fake replied under
        # offline-session. A per-session reader must never get another ID.
        sessions = ['probe-session-a', 'probe-session-b']
        _, _, lines = self.run_cli([
            {'type': 'user', 'session_id': session, 'model': 'claude-opus-4-6',
             'message': {'role': 'user', 'content': 'neutral offline probe'}} for session in sessions
        ], extra_args=('--session-id', 'host-session'))
        self.assertEqual([x['session_id'] for x in lines if x['type'] == 'result'], sessions)
        active = None
        for frame in lines:
            if frame['type'] == 'system':
                active = frame['session_id']
            self.assertEqual(frame['session_id'], active)
            self.assertIn(frame['session_id'], sessions)

    def test_stream_json_result_carries_real_fixture_stop_reason(self):
        _, _, lines = self.run_cli([{'type': 'user', 'message': {'role': 'user', 'content': 'probe'}}])
        result = next(x for x in lines if x['type'] == 'result')
        self.assertEqual(result.get('stop_reason'), 'end_turn')
        self.assertFalse(result['is_error'])

    def test_stream_json_session_falls_back_to_explicit_cli_option(self):
        _, _, lines = self.run_cli([{'type': 'user', 'message': {'role': 'user', 'content': 'probe'}}],
                                  extra_args=('--session-id', 'requested-fallback'))
        self.assertTrue(all(x.get('session_id') == 'requested-fallback' for x in lines))

    def test_help_returns_without_waiting_for_stream_input(self):
        stage = self.stage()
        env = dict(os.environ, PYTHONIOENCODING='utf-8', PYTHONDONTWRITEBYTECODE='1')
        with subprocess.Popen([sys.executable, '-I', '-S', str(FILE), '--fake-cli', str(stage), '--help'],
                              stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=env) as child:
            try:
                child.wait(timeout=5)  # Keep stdin open: --help must not await a frame or EOF.
                output, errors = child.stdout.read(), child.stderr.read()
                self.assertEqual(child.returncode, 0, errors.decode('utf-8', 'replace'))
                self.assertIn(b'--input-format', output)
                self.assertIn(b'--session-id', output)
                self.assertNotIn(b'--single-process-subagents', output)  # No unsupported capability claim.
            finally:
                if child.poll() is None:
                    child.kill()
                    child.wait(timeout=5)

    def test_cancel_is_not_a_model_reply(self):
        _, _, lines = self.run_cli([{"type": "kin_cancel", "slot_id": "s00", "job_id": "cancel1"}], True)
        self.assertEqual(lines[-1]["type"], "kin_cancel_ack")
        self.assertFalse(any(x["type"] == "kin_stream_event" for x in lines))

    def test_capture_is_bounded_and_valid_utf8(self):
        stage = self.stage()
        probe.capture(stage, "big", "中🙂" * (probe.CAPTURE_LIMIT // 3))
        probe.capture(stage, "later", "tail")
        rows, budget = probe.read_capture(stage)
        self.assertLessEqual(budget["retained"], probe.CAPTURE_LIMIT)
        self.assertTrue(rows[0]["truncated"])
        self.assertNotIn("\ufffd", rows[0]["text"])

    def test_mock_api_records_json_not_authorization(self):
        stage = self.stage()
        server = probe.mock_api(stage, "claude-opus-4-6")
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)
        conn = http.client.HTTPConnection("127.0.0.1", server.server_port, timeout=5)
        self.addCleanup(conn.close)
        request = {"model": "claude-opus-4-6", "stream": True, "system": [{"type": "text", "text": "KEEP_ME"}], "thinking": {"type": "adaptive"}}
        raw = probe.dump(request)
        conn.request("POST", "/v1/messages?beta=true", raw.encode(), headers={"Authorization": "SECRET_SHOULD_NOT_BE_CAPTURED"})
        response = conn.getresponse()
        self.assertEqual(response.status, 200)
        self.assertEqual(response.read(), probe.sse_bytes(probe.fixture_message(thinking=True)))
        records, _ = probe.read_capture(stage)
        self.assertEqual(next(r["text"] for r in records if r["kind"] == "anthropic_request"), raw)
        self.assertNotIn("SECRET_SHOULD_NOT_BE_CAPTURED", json.dumps(records))

    def test_json_mock_reply_and_unknown_path(self):
        stage = self.stage()
        server = probe.mock_api(stage, "claude-opus-4-6")
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)
        for path, status in [("/v1/messages", 200), ("/unexpected", 404)]:
            conn = http.client.HTTPConnection("127.0.0.1", server.server_port, timeout=5)
            conn.request("POST", path, b'{"stream":false}')
            response = conn.getresponse()
            data = json.loads(response.read())
            self.assertEqual(response.status, status)
            if status == 200:
                self.assertEqual(data["type"], "message")
                self.assertGreater(len(data["content"][0]["text"]), 16000)
            conn.close()

    def test_recording_proxy_forwards_bytes_and_eof(self):
        stage = self.stage()
        data = ('记录转发🙂 <content>unchanged</content>\n' * 20).encode()
        with tempfile.TemporaryFile() as source, tempfile.TemporaryFile() as output, tempfile.TemporaryFile() as errors:
            source.write(data)
            source.seek(0)
            with patch.object(probe.sys, 'stdin', SimpleNamespace(buffer=source)), patch.object(probe.sys, 'stdout', SimpleNamespace(buffer=output)), patch.object(probe.sys, 'stderr', SimpleNamespace(buffer=errors)):
                code = probe.proxy_cli(stage, ['-c', 'import sys; sys.stdout.buffer.write(sys.stdin.buffer.read())'], _executable=sys.executable)
            self.assertEqual(code, 0)
            output.seek(0)
            self.assertEqual(output.read(), data)
        records, _ = probe.read_capture(stage)
        self.assertEqual(''.join(r['text'] for r in records if r['kind'] == 'cli_stdin'), data.decode())
        self.assertEqual(''.join(r['text'] for r in records if r['kind'] == 'cli_stdout'), data.decode())

    def test_proxy_sets_candidate_guard_only_for_explicit_candidate(self):
        for candidate in (None, 'native-v155-r1', 'native-v155-r2', 'native-v155-r3'):
            stage = self.stage()
            (stage / 'spec.json').write_text(json.dumps({'model': 'claude-opus-4-6', 'mock_url': 'http://127.0.0.1:9', 'candidate_id': candidate}))
            with tempfile.TemporaryFile() as source, tempfile.TemporaryFile() as output, tempfile.TemporaryFile() as errors:
                with patch.object(probe.sys, 'stdin', SimpleNamespace(buffer=source)), patch.object(probe.sys, 'stdout', SimpleNamespace(buffer=output)), patch.object(probe.sys, 'stderr', SimpleNamespace(buffer=errors)), patch.dict(os.environ, {'VM2API_OFFLINE_CANDIDATE': 'inherited-must-be-cleared'}):
                    code = probe.proxy_cli(stage, ['-c', 'import os,json;print(json.dumps({"candidate":os.getenv("VM2API_OFFLINE_CANDIDATE"),"base":os.getenv("ANTHROPIC_BASE_URL")}))'], _executable=sys.executable)
                self.assertEqual(code, 0)
                output.seek(0)
                self.assertEqual(json.load(output), {'candidate': candidate, 'base': 'http://127.0.0.1:9'})
            records, _ = probe.read_capture(stage)
            effective = json.loads(next(r['text'] for r in records if r['kind'] == 'effective_mock_environment'))
            self.assertEqual(effective['VM2API_OFFLINE_CANDIDATE'], candidate)

    def test_uploaded_binary_hashes_are_checked_before_native_launch(self):
        stage = self.stage()
        (stage / 'kin-kernel.bin').write_bytes(b'kernel fixture')
        (stage / 'real-cli').write_bytes(b'cli fixture')
        expected = {'kernel_sha256': probe.sha(b'kernel fixture'), 'cli_sha256': probe.sha(b'cli fixture')}
        observed, verified = probe.verified_binary_inputs(expected, stage)
        self.assertTrue(verified)
        self.assertEqual(observed, expected)
        (stage / 'real-cli').write_bytes(b'wrong bytes')
        self.assertFalse(probe.verified_binary_inputs(expected, stage)[1])
        (stage / 'real-cli').unlink()
        self.assertFalse(probe.verified_binary_inputs(expected, stage)[1])

    def test_unknown_candidate_guard_is_rejected_before_start(self):
        stage = self.stage()
        (stage / 'spec.json').write_text(json.dumps({'model': 'claude-opus-4-6', 'mock_url': 'http://127.0.0.1:9', 'candidate_id': 'unknown'}))
        with patch.object(probe.subprocess, 'Popen', side_effect=AssertionError('must not execute')):
            with self.assertRaisesRegex(RuntimeError, 'Unknown offline native candidate'):
                probe.proxy_cli(stage, [], _executable=sys.executable)

    def test_corrupt_budget_fails_closed_without_losing_prior_records(self):
        stage = self.stage()
        probe.capture(stage, 'first', 'kept')
        (stage / 'budget.json').write_text('{broken')
        probe.capture(stage, 'later', 'not retained')
        rows, budget = probe.read_capture(stage)
        self.assertEqual(rows[0]['text'], 'kept')
        self.assertTrue(budget['counter_corrupt'])
        self.assertGreater(budget['omitted'], 0)

    def test_actual_http_parser_keeps_kernel_trailers(self):
        class Socket:
            def makefile(self, *_):
                return io.BytesIO(b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n2\r\nok\r\n0\r\nX-Kin-Terminal-State: verified\r\nX-Kin-Stop-Reason: end_turn\r\n\r\n")
        response = probe.CaptureResponse(Socket())
        response.begin()
        self.assertEqual(response.read(), b"ok")
        self.assertEqual(response.offline_trailers["X-Kin-Stop-Reason"], "end_turn")


if __name__ == "__main__":
    unittest.main()
