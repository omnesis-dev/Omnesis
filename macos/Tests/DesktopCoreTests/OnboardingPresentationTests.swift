// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import DesktopCore
import Foundation
import XCTest

final class OnboardingPresentationTests: XCTestCase {
    func testOnlyObservedUnpreparedChoiceAllowsChangingTheLibraryLocation() throws {
        for (json, local, change) in [
            (#"{"phase":"waiting","mode":"home"}"#, true, false),
            (#"{"phase":"waiting","mode":"joined"}"#, false, false),
            (#"{"phase":"waiting"}"#, false, true),
            (#"{"phase":"waiting","retired":true}"#, false, false),
        ] {
            let state = try JSONDecoder().decode(DesktopState.self, from: Data(json.utf8))
            XCTAssertEqual(state.waitingForLocalLibrary, local)
            XCTAssertEqual(state.canChangeUnpreparedChoice, change)
        }
    }

    func testCertificateConsentRequiresReadableHTTPSAuthorityTerms() throws {
        for (url, allowed) in [
            ("https://ca.example.com/terms", true), ("http://ca.example.com/terms", false),
            ("https://user:secret@ca.example.com/terms", false), ("file:///terms", false),
        ] {
            let state = try JSONDecoder().decode(DesktopState.self, from: JSONSerialization.data(withJSONObject: [
                "phase": "accountRequired", "signup": ["acmeTermsUrl": url],
            ]))
            XCTAssertEqual(state.signup?.readableTermsURL != nil, allowed)
        }
        XCTAssertNil(DesktopState(phase: .accountRequired).signup?.readableTermsURL)
    }
}
