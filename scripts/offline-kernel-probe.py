#!/usr/bin/env python3
"""Disconnected diagnostic only: fake CLI, recording shim, mock API and runner.
No real credentials are read. The runner refuses non-Linux/non-isolated networking.
"""
import base64
import hashlib
import http.client
import http.server
import io
import json
import os
from pathlib import Path
import signal
import socket
import subprocess
import sys
import threading
import time
import uuid

try:
    import fcntl
except ImportError:  # Only the fake-CLI unit tests run on Windows.
    fcntl = None

CAPTURE_LIMIT = 4 * 1024 * 1024
MAX_LINE = 4 * 1024 * 1024
MAX_RECORDS = 4096
_CAPTURE_THREAD_LOCK = threading.Lock()
SAFE_ENV = (
    "CLAUDE_CODE_KIN_NATIVE_SLOTS", "CLAUDE_CODE_SYSTEM_LAYOUT", "KIN_SYSTEM_MODE",
    "CLAUDE_CODE_VERSION", "CLAUDE_CODE_ENTRYPOINT", "TZ", "CLAUDE_CODE_TIMEZONE",
    "ANTHROPIC_BASE_URL", "KIN_ENVELOPE_PATH",
)


def dump(value):
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


def sha(data):
    return hashlib.sha256(data).hexdigest()


def verified_binary_inputs(meta, directory=Path('/probe')):
    observed = {}
    for key, name in (('kernel_sha256', 'kin-kernel.bin'), ('cli_sha256', 'real-cli')):
        path = Path(directory) / name
        if not path.exists():
            observed[key] = None
            continue
        digest = hashlib.sha256()
        with open(path, 'rb') as source:
            for chunk in iter(lambda: source.read(1024 * 1024), b''):
                digest.update(chunk)
        observed[key] = digest.hexdigest()
    return observed, all(observed[key] == meta.get(key) for key in observed)


def capture(stage, kind, data, **metadata):
    """One shared byte/record budget, preserved prefixes, never stdout logging."""
    if isinstance(data, str):
        data = data.encode("utf-8")
    stage = Path(stage)
    with _CAPTURE_THREAD_LOCK, open(stage / "capture.lock", "a+b") as lock:
        if fcntl:
            fcntl.flock(lock, fcntl.LOCK_EX)
        try:
            state_file = stage / "budget.json"
            try:
                state = json.loads(state_file.read_text()) if state_file.exists() else {"observed": 0, "retained": 0, "records": 0, "omitted": 0}
            except ValueError:
                state = {"observed": 0, "retained": CAPTURE_LIMIT, "records": MAX_RECORDS, "omitted": 0, "counter_corrupt": True}
            state["observed"] += len(data)
            state["records"] += 1
            remaining = max(0, CAPTURE_LIMIT - state["retained"])
            record = None
            if state["records"] > MAX_RECORDS:
                state["omitted"] += 1
            else:
                prefix = data[:remaining]
                text = prefix.decode("utf-8", "ignore")
                kept = len(text.encode("utf-8"))
                state["retained"] += kept
                record = {"kind": kind, "text": text, "bytes_observed": len(data), "bytes_retained": kept,
                          "truncated": kept < len(data), "sha256": sha(data), **metadata}
            # Reserve before append; SIGKILL may lose a record but cannot reset the budget.
            temporary = stage / ("budget-" + str(os.getpid()) + ".tmp")
            temporary.write_text(dump(state))
            os.replace(temporary, state_file)
            if record is not None:
                with open(stage / "capture.jsonl", "ab") as out:
                    out.write((dump(record) + "\n").encode("utf-8"))
        finally:
            if fcntl:
                fcntl.flock(lock, fcntl.LOCK_UN)


def fixture_message(model="claude-opus-4-6", thinking=False):
    text = ("[OFFLINE_BEGIN]\n<基础确认>这是固定的离线夹具，不是模型回答。</基础确认>\n<content>\n" +
            "".join(f"{i:04d}|离线长文本验证：中文、UTF-8、emoji🙂、JSON {{\"n\":{i}}}、ABCD。\n" for i in range(320)) +
            "</content>\n<details><summary>OFFLINE_RECAP</summary>固定尾部，不应丢失。</details>\n" +
            "<status>{\"simulated\":true}</status>\n[OFFLINE_END]")
    content = []
    if thinking:
        content.append({"type": "thinking", "thinking": "OFFLINE_THINKING: fixed fixture, not actual model reasoning.", "signature": "offline-fixture-signature"})
    content.append({"type": "text", "text": text})
    return {"id": "msg_offline_fixture", "type": "message", "role": "assistant", "model": model,
            "content": content, "stop_reason": "end_turn", "stop_sequence": None,
            # Deliberately small usage with long text: usage must not control decoded length.
            "usage": {"input_tokens": 3, "output_tokens": 148, "cache_read_input_tokens": 0, "cache_creation_input_tokens": 0}}


def message_events(message, initial_text=False):
    opening = {k: v for k, v in message.items() if k not in ("content", "usage")}
    opening.update(content=[], stop_reason=None, usage={"input_tokens": 3, "output_tokens": 0})
    yield {"type": "message_start", "message": opening}
    for index, block in enumerate(message["content"]):
        thinking = block["type"] == "thinking"
        key = "thinking" if thinking else "text"
        value = block[key]
        prefix = value[:17] if initial_text and not thinking else ""
        yield {"type": "content_block_start", "index": index, "content_block": {"type": block["type"], key: prefix}}
        for pos in range(len(prefix), len(value), 79):
            yield {"type": "content_block_delta", "index": index, "delta": {"type": "thinking_delta" if thinking else "text_delta", key: value[pos:pos + 79]}}
        if thinking:
            yield {"type": "content_block_delta", "index": index, "delta": {"type": "signature_delta", "signature": block["signature"]}}
        yield {"type": "content_block_stop", "index": index}
    yield {"type": "message_delta", "delta": {"stop_reason": "end_turn", "stop_sequence": None}, "usage": message["usage"]}
    yield {"type": "message_stop"}


def sse_bytes(message):
    return "".join("event: " + e["type"] + "\r\ndata: " + dump(e) + "\r\n\r\n" for e in message_events(message)).encode("utf-8")


def write_line(value):
    sys.stdout.buffer.write((dump(value) + "\n").encode("utf-8"))
    sys.stdout.buffer.flush()


def boot_capture(stage, args):
    capture(stage, "cli_argv", dump(args))
    capture(stage, "cli_environment", dump({k: os.environ[k] for k in SAFE_ENV if k in os.environ}))
    inline = os.environ.get("CLAUDE_CODE_KIN_ENVELOPE")
    if inline:
        capture(stage, "cli_envelope_environment", inline)
    paths = [os.environ.get("KIN_ENVELOPE_PATH")]
    for flag in ("--system-prompt-file", "--append-system-prompt-file"):
        if flag in args and args.index(flag) + 1 < len(args):
            paths.append(args[args.index(flag) + 1])
    for value in paths:
        if not value:
            continue
        p = Path(value).resolve()
        # Only the private runner's work area, never arbitrary paths from argv/env.
        if Path(stage).resolve().parent not in p.parents:
            capture(stage, "request_file_refused", str(p))
            continue
        try:
            with open(p, "rb") as source:
                data = source.read(MAX_LINE + 1)
            capture(stage, "cli_request_file", data, file=str(p), read_complete=len(data) <= MAX_LINE)
        except OSError:
            capture(stage, "request_file_missing", str(p))


def request_model(request, fallback):
    model = request.get("model") if isinstance(request, dict) else None
    return model if isinstance(model, str) and len(model) <= 128 else fallback


def fake_cli(stage, args):
    boot_capture(stage, args)
    if "--version" in args:
        print("2.1.281 (offline fake CLI)")
        return
    if "--help" in args or "-h" in args:
        # Advertise only this fixture's implemented stream-JSON surface. In
        # particular, do not claim the real CC single-process/tool-loop mode.
        print("Offline fake CLI: --input-format stream-json --output-format stream-json "
              "--include-partial-messages --session-id ID --model MODEL")
        return
    spec = json.loads((Path(stage) / "spec.json").read_text())
    def emit(value):
        capture(stage, "cli_stdout", dump(value) + "\n", observation="fake_event_before_write")
        write_line(value)
    native_slots = int(os.environ.get("CLAUDE_CODE_KIN_NATIVE_SLOTS", "0") or "0")
    if native_slots:
        emit({"type": "kin_host_ready", "protocol_version": 2, "slots": min(20, native_slots),
              "capabilities": ["multi_slot", "native_sse", "stateless"],
              "system_layout": os.environ.get("CLAUDE_CODE_SYSTEM_LAYOUT", "zero"), "timezone": os.environ.get("TZ", "UTC"),
              **({"config_hash": os.environ["CLAUDE_CODE_KIN_CONFIG_HASH"]} if os.environ.get("CLAUDE_CODE_KIN_CONFIG_HASH") else {})})
        for i in range(min(20, native_slots)):
            emit({"type": "kin_slot_ready", "slot_id": f"s{i:02d}"})
    for line in sys.stdin.buffer:
        capture(stage, "cli_stdin", line)
        if len(line) > MAX_LINE:
            continue
        try:
            item = json.loads(line)
        except (ValueError, UnicodeError):
            capture(stage, "unsupported_cli_frame", b"non-JSON input")
            continue
        if not isinstance(item, dict):
            capture(stage, "unsupported_cli_frame", b"non-object JSON input")
            continue
        kind = item.get("type")
        if kind == "kin_cancel":
            emit({"type": "kin_cancel_ack", "job_id": item.get("job_id"), "slot_id": item.get("slot_id")})
            continue
        if kind == "control_request":
            subtype = item.get("request", {}).get("subtype")
            if subtype in ("initialize", "set_model", "set_permission_mode", "interrupt"):
                emit({"type": "control_response", "response": {"subtype": "success", "request_id": item.get("request_id"), "response": {}}})
            else:
                capture(stage, "unsupported_cli_frame", dump(item))
            continue
        if kind == "kin_job_start":
            request = item.get("request") or {}
            fixture = fixture_message(request_model(request, spec["model"]), (request.get("thinking") or {}).get("type") in ("adaptive", "enabled"))
            capture(stage, "mock_anthropic_message", dump(fixture))
            for event in message_events(fixture):
                emit({"type": "kin_stream_event", "slot_id": item.get("slot_id"), "job_id": item.get("job_id"), "event": event})
            emit({"type": "kin_job_done", "job_id": item.get("job_id"), "slot_id": item.get("slot_id"), "stop_reason": "", "usage": {}})
        elif kind == "user" or (isinstance(item.get("messages"), list) and "model" in item):
            fixture = fixture_message(request_model(item, spec["model"]))
            capture(stage, "mock_anthropic_message", dump(fixture))
            session = item.get("session_id")
            if not isinstance(session, str) or not session:
                index = args.index("--session-id") + 1 if "--session-id" in args else len(args)
                session = args[index] if index < len(args) else "offline-session"
            emit({"type": "system", "subtype": "init", "session_id": session, "model": fixture["model"], "tools": [], "mcp_servers": [], "apiKeySource": "offline"})
            if "--include-partial-messages" in args:
                for event in message_events(fixture):
                    emit({"type": "stream_event", "event": event, "session_id": session, "parent_tool_use_id": None})
            emit({"type": "assistant", "message": fixture, "session_id": session, "parent_tool_use_id": None})
            emit({"type": "result", "subtype": "success", "is_error": False, "session_id": session,
                        "stop_reason": fixture["stop_reason"], "result": fixture["content"][-1]["text"], "usage": fixture["usage"], "total_cost_usd": 0,
                        "duration_ms": 1, "duration_api_ms": 1, "num_turns": 1})
        else:
            capture(stage, "unsupported_cli_frame", dump(item))


def proxy_cli(stage, args, _executable="/probe/real-cli"):
    boot_capture(stage, args)
    spec = json.loads((Path(stage) / "spec.json").read_text())
    env = dict(os.environ)
    env.update(ANTHROPIC_BASE_URL=spec["mock_url"], CLAUDE_CODE_OAUTH_TOKEN="sk-ant-oat01-offline-invalid",
               CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC="1",
               NO_PROXY="127.0.0.1,localhost", no_proxy="127.0.0.1,localhost", API_TIMEOUT_MS="5000")
    for key in ("HTTPS_PROXY", "HTTP_PROXY", "ALL_PROXY", "https_proxy", "http_proxy", "all_proxy", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_API_KEY", "VM2API_OFFLINE_CANDIDATE"):
        env.pop(key, None)
    candidate_id = spec.get('candidate_id')
    if candidate_id:
        if candidate_id not in ('native-v155-r1', 'native-v155-r2', 'native-v155-r3'):
            raise RuntimeError('Unknown offline native candidate')
        env['VM2API_OFFLINE_CANDIDATE'] = candidate_id
    capture(stage, "effective_mock_environment", dump({k: env.get(k) for k in ("ANTHROPIC_BASE_URL", "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC", "NO_PROXY", "VM2API_OFFLINE_CANDIDATE")}))
    child = subprocess.Popen([_executable, *args], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=env)
    capture(stage, "real_cli_started", dump({"pid": child.pid, "binary": _executable}))

    def pump(source, target, kind, close_target=False):
        pending = b""
        try:
            while True:
                chunk = os.read(source.fileno(), 8192)
                if not chunk:
                    break
                pending += chunk
                while b"\n" in pending:
                    line, pending = pending.split(b"\n", 1)
                    capture(stage, kind, line + b"\n", observation="pipe_read")
                if len(pending) > MAX_LINE:
                    capture(stage, kind, pending, partial_line=True, observation="pipe_read")
                    pending = b""
                target.write(chunk)
                target.flush()
        except (BrokenPipeError, OSError):
            pass
        finally:
            if pending:
                capture(stage, kind, pending, partial_line=True)
            if close_target:
                try:
                    target.close()
                except OSError:
                    pass
    threads = [
        threading.Thread(target=pump, args=(sys.stdin.buffer, child.stdin, "cli_stdin", True), daemon=True),
        threading.Thread(target=pump, args=(child.stdout, sys.stdout.buffer, "cli_stdout"), daemon=True),
        threading.Thread(target=pump, args=(child.stderr, sys.stderr.buffer, "cli_stderr"), daemon=True),
    ]
    for thread in threads:
        thread.start()
    code = child.wait()
    for thread in threads[1:]:
        thread.join(timeout=1)
    return code


class CaptureResponse(http.client.HTTPResponse):
    def _read_and_discard_trailer(self):
        lines = []
        while True:
            line = self.fp.readline(65537)
            if len(line) > 65536:
                raise http.client.LineTooLong("trailer")
            if line in (b"\r\n", b"\n", b""):
                break
            lines.append(line)
        self.offline_trailers = dict(http.client.parse_headers(io.BytesIO(b"".join(lines) + b"\r\n")).items())


class UnixConnection(http.client.HTTPConnection):
    response_class = CaptureResponse

    def __init__(self, target, timeout=5):
        super().__init__("localhost", timeout=timeout)
        self.target = target

    def connect(self):
        self.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.sock.settimeout(self.timeout)
        self.sock.connect(self.target)


def mock_api(stage, fallback_model):
    request_lock = threading.Lock()
    request_count = 0
    class Handler(http.server.BaseHTTPRequestHandler):
        def setup(self):
            super().setup()
            self.connection.settimeout(5)

        def log_message(self, *_args):
            pass

        def do_GET(self):
            body = dump({"data": [{"id": fallback_model, "type": "model", "display_name": "Offline fixture"}], "has_more": False}).encode()
            capture(stage, "mock_api_get", self.path)
            self.send_response(200 if self.path.split("?")[0] == "/v1/models" else 404)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def do_POST(self):
            nonlocal request_count
            with request_lock:
                request_count += 1
                limited = request_count > 16
            if limited:
                self.send_error(429, 'Offline mock request budget reached')
                return
            size = int(self.headers.get("content-length", "0") or "0")
            if size < 0 or size > MAX_LINE:
                self.send_error(413)
                return
            raw = self.rfile.read(size)
            capture(stage, "anthropic_request", raw, path=self.path, content_type=self.headers.get("content-type", ""))
            try:
                request = json.loads(raw)
            except ValueError:
                self.send_error(400)
                return
            if not isinstance(request, dict):
                self.send_error(400)
                return
            route = self.path.split("?")[0]
            if route == "/v1/messages/count_tokens":
                data, kind, status = b'{"input_tokens":42}', "application/json", 200
            elif route == "/v1/messages":
                fixture = fixture_message(request_model(request, fallback_model), (request.get("thinking") or {}).get("type") in ("adaptive", "enabled"))
                capture(stage, "mock_anthropic_message", dump(fixture))
                data = sse_bytes(fixture) if request.get("stream") else dump(fixture).encode()
                kind, status = ("text/event-stream" if request.get("stream") else "application/json"), 200
                # Record the actual successfully written response below, not the planned reply.
            else:
                data, kind, status = b'{"error":{"type":"offline_unhandled_path","message":"Not a supported mock API path"}}', "application/json", 404
            self.send_response(status)
            self.send_header("Content-Type", kind)
            self.send_header("Content-Length", str(len(data)))
            self.send_header("request-id", "req_offline_fixture")
            self.end_headers()
            at = 0
            try:
                sizes = (1, 2, 509, 1024, 17)
                while at < len(data):
                    chunk = data[at:at + sizes[at % len(sizes)]]
                    self.wfile.write(chunk)
                    self.wfile.flush()
                    at += len(chunk)
            except (BrokenPipeError, ConnectionResetError):
                pass
            finally:
                if route == '/v1/messages':
                    capture(stage, 'anthropic_response', data[:at], format='sse' if request.get('stream') else 'json',
                            write_complete=at == len(data), intended_bytes=len(data))
    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    server.daemon_threads = False  # Join actual response writers before sealing captures.
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server


def read_capture(stage):
    records = []
    file = stage / "capture.jsonl"
    if file.exists():
        for line in file.read_bytes().splitlines():
            try:
                records.append(json.loads(line))
            except ValueError:
                records.append({"kind": "capture_incomplete", "text": "", "truncated": True})
    try:
        budget = json.loads((stage / "budget.json").read_text()) if (stage / "budget.json").exists() else {}
    except ValueError:
        budget = {"counter_corrupt": True}
    return records, budget


def run_phase(name, supplied):
    stage = Path("/work") / name
    stage.mkdir(mode=0o700)
    meta, envelope = supplied["meta"], supplied["envelope"]
    model = envelope.get("body", {}).get("model", "claude-opus-4-6")
    server = mock_api(stage, model)
    url = "http://127.0.0.1:" + str(server.server_port)
    (stage / "spec.json").write_text(dump({"model": model, "mock_url": url, "candidate_id": (meta.get('candidate') or {}).get('id')}))
    home = Path("/home/kincli")
    (home / ".kin").mkdir(exist_ok=True)
    (home / ".claude").mkdir(exist_ok=True)
    cli = home / ".kin" / meta["cli_name"]
    mode = "--fake-cli" if name == "fake_cli" else "--proxy-cli"
    cli.write_text(f'#!/bin/sh\nexec /usr/bin/python3 -I -S /probe/offline-kernel-probe.py {mode} {stage} "$@"\n')
    cli.chmod(0o700)
    token = "offline-internal-" + supplied["nonce"]
    cred = {"claudeAiOauth": {"accessToken": "sk-ant-oat01-offline-invalid", "expiresAt": int(time.time() + 3600) * 1000,
                             "scopes": ["user:inference"], "subscriptionType": "max"},
            "access_token": "sk-ant-oat01-offline-invalid", "expires_at": int(time.time() + 3600) * 1000}
    (stage / "credentials.json").write_text(dump(cred))
    (home / ".claude" / ".credentials.json").write_text(dump(cred))
    target = str(stage / "kernel.sock")
    config = {"vm_id": "offline-probe", "socket_path": target, "credential_path": str(stage / "credentials.json"),
              "proxy_url": "", "proxy_required": False, "internal_token": token, "provider": "local_cli",
              "runtime_kind": "docker", "test_endpoints": True, "anthropic_base_url": url, "oauth_token_url": url + "/v1/oauth/token",
              "claude_bin": str(cli), "dataplane": {'wrap-fixed': 'wrap', 'cc-fixed': 'cc'}.get(meta["selected_pairing"], meta["selected_pairing"]), "system_layout": meta["system_layout"],
              "persona_preset": meta["persona_preset"], "slots_per_worker": meta["slots"], "default_cache_ttl": meta["cache_ttl"],
              "delivery_mode": "realtime", "request_timeout_seconds": 22, "first_byte_timeout_seconds": 15,
              "idle_timeout_seconds": 10, "max_request_bytes": 4 * 1024 * 1024, "max_response_bytes": 4 * 1024 * 1024,
              "max_event_bytes": 4 * 1024 * 1024}
    if meta.get('cli_version'):
        config['cli_version'] = meta['cli_version']
    config['timezone'] = meta.get('timezone') or 'UTC'
    config_path = stage / "kernel.json"
    config_path.write_text(dump(config))
    env = {"PATH": "/usr/bin:/bin", "HOME": str(home), "TMPDIR": str(stage), "TZ": config['timezone'], "LANG": "C.UTF-8",
           "KIN_PROVIDER": "local_cli", "KIN_CLAUDE_BIN": str(cli), "KIN_KERNEL_CONFIG": str(config_path),
           "ANTHROPIC_BASE_URL": url, "CLAUDE_CODE_OAUTH_TOKEN": "sk-ant-oat01-offline-invalid",
           "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC": "1", "NO_PROXY": "127.0.0.1,localhost", "API_TIMEOUT_MS": "5000"}
    args = ["/probe/kin-kernel.bin", "--gateway-worker", "--config", str(config_path)]
    loader = Path("/probe/glibc239/ld-linux-x86-64.so.2")
    if loader.exists():
        args = [str(loader), "--library-path", str(loader.parent)] + args
    result = {"name": name, "status": "starting", "real_cli_executed": False, "real_provider_called": False,
              "kernel_config": {k: v for k, v in config.items() if k not in ("internal_token", "credential_path")},
              "fixture": fixture_message(model, True), "kernel_reply": None}
    child = None
    kernel_log = bytearray()
    deadline = time.monotonic() + 30
    try:
        if name == "mock_api" and not Path("/probe/real-cli").exists():
            result["status"] = "real_cli_missing"
            return result
        child = subprocess.Popen(args, env=env, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                                 cwd="/work", start_new_session=True)
        def drain():
            while True:
                data = child.stdout.read(4096)
                if not data:
                    break
                if len(kernel_log) < 65536:
                    kernel_log.extend(data[:65536 - len(kernel_log)])
        reader = threading.Thread(target=drain, daemon=True)
        reader.start()
        while time.monotonic() < deadline:
            if child.poll() is not None:
                raise RuntimeError("kernel exited before ready")
            try:
                conn = UnixConnection(target, timeout=1)
                conn.request("GET", "/internal/health", headers={"X-Kin-Internal-Token": token})
                response = conn.getresponse()
                health = response.read(65536)
                conn.close()
                if response.status == 200:
                    info = json.loads(health)
                    if info.get('ready_slots') is None or int(info['ready_slots']) > 0:
                        capture(stage, "kernel_health", health)
                        break
            except (OSError, ValueError, http.client.HTTPException):
                pass
            time.sleep(0.05)
        else:
            raise TimeoutError("kernel readiness deadline")
        conn = UnixConnection(target, timeout=max(1, deadline - time.monotonic()))
        try:
            payload = dump(envelope).encode()
            capture(stage, 'node_to_kernel_envelope', payload, path='/internal/v1/messages')
            conn.request("POST", "/internal/v1/messages", body=payload,
                         headers={"X-Kin-Internal-Token": token, "Content-Type": "application/json", "TE": "trailers"})
            response = conn.getresponse()
            reply = {"status": response.status, "headers": dict(response.getheaders()),
                     "content_type": response.getheader("content-type", ""), "complete": False}
            result["kernel_reply"] = reply
            data = bytearray()
            try:
                while True:
                    chunk = response.read1(8192)
                    if not chunk:
                        if response.length not in (None, 0) or (response.chunked and not hasattr(response, 'offline_trailers')):
                            raise RuntimeError('kernel response ended before its HTTP framing completed')
                        reply["complete"] = True
                        break
                    data.extend(chunk)
                    if len(data) > 4 * 1024 * 1024:
                        raise RuntimeError("kernel response size limit")
            finally:
                reply.update(trailers=getattr(response, "offline_trailers", {}), body_b64=base64.b64encode(data).decode(), body_sha256=sha(data), body_text=data.decode('utf-8', 'replace'))
            result["status"] = "completed" if response.status < 400 else "kernel_rejected"
            time.sleep(0.15)  # Let post-message stdout/record writers settle before killing this private process group.
        finally:
            conn.close()
    except Exception as error:
        result["status"] = "failed"
        result["error"] = {"type": type(error).__name__, "message": str(error)[:300]}
    finally:
        if child is not None:
            try:
                os.killpg(child.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            try:
                child.wait(timeout=2)
            except subprocess.TimeoutExpired:
                result["cleanup_incomplete"] = True
            reader.join(timeout=1)
        server.shutdown()
        server.server_close()
        result["kernel_log"] = kernel_log.decode("utf-8", "replace")
        result["captures"], result["capture_budget"] = read_capture(stage)
        budget = result['capture_budget']
        result['capture_complete'] = (not budget.get('counter_corrupt') and not budget.get('omitted')
                                      and budget.get('records', 0) == len(result['captures'])
                                      and not any(r.get('truncated') for r in result['captures']))
        result["real_cli_executed"] = any(r["kind"] == "real_cli_started" for r in result["captures"])
        result['mock_model_requests'] = sum(r['kind'] == 'anthropic_request' and r.get('path', '').split('?')[0] == '/v1/messages' for r in result['captures'])
        result["missing_boundaries"] = []
        if name == "fake_cli" and not any(r["kind"] == "mock_anthropic_message" for r in result["captures"]):
            result["missing_boundaries"].append("fake_cli_request")
        if name == "mock_api" and not any(r["kind"] == "anthropic_request" and r.get("path", "").split("?")[0] == "/v1/messages" for r in result["captures"]):
            result["missing_boundaries"].append("anthropic_request")
        if result["status"] == "completed" and result["missing_boundaries"]:
            result["status"] = "capture_incomplete"
    return result


def main():
    supplied = json.loads(Path("/probe/input.json").read_text())
    interfaces = sorted(p.name for p in Path("/sys/class/net").iterdir()) if sys.platform == "linux" else []
    if sys.platform != "linux" or interfaces != ["lo"] or os.geteuid() == 0:
        raise RuntimeError("Offline runner requires Linux, unprivileged user and loopback-only networking")
    for path in ['/probe', '/probe/input.json', '/probe/offline-kernel-probe.py', '/probe/kin-kernel.bin', '/probe/real-cli', *[str(p) for p in Path('/probe/glibc239').glob('*')]]:
        if Path(path).exists() and os.access(path, os.W_OK):
            raise RuntimeError('Offline inputs must not be writable by the sandbox user')
    os.environ.clear()
    os.environ.update(PATH="/usr/bin:/bin", HOME="/home/kincli", TMPDIR="/work", LANG="C.UTF-8")
    observed, verified = verified_binary_inputs(supplied['meta'])
    output = {"version": 1, "nonce": supplied["nonce"], "simulation": True, "network_isolated": True,
              "network_interfaces": interfaces, "credentials": "dummy_only", "inputs_readonly": True,
              "binary_inputs_verified": verified, "observed_binary_hashes": observed,
              "node_envelope": supplied["envelope"], "stages": []}
    if not verified:
        output['error'] = {'code': 'uploaded_binary_hash_mismatch', 'message': 'No native process was started'}
        print(dump(output), flush=True)
        return
    for name in ("fake_cli", "mock_api"):
        output["stages"].append(run_phase(name, supplied))
    print(dump(output), flush=True)


if __name__ == "__main__":
    if len(sys.argv) > 2 and sys.argv[1] in ("--fake-cli", "--proxy-cli"):
        mode, stage, args = sys.argv[1], sys.argv[2], sys.argv[3:]
        sys.exit((fake_cli(stage, args) if mode == "--fake-cli" else proxy_cli(stage, args)) or 0)
    else:
        main()
