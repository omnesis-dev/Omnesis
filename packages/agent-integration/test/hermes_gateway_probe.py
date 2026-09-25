# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (c) 2026 Adrien Conrath

"""Run the production Hermes hello against a live plaintext loopback gateway."""

import asyncio
import base64
import importlib.util
import json
import os
import secrets
import struct
import sys
import threading
import types
import urllib.parse
from pathlib import Path


class Platform(str):
    pass


class PlatformConfig:
    def __init__(self, extra=None):
        self.extra = extra or {}


class MessageType:
    TEXT = "text"


class MessageEvent:
    def __init__(self, **kwargs):
        self.__dict__.update(kwargs)


class SendResult:
    def __init__(self, **kwargs):
        self.__dict__.update(kwargs)


class BasePlatformAdapter:
    def __init__(self, config, platform):
        self.config = config
        self.platform = platform
        self._message_handler = object()
        self.events = []

    def build_source(self, **kwargs):
        return types.SimpleNamespace(platform=self.platform, **kwargs)

    async def handle_message(self, event):
        self.events.append(event)


gateway = types.ModuleType("gateway")
gateway_config = types.ModuleType("gateway.config")
gateway_config.Platform = Platform
gateway_config.PlatformConfig = PlatformConfig
gateway_platforms = types.ModuleType("gateway.platforms")
gateway_base = types.ModuleType("gateway.platforms.base")
gateway_base.BasePlatformAdapter = BasePlatformAdapter
gateway_base.MessageEvent = MessageEvent
gateway_base.MessageType = MessageType
gateway_base.SendResult = SendResult
sys.modules["gateway"] = gateway
sys.modules["gateway.config"] = gateway_config
sys.modules["gateway.platforms"] = gateway_platforms
sys.modules["gateway.platforms.base"] = gateway_base


class LoopbackWebSocket:
    def __init__(self, url, subprotocols, **_kwargs):
        self.url = url
        self.subprotocols = subprotocols
        self.reader = None
        self.writer = None
        self.transport = None
        self.response_count = 0
        self.expected_responses = int(
            os.environ.get("OMNESIS_HERMES_EXPECT_RESPONSES", "0")
        )

    async def __aenter__(self):
        parsed = urllib.parse.urlparse(self.url)
        if parsed.scheme != "ws" or parsed.hostname not in {"127.0.0.1", "localhost"}:
            raise RuntimeError("probe accepts only a plaintext loopback WebSocket")
        if parsed.path != "/device/ws":
            raise RuntimeError(f"Hermes used the wrong gateway path: {parsed.path}")
        self.reader, self.writer = await asyncio.open_connection(
            parsed.hostname, parsed.port
        )
        key = base64.b64encode(secrets.token_bytes(16)).decode("ascii")
        protocol = self.subprotocols[0]
        request = (
            f"GET {parsed.path} HTTP/1.1\r\n"
            f"Host: {parsed.hostname}:{parsed.port}\r\n"
            "Upgrade: websocket\r\n"
            "Connection: Upgrade\r\n"
            f"Sec-WebSocket-Key: {key}\r\n"
            "Sec-WebSocket-Version: 13\r\n"
            f"Sec-WebSocket-Protocol: {protocol}\r\n\r\n"
        )
        self.writer.write(request.encode("ascii"))
        await self.writer.drain()
        response = await self.reader.readuntil(b"\r\n\r\n")
        if not response.startswith(b"HTTP/1.1 101"):
            raise RuntimeError(f"gateway rejected upgrade: {response!r}")
        return self

    async def __aexit__(self, _exc_type, _exc, _traceback):
        await self.close()

    async def close(self):
        if self.writer is not None:
            self.writer.close()
            await self.writer.wait_closed()
            self.writer = None

    async def _send_frame(self, opcode, payload):
        assert self.writer is not None
        mask = secrets.token_bytes(4)
        length = len(payload)
        if length < 126:
            header = bytes([0x80 | opcode, 0x80 | length])
        elif length <= 0xFFFF:
            header = bytes([0x80 | opcode, 0x80 | 126]) + struct.pack("!H", length)
        else:
            header = bytes([0x80 | opcode, 0x80 | 127]) + struct.pack("!Q", length)
        masked = bytes(byte ^ mask[index % 4] for index, byte in enumerate(payload))
        self.writer.write(header + mask + masked)
        await self.writer.drain()

    async def send(self, value):
        await self._send_frame(0x1, value.encode("utf-8"))
        parsed = json.loads(value)
        if isinstance(parsed, dict) and parsed.get("kind") == "response":
            self.response_count += 1

    async def recv(self):
        assert self.reader is not None
        while True:
            first, second = await self.reader.readexactly(2)
            opcode = first & 0x0F
            length = second & 0x7F
            if length == 126:
                length = struct.unpack("!H", await self.reader.readexactly(2))[0]
            elif length == 127:
                length = struct.unpack("!Q", await self.reader.readexactly(8))[0]
            if second & 0x80:
                mask = await self.reader.readexactly(4)
            else:
                mask = None
            payload = await self.reader.readexactly(length)
            if mask is not None:
                payload = bytes(
                    byte ^ mask[index % 4] for index, byte in enumerate(payload)
                )
            if opcode == 0x9:
                await self._send_frame(0xA, payload)
                continue
            if opcode == 0x8:
                raise RuntimeError("gateway closed before hello response")
            if opcode == 0x1:
                return payload.decode("utf-8")

    def __aiter__(self):
        return self

    async def __anext__(self):
        if self.response_count >= self.expected_responses:
            raise StopAsyncIteration
        return await self.recv()


websockets = types.ModuleType("websockets")
websockets.connect = lambda url, **kwargs: LoopbackWebSocket(url, **kwargs)
sys.modules["websockets"] = websockets


async def main():
    adapter_path = Path(os.environ["OMNESIS_HERMES_ADAPTER_PATH"])
    spec = importlib.util.spec_from_file_location("omnesis_hermes_probe_adapter", adapter_path)
    if not spec or not spec.loader:
        raise RuntimeError("could not load Hermes adapter")
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)

    if os.environ.get("OMNESIS_HERMES_REAL_MCP") == "1":
        instance = module.OmnesisAdapter.for_tools()
        instance._session_identity = lambda _session_id: ("slack", "probe")
        result = json.loads(
            instance.answer(
                {"question": os.environ["OMNESIS_HERMES_QUESTION"]},
                "session_probe",
            )
        )
        if result.get("status") not in {"released", "released_with_reductions"}:
            raise RuntimeError(f"production Hermes MCP answer failed: {result!r}")
        if result.get("answer") != os.environ["OMNESIS_HERMES_EXPECTED_ANSWER"]:
            raise RuntimeError("production Hermes MCP answer content did not match")
        if instance._state is not None:
            instance._state.close()
        print(json.dumps({"status": "MCP_OAUTH_OK", "answer": result}))
        return

    instance = module.OmnesisAdapter(PlatformConfig())
    instance._credentials = module.Credentials(
        gateway_url=os.environ["OMNESIS_HERMES_GATEWAY_URL"],
        delivery_token=os.environ["OMNESIS_HERMES_DELIVERY_TOKEN"],
        ingestion_token="omn_fictional_ingestion",
        management_token="omn_fictional_management",
        oauth_client_id="client_fictional",
        oauth_access_token="principal_access_fictional",
        oauth_refresh_token="principal_refresh_fictional",
        ca_pem=None,
        leaf_fingerprint_sha256=None,
    )
    state_path = Path(os.environ["OMNESIS_HERMES_STATE_PATH"])
    instance._state = module.DurableState(state_path)
    try:
        await instance._delivery_connection()
        # Hermes executes native tool handlers on an agent-worker thread. The
        # adapter must not reuse its gateway-thread SQLite connection there.
        instance._session_identity = lambda _session_id: ("slack", "probe")
        instance._mcp_call_tool = lambda *_args, **_kwargs: {
            "workflowId": "wf_probe",
            "conversationId": "conv_probe",
            "taskId": "task_probe_answer",
            "status": "released",
            "releaseId": "release_probe",
            "answer": "Fictional probe answer.",
        }
        answer_result = []
        answer_thread = threading.Thread(
            target=lambda: answer_result.append(
                instance.answer({"question": "probe question"}, "session_probe")
            )
        )
        answer_thread.start()
        answer_thread.join(timeout=2)
        if answer_thread.is_alive() or not answer_result:
            raise RuntimeError("worker-thread Omnesis answer failed")
        parsed_answer = json.loads(answer_result[0])
        if parsed_answer.get("taskId") != "task_probe_answer" or parsed_answer.get("status") != "released":
            raise RuntimeError("worker-thread Omnesis answer was malformed")
        orphan_origin = instance._state.prepare_answer_origin("request_orphan", "session_orphan")
        if instance._state.answer_origin_for_completion(orphan_origin, "task_orphan") != "session_orphan":
            raise RuntimeError("completion did not recover a timed-out answer origin")
        states = dict(
            instance._state.connection.execute(
                "SELECT delivery_id, state FROM integration_inbox"
            ).fetchall()
        )
    finally:
        instance._state.close()
    print(
        json.dumps(
            {
                "status": (
                    "PROTOCOL_OK"
                    if int(os.environ.get("OMNESIS_HERMES_EXPECT_RESPONSES", "0"))
                    else "HELLO_OK"
                ),
                "starts": len(instance.events),
                "states": states,
                "answerThread": True,
            }
        )
    )


asyncio.run(main())
