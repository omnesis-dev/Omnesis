// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

@testable import Omnesis
import XCTest

/// What the app's root shows: onboarding, first-run setup in home's place, or
/// home.
@MainActor
final class RootScreenTests: XCTestCase {
    private let device = "11111111-1111-4111-8111-111111111111"

    func testOnboardingShowsUntilPaired() {
        let presentations: [PhoneSetupCoordinator.Presentation?] = [nil, .firstRun, .settings, .settingsStep]
        for presentation in presentations {
            XCTAssertEqual(RootScreen.choose(isPaired: false, setupPresentation: presentation), .onboarding)
        }
    }

    func testFirstRunSetupTakesHomesPlace() {
        XCTAssertEqual(RootScreen.choose(isPaired: true, setupPresentation: .firstRun), .setup)
    }

    func testRunsOpenedFromSettingsKeepHomeAsTheRoot() {
        let presentations: [PhoneSetupCoordinator.Presentation?] = [nil, .settings, .settingsStep]
        for presentation in presentations {
            XCTAssertEqual(RootScreen.choose(isPaired: true, setupPresentation: presentation), .home)
        }
    }

    /// Pairing that offers setup shows it as the root straight away and keeps
    /// it there with no cover to appear, until the run ends.
    func testAPairingThatOffersSetupShowsItAsTheRoot() async throws {
        let host = FakePhoneSetupHost()
        let setup = PhoneSetupCoordinator(progressStore: PhoneSetupProgressStore(defaults: DictionaryDefaults()))
        setup.install(host: host, steps: PhoneSetupRegistry.ios(host: host))

        setup.holdForEvaluation(deviceId: device)
        setup.evaluateAutomaticPresentation(deviceId: device, anyPhoneSourceEnabled: false)
        XCTAssertEqual(RootScreen.choose(isPaired: true, setupPresentation: setup.presentation), .setup)

        try await Task.sleep(for: .milliseconds(100))
        XCTAssertEqual(RootScreen.choose(isPaired: true, setupPresentation: setup.presentation), .setup)
        XCTAssertTrue(setup.isGateActive)

        setup.complete()
        XCTAssertEqual(RootScreen.choose(isPaired: true, setupPresentation: setup.presentation), .home)
        XCTAssertFalse(setup.isGateActive)
    }
}
