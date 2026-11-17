#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (c) 2026 Adrien Conrath

"""A DNS server that answers nothing: every query is refused and its name recorded.

`scripts/ci/production-network.sh` points a macOS runner's resolver for
omnesis.app at it, so a CI test job can neither resolve a production name nor
try to without the job's record showing it.

    dns-sink.py PORT RECORD
"""

import socket
import sys
import time


def query_name(packet: bytes) -> str:
    labels, offset = [], 12
    while offset < len(packet) and packet[offset]:
        length = packet[offset]
        labels.append(packet[offset + 1 : offset + 1 + length].decode("ascii", "replace"))
        offset += 1 + length
    return ".".join(labels)


def refused(packet: bytes) -> bytes:
    # Same id and question, QR set, RCODE 5 (REFUSED), no answers.
    flags = bytes([0x80 | (packet[2] & 0x79), 0x05])
    return packet[:2] + flags + packet[4:6] + b"\x00\x00\x00\x00\x00\x00" + packet[12:]


def main() -> None:
    port, record = int(sys.argv[1]), sys.argv[2]
    sink = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    sink.bind(("127.0.0.1", port))
    print("ready", flush=True)
    while True:
        packet, peer = sink.recvfrom(4096)
        if len(packet) < 12:
            continue
        with open(record, "a", encoding="utf-8") as out:
            out.write(f"{time.strftime('%H:%M:%S')} DNS query for {query_name(packet)}\n")
        sink.sendto(refused(packet), peer)


if __name__ == "__main__":
    main()
