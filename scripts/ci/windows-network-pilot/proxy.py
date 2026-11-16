#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (c) 2026 Adrien Conrath

"""Disposable Windows CI DNS proxy; production questions are refused and recorded."""
import asyncio
import json
import socket
import struct
import sys
import time


def question(packet):
    if len(packet) < 12:
        raise ValueError("Short DNS packet")
    labels, offset = [], 12
    while offset < len(packet) and packet[offset]:
        length = packet[offset]
        if length > 63 or offset + length + 1 > len(packet):
            raise ValueError("Invalid DNS question")
        labels.append(packet[offset + 1:offset + length + 1].decode("ascii").lower())
        offset += length + 1
    if offset + 5 > len(packet):
        raise ValueError("Truncated DNS question")
    return ".".join(labels)


def refusal(packet, code):
    return packet[:2] + bytes([0x80 | (packet[2] & 0x79), 0x80 | code]) + packet[4:6] + b"\x00" * 6 + packet[12:]


async def main():
    config = json.load(open(sys.argv[1], encoding="utf-8-sig"))
    loop = asyncio.get_running_loop()
    pending = set()

    async def answer(packet, tcp=False):
        try:
            name = question(packet)
        except (ValueError, UnicodeError):
            return None
        if any(name == suffix or name.endswith("." + suffix) for suffix in config["deny"]):
            with open(config["record"], "a", encoding="utf-8") as out:
                out.write(f"{time.time_ns()} DNS query for {name}\n")
            return refusal(packet, 5)
        for server in config["upstream"]:
            try:
                if tcp:
                    reader, writer = await asyncio.wait_for(asyncio.open_connection(server, 53), 2)
                    try:
                        writer.write(struct.pack("!H", len(packet)) + packet)
                        await writer.drain()
                        length = struct.unpack("!H", await asyncio.wait_for(reader.readexactly(2), 2))[0]
                        response = await asyncio.wait_for(reader.readexactly(length), 2)
                    finally:
                        writer.close()
                        await writer.wait_closed()
                else:
                    with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as upstream:
                        upstream.setblocking(False)
                        await loop.sock_sendto(upstream, packet, (server, 53))
                        response, peer = await asyncio.wait_for(loop.sock_recvfrom(upstream, 65535), 2)
                        if peer[0] != server:
                            continue
                if len(response) >= 12 and response[:2] == packet[:2]:
                    return response
            except (OSError, TimeoutError, asyncio.IncompleteReadError):
                continue
        return refusal(packet, 2)

    class UDP(asyncio.DatagramProtocol):
        def connection_made(self, transport):
            self.transport = transport

        def datagram_received(self, packet, peer):
            if len(pending) >= 128:
                return

            async def run():
                response = await answer(packet)
                if response is not None:
                    self.transport.sendto(response, peer)

            task = asyncio.create_task(run())
            pending.add(task)
            task.add_done_callback(pending.discard)

    async def tcp(reader, writer):
        try:
            while True:
                length = struct.unpack("!H", await asyncio.wait_for(reader.readexactly(2), 5))[0]
                packet = await asyncio.wait_for(reader.readexactly(length), 5)
                response = await answer(packet, tcp=True)
                if response is None:
                    return
                writer.write(struct.pack("!H", len(response)) + response)
                await writer.drain()
        except (OSError, TimeoutError, asyncio.IncompleteReadError):
            pass
        finally:
            writer.close()
            await writer.wait_closed()

    await loop.create_datagram_endpoint(UDP, local_addr=("127.0.0.1", 53))
    server = await asyncio.start_server(tcp, "127.0.0.1", 53)
    print("ready", flush=True)
    async with server:
        await server.serve_forever()


if __name__ == "__main__":
    asyncio.run(main())
