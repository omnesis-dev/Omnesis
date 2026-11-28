// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import DesktopCore
import Foundation
import XCTest

final class BackgroundLaunchProtocolTests: XCTestCase {
    private let binding = DesktopBackgroundLaunchProtocol.Binding(
        configDirHash: String(repeating: "a", count: 64), instance: "desktop-" + String(repeating: "b", count: 16),
        secretService: "dev.omnesis.desktop." + String(repeating: "b", count: 64)
    )
    private let epoch = String(repeating: "c", count: 64)

    func testRoundTripIsFixedMetadataAndRestorationTupleRemainsExact() throws {
        let activation = DesktopBackgroundLaunchProtocol.Activation(
            operationId: UUID().uuidString.lowercased(), attemptId: UUID().uuidString.lowercased(), epoch: epoch
        )
        let request = DesktopBackgroundLaunchProtocol.Request(
            action: .ensureDaemon,
            binding: binding,
            expectedEpoch: epoch,
            activation: activation
        )
        let decoded = try DesktopBackgroundLaunchProtocol.decodeRequest(DesktopBackgroundLaunchProtocol.encode(request))
        XCTAssertEqual(decoded, request)
        XCTAssertEqual(decoded.activation, activation)
        let reply = DesktopBackgroundLaunchProtocol.Reply(request: request, epoch: epoch, state: .daemonOwned, daemonPid: 123)
        XCTAssertEqual(
            try DesktopBackgroundLaunchProtocol.decodeReply(DesktopBackgroundLaunchProtocol.encode(reply), request: request),
            reply
        )
    }

    func testUnknownCommandsPathsAndMalformedBindingAreRejectedBeforeLaunch() throws {
        let request = DesktopBackgroundLaunchProtocol.Request(action: .ensureDaemon, binding: binding, expectedEpoch: epoch)
        let data = try DesktopBackgroundLaunchProtocol.encode(request)
        let original = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        for key in ["executable", "argv", "environment", "cwd", "script"] {
            var changed = original
            changed[key] = "/example/untrusted"
            XCTAssertThrowsError(try DesktopBackgroundLaunchProtocol.decodeRequest(JSONSerialization.data(withJSONObject: changed)))
        }
        var changed = original
        changed["action"] = "erase"
        XCTAssertThrowsError(try DesktopBackgroundLaunchProtocol.decodeRequest(JSONSerialization.data(withJSONObject: changed)))
        changed = original
        changed["binding"] = ["configDirHash": "bad", "instance": binding.instance, "secretService": binding.secretService]
        XCTAssertThrowsError(try DesktopBackgroundLaunchProtocol.decodeRequest(JSONSerialization.data(withJSONObject: changed)))
    }

    func testHelloCannotCarryActivationAndAnotherEpochCannotBeUsed() throws {
        let activation = DesktopBackgroundLaunchProtocol.Activation(
            operationId: UUID().uuidString.lowercased(), attemptId: UUID().uuidString.lowercased(), epoch: epoch
        )
        let hello = DesktopBackgroundLaunchProtocol.Request(action: .hello, binding: binding, expectedEpoch: epoch, activation: activation)
        XCTAssertThrowsError(try DesktopBackgroundLaunchProtocol.decodeRequest(DesktopBackgroundLaunchProtocol.encode(hello)))
        let mismatched = DesktopBackgroundLaunchProtocol.Request(
            action: .ensureDaemon,
            binding: binding,
            expectedEpoch: String(repeating: "d", count: 64),
            activation: activation
        )
        XCTAssertThrowsError(try DesktopBackgroundLaunchProtocol.decodeRequest(DesktopBackgroundLaunchProtocol.encode(mismatched)))
    }

    func testReplyNeedsExactNonceScopeAndOwnedDaemonState() throws {
        let request = DesktopBackgroundLaunchProtocol.Request(action: .ensureDaemon, binding: binding, expectedEpoch: epoch)
        let other = DesktopBackgroundLaunchProtocol.Request(action: .ensureDaemon, binding: binding, expectedEpoch: epoch)
        let stale = DesktopBackgroundLaunchProtocol.Reply(request: other, epoch: epoch, state: .daemonOwned, daemonPid: 123)
        XCTAssertThrowsError(try DesktopBackgroundLaunchProtocol.decodeReply(
            DesktopBackgroundLaunchProtocol.encode(stale),
            request: request
        ))
        for (state, pid) in [(DesktopBackgroundLaunchProtocol.State.daemonOwned, Int32?.none), (.helperIdle, Int32?(123))] {
            let invalid = DesktopBackgroundLaunchProtocol.Reply(request: request, epoch: epoch, state: state, daemonPid: pid)
            XCTAssertThrowsError(try DesktopBackgroundLaunchProtocol.decodeReply(
                DesktopBackgroundLaunchProtocol.encode(invalid),
                request: request
            ))
        }
        let mismatch = DesktopBackgroundLaunchProtocol.Reply(
            request: request,
            epoch: String(repeating: "d", count: 64),
            state: .epochMismatch
        )
        XCTAssertThrowsError(try DesktopBackgroundLaunchProtocol.decodeReply(
            DesktopBackgroundLaunchProtocol.encode(mismatch),
            request: request
        ))
        let hello = DesktopBackgroundLaunchProtocol.Request(action: .hello, binding: binding, expectedEpoch: epoch)
        let selected = DesktopBackgroundLaunchProtocol.Reply(
            request: hello,
            epoch: String(repeating: "d", count: 64),
            state: .epochMismatch
        )
        XCTAssertEqual(
            try DesktopBackgroundLaunchProtocol.decodeReply(DesktopBackgroundLaunchProtocol.encode(selected), request: hello).state,
            .epochMismatch
        )
    }

    func testOversizedMalformedAndUnsupportedVersionFramesAreRefused() throws {
        XCTAssertThrowsError(try DesktopBackgroundLaunchProtocol.decodeRequest(Data(repeating: 32, count: 4097)))
        XCTAssertThrowsError(try DesktopBackgroundLaunchProtocol.decodeRequest(Data("invalid".utf8)))
        let request = DesktopBackgroundLaunchProtocol.Request(action: .hello, binding: binding, expectedEpoch: epoch)
        var object = try XCTUnwrap(JSONSerialization.jsonObject(with: DesktopBackgroundLaunchProtocol.encode(request)) as? [String: Any])
        object["version"] = 2
        XCTAssertThrowsError(try DesktopBackgroundLaunchProtocol.decodeRequest(JSONSerialization.data(withJSONObject: object)))
    }
}
