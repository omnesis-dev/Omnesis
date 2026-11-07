// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation
@testable import Omnesis
import XCTest

final class GatewaySOCKSHandshakeTests: XCTestCase {
    private let greeting = Data([5, 2, 0, 2])
    private let user = "fixture-user"
    private let password = "fixture-password"
    private let host = "gateway.example.test"

    private func parser() -> GatewaySOCKSHandshake {
        GatewaySOCKSHandshake(hostname: host, port: 443, username: user, password: password)
    }

    private func authentication(user: String, password: String) -> Data {
        Data([1, UInt8(user.utf8.count)] + Array(user.utf8) + [UInt8(password.utf8.count)] + Array(password.utf8))
    }

    private func request(host: String, port: UInt16 = 443) -> Data {
        Data([5, 1, 0, 3, UInt8(host.utf8.count)] + Array(host.utf8) + [UInt8(port >> 8), UInt8(port & 255)])
    }

    func testEveryFragmentationBoundaryAndPipelinedNegotiationProducesOneAuthenticatedTarget() {
        let all = greeting + authentication(user: user, password: password) + request(host: host)
        let expected: [GatewaySOCKSHandshake.Effect] = [.reply(Data([5, 2])), .reply(Data([1, 0])), .connect]
        for split in 0 ... all.count {
            var value = parser()
            XCTAssertEqual(value.receive(all.prefix(split)) + value.receive(all.suffix(all.count - split)), expected)
            XCTAssertEqual(value.receive(all), [])
        }
        var fragmented = parser()
        XCTAssertEqual(all.flatMap { fragmented.receive(Data([$0])) }, expected)
        var uppercase = parser()
        XCTAssertEqual(
            uppercase.receive(greeting + authentication(user: user, password: password) + request(host: host.uppercased())),
            expected
        )
    }

    func testInvalidGreetingsCredentialsRequestsAndTrailingBytesFailClosed() {
        for invalid in [Data([4, 1, 2]), Data([5, 0]), Data([5, 1, 0])] {
            var value = parser()
            XCTAssertEqual(value.receive(invalid), [.reject(Data([5, 255]))])
            XCTAssertEqual(value.receive(greeting), [])
        }
        let badCredentials = [
            Data([2, 1, 65, 1, 66]),
            Data([1, 0]),
            Data([1, 1, 65, 0]),
            authentication(user: "short", password: password),
            authentication(user: "fixture-User", password: password),
            authentication(user: user, password: "wrong-password!!"),
        ]
        for invalid in badCredentials {
            var value = parser()
            _ = value.receive(greeting)
            XCTAssertEqual(value.receive(invalid), [.reject(Data([1, 1]))])
        }
        let valid = request(host: host)
        for (index, byte) in [(0, UInt8(4)), (1, UInt8(2)), (2, UInt8(1)), (3, UInt8(1)), (4, UInt8(0))] {
            var invalid = valid
            invalid[index] = byte
            var value = parser()
            _ = value.receive(greeting + authentication(user: user, password: password))
            XCTAssertEqual(value.receive(invalid), [.reject(Data([5, 7, 0, 1, 0, 0, 0, 0, 0, 0]))])
        }
        for invalid in [request(host: "attacker.example.test"), request(host: host, port: 444), valid + Data([1])] {
            var value = parser()
            _ = value.receive(greeting + authentication(user: user, password: password))
            XCTAssertEqual(value.receive(invalid), [.reject(Data([5, 2, 0, 1, 0, 0, 0, 0, 0, 0]))])
        }
    }

    func testHandshakeBuffersRemainBoundedAndTerminalStatesCannotRestart() {
        var value = parser()
        XCTAssertEqual(value.receive(Data(repeating: 5, count: 2049)), [.reject(Data([5, 1, 0, 1, 0, 0, 0, 0, 0, 0]))])
        XCTAssertEqual(value.receive(greeting), [])
    }
}
