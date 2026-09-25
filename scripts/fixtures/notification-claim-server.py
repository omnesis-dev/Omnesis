#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (c) 2026 Omnesis contributors

"""Single-delivery HTTPS fixture for the signed iOS push spike."""

import argparse
import json
import ssl
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path


class Handler(BaseHTTPRequestHandler):
    delivery_claimed = False
    state_path: Path

    def do_GET(self):
        if self.path == "/health":
            self.reply(200, {"ok": True})
            return
        self.reply(404, {"error": "not_found"})

    def do_POST(self):
        length = int(self.headers.get("Content-Length", "0"))
        raw = self.rfile.read(length)
        try:
            body = json.loads(raw or b"{}")
        except json.JSONDecodeError:
            self.reply(400, {"error": "invalid_json"})
            return

        if self.path == "/notifications/claim":
            if self.headers.get("Authorization") != "Bearer spike-claim-token":
                self.reply(401, {"error": "unauthorized"})
                return
            self.record({"path": self.path, "body": body})
            if Handler.delivery_claimed:
                self.send_response(204)
                self.end_headers()
                return
            Handler.delivery_claimed = True
            self.reply(
                200,
                {
                    "id": "delivery_spike_1",
                    "kind": "agent-answer",
                    "targetId": "conv_spike_1",
                    "title": "Fetched title from the paired gateway",
                    "body": "Fetched body from the paired gateway.",
                    "collapseId": "conversation:conv_spike_1",
                    "remaining": 7,
                },
            )
            return

        if self.path == "/notifications/confirm":
            if self.headers.get("Authorization") != "Bearer spike-claim-token":
                self.reply(401, {"error": "unauthorized"})
                return
            self.record({"path": self.path, "body": body})
            if body != {"id": "delivery_spike_1"}:
                self.reply(400, {"error": "wrong_delivery"})
                return
            self.reply(200, {"ok": True})
            return

        # The paired app may attempt legacy APNs registration during setup.
        self.reply(404, {"error": "fixture_route_not_implemented"})

    def log_message(self, _format, *_args):
        return

    def record(self, event):
        with Handler.state_path.open("a", encoding="utf-8") as output:
            output.write(json.dumps(event, separators=(",", ":")) + "\n")

    def reply(self, status, body):
        encoded = json.dumps(body, separators=(",", ":")).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(encoded)))
        self.end_headers()
        self.wfile.write(encoded)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, required=True)
    parser.add_argument("--cert", required=True)
    parser.add_argument("--key", required=True)
    parser.add_argument("--state", required=True)
    args = parser.parse_args()

    Handler.state_path = Path(args.state)
    server = HTTPServer(("127.0.0.1", args.port), Handler)
    context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    context.load_cert_chain(args.cert, args.key)
    server.socket = context.wrap_socket(server.socket, server_side=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
