// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

#if canImport(Security)
import Foundation
@testable import Omnesis
import Security
import XCTest

/// Asserts the Keychain security posture for stored secrets (notably the
/// gateway bearer token) without needing a live Keychain: the add attributes
/// must be device-only and never iCloud-synced.
final class KeychainTests: XCTestCase {
    func testAddQueryIsDeviceOnlyAndNotSynchronizable() {
        let attrs = Keychain.addQuery(
            service: "dev.omnesis.ios.pairing",
            key: "gateway.token",
            data: Data("secret-token".utf8)
        )

        // Never synced to iCloud Keychain / other devices.
        guard let synchronizable = attrs[kSecAttrSynchronizable as String] else {
            XCTFail("synchronizable attribute must be present")
            return
        }
        XCTAssertTrue(CFEqual(synchronizable as AnyObject, kCFBooleanFalse))

        // Bound to this device only, readable after first unlock.
        XCTAssertEqual(
            attrs[kSecAttrAccessible as String] as? String,
            kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly as String
        )

        // Sanity: the value and identity are carried through unchanged.
        XCTAssertEqual(attrs[kSecValueData as String] as? Data, Data("secret-token".utf8))
        XCTAssertEqual(attrs[kSecAttrAccount as String] as? String, "gateway.token")
        XCTAssertEqual(attrs[kSecAttrService as String] as? String, "dev.omnesis.ios.pairing")
    }

    func testReadQueryAcceptsOnlyCurrentDeviceLocalClass() {
        let query = Keychain.deviceLocalReadQuery(
            service: "dev.omnesis.ios.pairing",
            key: "gateway.token"
        )

        XCTAssertTrue(CFEqual(
            query[kSecAttrSynchronizable as String] as AnyObject,
            kCFBooleanFalse
        ))
        XCTAssertEqual(
            query[kSecAttrAccessible as String] as? String,
            kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly as String
        )
        XCTAssertTrue(CFEqual(
            query[kSecReturnData as String] as AnyObject,
            kCFBooleanTrue
        ))
        XCTAssertEqual(
            query[kSecMatchLimit as String] as? String,
            kSecMatchLimitOne as String
        )
    }

    func testExplicitAccessGroupIsAppliedToExtensionReadsAndWrites() {
        let group = "TEAMID.dev.omnesis.ios"
        let add = Keychain.addQuery(
            service: "dev.omnesis.ios.pairing",
            key: "gateway.token",
            data: Data("secret-token".utf8),
            accessGroup: group
        )
        let read = Keychain.deviceLocalReadQuery(
            service: "dev.omnesis.ios.pairing",
            key: "gateway.token",
            accessGroup: group
        )

        XCTAssertEqual(add[kSecAttrAccessGroup as String] as? String, group)
        XCTAssertEqual(read[kSecAttrAccessGroup as String] as? String, group)
    }

    func testLegacyQueriesTargetSynchronizableRowsOnly() {
        let read = Keychain.legacySynchronizableReadQuery(
            service: "dev.omnesis.ios.pairing",
            key: "gateway.url"
        )
        let cleanup = Keychain.legacySynchronizableDeleteQuery(
            service: "dev.omnesis.ios.pairing"
        )

        XCTAssertTrue(CFEqual(
            read[kSecAttrSynchronizable as String] as AnyObject,
            kCFBooleanTrue
        ))
        XCTAssertTrue(CFEqual(
            cleanup[kSecAttrSynchronizable as String] as AnyObject,
            kCFBooleanTrue
        ))
        XCTAssertNil(cleanup[kSecAttrAccount as String])
        XCTAssertNil(cleanup[kSecReturnData as String])
        XCTAssertEqual(
            cleanup[kSecAttrService as String] as? String,
            "dev.omnesis.ios.pairing"
        )
    }
}
#endif
