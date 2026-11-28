// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

@testable import DesktopCore
import XCTest

final class ArtifactPresentationTests: XCTestCase {
    private func artifact(
        _ encrypted: Bool,
        protection: String?,
        id: String = String(repeating: "a", count: 64)
    ) throws
        -> DesktopArtifact {
        var object: [String: Any] = [
            "id": id,
            "kind": "backup",
            "createdAt": "2030-01-01T00:00:00.000Z",
            "bytes": 1024,
            "encrypted": encrypted,
        ]
        if let protection { object["protection"] = protection }
        return try JSONDecoder().decode(DesktopArtifact.self, from: JSONSerialization.data(withJSONObject: object))
    }

    func testReadableAndUnknownProtectionRequireExplicitConsent() throws {
        XCTAssertTrue(try artifact(false, protection: "plaintext").requiresReadableContentConsent)
        XCTAssertTrue(try artifact(false, protection: "mixed").requiresReadableContentConsent)
        XCTAssertTrue(try artifact(true, protection: nil).requiresReadableContentConsent)
        let sealed = try artifact(true, protection: "encrypted-payloads")
        XCTAssertFalse(sealed.requiresReadableContentConsent)
        XCTAssertTrue(sealed.protectionLabel.contains("metadata"))
    }

    func testOnlyOpaqueCatalogIdsBecomeDownloadPaths() throws {
        for id in ["../other", String(repeating: "A", count: 64), String(repeating: "a", count: 63)] {
            XCTAssertFalse(try artifact(true, protection: "encrypted-payloads", id: id).valid)
        }
        XCTAssertTrue(try artifact(true, protection: "encrypted-payloads").valid)
    }
}
