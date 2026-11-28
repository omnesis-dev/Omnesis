// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import DesktopCore
import Foundation
import XCTest

final class BackgroundNearbyProtocolTests: XCTestCase {
    private let epoch = String(repeating: "a", count: 64)
    private let binding = DesktopBackgroundLaunchProtocol.Binding(
        configDirHash: String(repeating: "b", count: 64),
        instance: "desktop-" + String(repeating: "c", count: 16),
        secretService: "dev.omnesis.desktop." + String(repeating: "c", count: 64)
    )

    func testSnapshotIsActionScopedAndKeepsExactRequestNonce() throws {
        let request = DesktopBackgroundLaunchProtocol.Request(action: .nearbySnapshot, binding: binding, expectedEpoch: epoch)
        let snapshot = try DesktopNearbyGatewayHints.Snapshot(state: .denied)
        let reply = DesktopBackgroundLaunchProtocol.Reply(request: request, epoch: epoch, state: .nearbySnapshot, nearby: snapshot)
        XCTAssertEqual(
            try DesktopBackgroundLaunchProtocol.decodeReply(DesktopBackgroundLaunchProtocol.encode(reply), request: request),
            reply
        )
        let other = DesktopBackgroundLaunchProtocol.Request(action: .nearbySnapshot, binding: binding, expectedEpoch: epoch)
        XCTAssertThrowsError(try DesktopBackgroundLaunchProtocol.decodeReply(DesktopBackgroundLaunchProtocol.encode(reply), request: other))
        let hello = DesktopBackgroundLaunchProtocol.Request(action: .hello, binding: binding, expectedEpoch: epoch)
        let leaked = DesktopBackgroundLaunchProtocol.Reply(request: hello, epoch: epoch, state: .helperIdle, nearby: snapshot)
        XCTAssertThrowsError(try DesktopBackgroundLaunchProtocol.decodeReply(
            DesktopBackgroundLaunchProtocol.encode(leaked),
            request: hello
        ))
        let absent = DesktopBackgroundLaunchProtocol.Reply(request: request, epoch: epoch, state: .nearbySnapshot)
        XCTAssertThrowsError(try DesktopBackgroundLaunchProtocol.decodeReply(
            DesktopBackgroundLaunchProtocol.encode(absent),
            request: request
        ))
    }

    func testReadOnlyRequestCannotCarryAddressActivationOrOriginAuthority() throws {
        let request = DesktopBackgroundLaunchProtocol.Request(action: .nearbySnapshot, binding: binding, expectedEpoch: epoch)
        let raw = try XCTUnwrap(JSONSerialization.jsonObject(with: DesktopBackgroundLaunchProtocol.encode(request)) as? [String: Any])
        for (key, value) in [
            ("candidates", [] as Any),
            ("activation", ["operationId": UUID().uuidString, "attemptId": UUID().uuidString, "epoch": epoch] as Any),
            ("handoffNonce", UUID().uuidString as Any),
        ] {
            var changed = raw
            changed[key] = value
            XCTAssertThrowsError(try DesktopBackgroundLaunchProtocol.decodeRequest(JSONSerialization.data(withJSONObject: changed)))
        }
    }
}
