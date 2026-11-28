// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Darwin
@testable import DesktopCore
import Foundation
import XCTest

final class BackgroundOriginHandoffTests: XCTestCase {
    private func scope() -> DesktopBackgroundDaemonAuthority.Scope {
        .init(
            format: 1,
            configDir: "/example/owned-home",
            instance: "desktop-" + String(repeating: "a", count: 16),
            secretService: "dev.omnesis.desktop." + String(repeating: "a", count: 64)
        )
    }

    private func encoded(_ value: [String: Any]) throws -> String {
        try JSONSerialization.data(withJSONObject: value).base64EncodedString().replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(
                of: "/",
                with: "_"
            ).replacingOccurrences(of: "=", with: "")
    }

    func testCorrelationRequiresActualVerifiedClientBirthNonceAndTarget() throws {
        let epoch = String(repeating: "b", count: 64)
        let claim = try DesktopBackgroundOriginHandoff.current(scope: scope(), epoch: epoch)
        let identity = try DesktopBackgroundProcessIdentity.read(getpid())
        let peer = DesktopBackgroundPeerTrust.Peer(
            pid: getpid(),
            executable: URL(fileURLWithPath: "/example/runtime-exec"),
            kind: .client,
            identity: identity
        )
        XCTAssertEqual(try DesktopBackgroundOriginHandoff.decode(claim.encoded()), claim)
        XCTAssertTrue(claim.matches(peer: peer, nonce: claim.nonce, scope: scope(), epoch: epoch))
        XCTAssertFalse(claim.matches(peer: peer, nonce: UUID().uuidString.lowercased(), scope: scope(), epoch: epoch))
        XCTAssertFalse(claim.matches(peer: peer, nonce: claim.nonce, scope: scope(), epoch: String(repeating: "c", count: 64)))
        let observer = DesktopBackgroundPeerTrust.Peer(
            pid: getpid(),
            executable: URL(fileURLWithPath: "/example/Omnesis"),
            kind: .observer,
            identity: identity
        )
        XCTAssertFalse(claim.matches(peer: observer, nonce: claim.nonce, scope: scope(), epoch: epoch))
        let otherBirth = DesktopBackgroundProcessIdentity(
            pid: identity.pid,
            parent: identity.parent,
            startedSeconds: identity.startedSeconds + 1,
            startedMicroseconds: identity.startedMicroseconds
        )
        let recycled = DesktopBackgroundPeerTrust.Peer(pid: getpid(), executable: peer.executable, kind: .client, identity: otherBirth)
        XCTAssertFalse(claim.matches(peer: recycled, nonce: claim.nonce, scope: scope(), epoch: epoch))
    }

    func testCorrelationCannotCarryAnOriginPathOrExecutableAuthority() throws {
        let claim = try DesktopBackgroundOriginHandoff.current(scope: scope(), epoch: String(repeating: "b", count: 64))
        let original = try XCTUnwrap(JSONSerialization.jsonObject(with: JSONEncoder().encode(claim)) as? [String: Any])
        for key in ["origin", "path", "executable", "environment", "bookmark"] {
            var changed = original
            changed[key] = "/example/another.app"
            XCTAssertThrowsError(try DesktopBackgroundOriginHandoff.decode(encoded(changed)))
        }
        var changed = original
        changed["birth"] = ["seconds": "01", "microseconds": "0"]
        XCTAssertThrowsError(try DesktopBackgroundOriginHandoff.decode(encoded(changed)))
    }

    func testOriginAdoptionFrameCannotBeAnOrdinaryHelloOrMixedAuthority() throws {
        let epoch = String(repeating: "b", count: 64)
        let binding = DesktopBackgroundLaunchProtocol.Binding(
            configDirHash: String(repeating: "c", count: 64),
            instance: scope().instance,
            secretService: scope().secretService
        )
        let record = DesktopBackgroundApplicationOrigin.Record(
            version: 1,
            referenceURL: "file:///.file/id=1.2",
            device: "1",
            inode: "2",
            observedEpoch: epoch,
            revision: UUID().uuidString.lowercased()
        )
        let nonce = UUID().uuidString.lowercased()
        let adopt = DesktopBackgroundLaunchProtocol.Request(
            action: .adoptOrigin,
            binding: binding,
            expectedEpoch: epoch,
            origin: record,
            handoffNonce: nonce
        )
        XCTAssertEqual(try DesktopBackgroundLaunchProtocol.decodeRequest(DesktopBackgroundLaunchProtocol.encode(adopt)), adopt)
        for request in [
            DesktopBackgroundLaunchProtocol.Request(
                action: .hello,
                binding: binding,
                expectedEpoch: epoch,
                origin: record,
                handoffNonce: nonce
            ),
            DesktopBackgroundLaunchProtocol.Request(action: .adoptOrigin, binding: binding, expectedEpoch: epoch, origin: record),
            DesktopBackgroundLaunchProtocol.Request(
                action: .adoptOrigin,
                binding: binding,
                expectedEpoch: epoch,
                activation: .init(operationId: UUID().uuidString.lowercased(), attemptId: UUID().uuidString.lowercased(), epoch: epoch),
                origin: record,
                handoffNonce: nonce
            ),
        ] {
            XCTAssertThrowsError(try DesktopBackgroundLaunchProtocol.decodeRequest(DesktopBackgroundLaunchProtocol.encode(request)))
        }
    }
}
