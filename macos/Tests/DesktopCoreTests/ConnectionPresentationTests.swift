// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

@testable import DesktopCore
import XCTest

final class ConnectionPresentationTests: XCTestCase {
    func testNewAccountIncludesInvitationAndExplicitConsent() {
        XCTAssertEqual(DesktopAccountIntent.create.parameters(invite: "  invented-invite  ", termsAccepted: true), [
            "intent": .string("create"), "invite": .string("invented-invite"), "termsAccepted": .bool(true),
        ])
        XCTAssertEqual(DesktopAccountIntent.existing.parameters(invite: "unused", termsAccepted: false), [
            "intent": .string("existing"), "termsAccepted": .bool(false),
        ])
    }

    func testRelayMustBeReadyAndAuthorizedBeforeShowingItsAddress() throws {
        let resource = "https://library.example.com/mcp"
        XCTAssertThrowsError(try DesktopRelayAddress.mcp(
            enabled: true,
            ready: false,
            advertised: resource,
            authorizedResources: [resource]
        ))
        XCTAssertThrowsError(try DesktopRelayAddress.mcp(
            enabled: true,
            ready: true,
            advertised: resource,
            authorizedResources: ["https://other.example.com/mcp"]
        ))
        XCTAssertEqual(
            try DesktopRelayAddress.mcp(enabled: true, ready: true, advertised: resource, authorizedResources: [resource]).absoluteString,
            resource
        )
    }

    func testPlaintextAndCredentialAddressesAreNeverCopiedToAnAssistant() {
        for bad in [
            "http://example.com/mcp",
            "https://token@example.com/mcp",
            "https://example.com/mcp?token=secret",
            "https://example.com/mcp#secret",
        ] {
            XCTAssertThrowsError(try DesktopRelayAddress.mcp(enabled: true, ready: true, advertised: bad, authorizedResources: [bad]))
        }
    }

    func testPhoneAddressMustMatchCanonicalRelayOrigin() throws {
        let origin = try DesktopRelayAddress.gatewayOrigin(mcp: XCTUnwrap(URL(string: "https://library.example.com/mcp")))
        XCTAssertTrue(DesktopRelayAddress.matchesPhoneAddress("https://library.example.com/", gatewayOrigin: origin))
        XCTAssertTrue(DesktopRelayAddress.matchesPhoneAddress("https://library.example.com:443", gatewayOrigin: origin))
        XCTAssertFalse(DesktopRelayAddress.matchesPhoneAddress("https://other.example.com", gatewayOrigin: origin))
        XCTAssertFalse(DesktopRelayAddress.matchesPhoneAddress("https://library.example.com:17601", gatewayOrigin: origin))
        XCTAssertFalse(DesktopRelayAddress.matchesPhoneAddress("http://localhost:17601", gatewayOrigin: origin))
        XCTAssertFalse(DesktopRelayAddress.matchesPhoneAddress("https://library.example.com/mcp", gatewayOrigin: origin))
    }

    func testNativeChildCannotReadHeadlessLoaderOrCredentialEnvironment() {
        let env = DesktopRuntimeEnvironment.child(parent: [
            "HOME": "/Users/fixture", "PATH": "/usr/bin:/bin", "LANG": "en_US.UTF-8",
            "OMNESIS_CONFIG_DIR": "/private/headless", "OMNESIS_DESKTOP_RUNTIME_DIR": "/private/development",
            "NODE_OPTIONS": "--import /private/headless/instrument.js", "NODE_EXTRA_CA_CERTS": "/private/headless/ca.pem",
            "OPENAI_API_KEY": "invented-key", "DYLD_INSERT_LIBRARIES": "/private/headless/preload.dylib",
            "TERM": "xterm-256color",
        ], runtime: URL(fileURLWithPath: "/Applications/Omnesis.app/Contents/Resources/runtime"))
        XCTAssertNil(env["NODE_OPTIONS"])
        XCTAssertNil(env["NODE_EXTRA_CA_CERTS"])
        XCTAssertNil(env["OMNESIS_CONFIG_DIR"])
        XCTAssertNil(env["OMNESIS_DESKTOP_RUNTIME_DIR"])
        XCTAssertNil(env["OPENAI_API_KEY"])
        XCTAssertNil(env["DYLD_INSERT_LIBRARIES"])
        XCTAssertEqual(env["HOME"], "/Users/fixture")
        XCTAssertEqual(env["TERM"], "xterm-256color")
        XCTAssertTrue(env["PATH"]?.hasPrefix("/Applications/Omnesis.app/Contents/Resources/runtime:") == true)
    }
}
