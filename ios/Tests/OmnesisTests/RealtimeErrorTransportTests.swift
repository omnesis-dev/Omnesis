// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

#if os(macOS)
import Foundation
@testable import Omnesis
import XCTest

/// Real URLSession transport against a single-use, loopback-only protocol peer.
final class RealtimeErrorTransportTests: XCTestCase {
    func testRejectedUpgradeRetainsHTTPStatus() async throws {
        for (status, expected) in [
            (400, "protocol_error"),
            (401, "pairing_rejected"),
            (403, "pairing_rejected"),
            (404, "unavailable"),
            (429, "rate_limited"),
        ] {
            let peer = try LoopbackVoicePeer(mode: "http", status: status)
            defer { peer.stop() }
            let session = makeSession()
            defer { session.invalidateAndCancel() }
            let socket = session.webSocketTask(with: peer.url)
            socket.resume()
            do {
                _ = try await socket.receive()
                XCTFail("Rejected upgrades must fail before any message")
            } catch {
                let response = socket.response as? HTTPURLResponse
                XCTAssertEqual(response?.statusCode, status)
                XCTAssertEqual(RealtimeCallFailure.local(error, httpStatus: response?.statusCode).code, expected)
            }
        }
    }

    func testFatalFrameArrivesBeforeImmediateClose() async throws {
        let peer = try LoopbackVoicePeer(mode: "fatal")
        defer { peer.stop() }
        let session = makeSession()
        defer { session.invalidateAndCancel() }
        let socket = session.webSocketTask(with: peer.url)
        socket.resume()
        let event = try await receiveEvent(socket)
        let failure = RealtimeCallFailure.server(event)
        XCTAssertEqual(failure.code, "quota_exhausted")
        XCTAssertTrue(failure.fatal)
        XCTAssertFalse(failure.retryable)
        XCTAssertFalse(failure.localizedDescription.contains("PRIVATE_SENTINEL"))
        do {
            _ = try await socket.receive()
            XCTFail("The peer sent an immediate close")
        } catch {
            XCTAssertEqual(RealtimeCallFailure.local(failure, httpStatus: 101, closeReason: socket.closeReason), failure)
        }
    }

    func testCloseReasonPreservesQuotaWithoutAnErrorFrame() async throws {
        let peer = try LoopbackVoicePeer(mode: "close")
        defer { peer.stop() }
        let session = makeSession()
        defer { session.invalidateAndCancel() }
        let socket = session.webSocketTask(with: peer.url)
        socket.resume()
        do {
            _ = try await socket.receive()
            XCTFail("The peer sent only a close frame")
        } catch {
            XCTAssertEqual(socket.closeCode, .internalServerError)
            let failure = RealtimeCallFailure.local(
                error,
                httpStatus: (socket.response as? HTTPURLResponse)?.statusCode,
                closeReason: socket.closeReason
            )
            XCTAssertEqual(failure.code, "quota_exhausted")
            XCTAssertTrue(failure.fatal)
            XCTAssertFalse(failure.retryable)
        }
    }

    func testNonfatalNoticeLeavesTheActualSocketUsable() async throws {
        let peer = try LoopbackVoicePeer(mode: "recoverable")
        defer { peer.stop() }
        let session = makeSession()
        defer { session.invalidateAndCancel() }
        let socket = session.webSocketTask(with: peer.url)
        socket.resume()
        let failure = try await RealtimeCallFailure.server(receiveEvent(socket))
        XCTAssertFalse(failure.fatal)
        XCTAssertEqual(failure.code, "rate_limited")
        try await socket.send(.string("probe"))
        let reply = try await receiveEvent(socket)
        XCTAssertEqual(reply["type"] as? String, "probe.ack")
        socket.cancel(with: .normalClosure, reason: nil)
    }

    private func makeSession() -> URLSession {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.timeoutIntervalForRequest = 5
        configuration.timeoutIntervalForResource = 5
        return URLSession(configuration: configuration)
    }

    private func receiveEvent(_ socket: URLSessionWebSocketTask) async throws -> [String: Any] {
        let message = try await socket.receive()
        let data: Data
        switch message {
        case .string(let text): data = Data(text.utf8)
        case .data(let bytes): data = bytes
        @unknown default: throw URLError(.cannotParseResponse)
        }
        return try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
    }
}

private final class LoopbackVoicePeer {
    let url: URL
    private let process: Process

    init(mode: String, status: Int = 403) throws {
        process = Process()
        let output = Pipe()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/env")
        process.arguments = ["python3", "-u", "-c", Self.server, mode, String(status)]
        process.standardOutput = output
        process.standardError = FileHandle.nullDevice
        try process.run()
        var line = Data()
        while let byte = try output.fileHandleForReading.read(upToCount: 1), !byte.isEmpty, byte != Data([10]) {
            line.append(byte)
        }
        guard let port = String(data: line, encoding: .utf8).flatMap(Int.init),
              let address = URL(string: "ws://127.0.0.1:\(port)/voice") else {
            if process.isRunning { process.terminate() }
            process.waitUntilExit()
            throw URLError(.cannotConnectToHost)
        }
        url = address
    }

    func stop() {
        if process.isRunning { process.terminate() }
        process.waitUntilExit()
    }

    private static let server = #"""
    import base64, hashlib, json, socket, struct, sys
    mode, status = sys.argv[1], int(sys.argv[2])
    def exact(conn, size):
        data = b''
        while len(data) < size:
            chunk = conn.recv(size - len(data))
            if not chunk: raise EOFError()
            data += chunk
        return data
    def frame(opcode, payload):
        if isinstance(payload, str): payload = payload.encode()
        length = len(payload)
        header = bytes([0x80 | opcode, length]) if length < 126 else bytes([0x80 | opcode, 126]) + struct.pack('!H', length)
        return header + payload
    with socket.socket() as listener:
        listener.bind(('127.0.0.1', 0))
        listener.listen(1)
        listener.settimeout(10)
        print(listener.getsockname()[1], flush=True)
        conn, _ = listener.accept()
        with conn:
            conn.settimeout(5)
            request = b''
            while b'\r\n\r\n' not in request:
                request += exact(conn, 1)
            if mode == 'http':
                conn.sendall(('HTTP/1.1 %d Rejected\r\nContent-Length: 0\r\nConnection: close\r\n\r\n' % status).encode())
            else:
                headers = dict(line.split(':', 1) for line in request.decode().split('\r\n')[1:] if ':' in line)
                key = next(value.strip() for name, value in headers.items() if name.lower() == 'sec-websocket-key')
                accept = base64.b64encode(hashlib.sha1((key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').encode()).digest()).decode()
                response = ('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\n'
                            'Connection: Upgrade\r\nSec-WebSocket-Accept: ' + accept + '\r\n\r\n')
                conn.sendall(response.encode())
                close = frame(8, struct.pack('!H', 1011) + b'voice_error:quota_exhausted')
                if mode == 'fatal':
                    event = {'type': 'error', 'error': {
                        'code': 'quota_exhausted', 'message': 'PRIVATE_SENTINEL', 'fatal': True, 'retryable': False}}
                    conn.sendall(frame(1, json.dumps(event)) + close)
                elif mode == 'close':
                    conn.sendall(close)
                else:
                    event = {'type': 'error', 'error': {'code': 'rate_limited', 'fatal': False, 'retryable': True}}
                    conn.sendall(frame(1, json.dumps(event)))
                    first, second = exact(conn, 2)
                    length = second & 127
                    if length == 126: length = struct.unpack('!H', exact(conn, 2))[0]
                    if length == 127: length = struct.unpack('!Q', exact(conn, 8))[0]
                    mask = exact(conn, 4) if second & 128 else b''
                    data = exact(conn, length)
                    if mask: data = bytes(value ^ mask[i % 4] for i, value in enumerate(data))
                    if first & 15 != 1 or data != b'probe': raise ValueError('Expected probe')
                    conn.sendall(frame(1, json.dumps({'type': 'probe.ack'})))
                    exact(conn, 2)
    """#
}
#endif
