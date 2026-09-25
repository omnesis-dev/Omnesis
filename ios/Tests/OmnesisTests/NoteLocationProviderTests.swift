// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

#if canImport(CoreLocation)
@preconcurrency import CoreLocation
@testable import Omnesis
import XCTest

/// Drives `NoteLocationProvider`'s resolve → authorize → fix → geocode
/// pipeline through a fake `LocationFixing`, with the geocode stubbed and
/// the timeouts shortened — no live location hardware, no network. Uses
/// `.authorizedAlways` (the one grant that exists on both iOS and the
/// macOS logic-lane host) so the suite runs sim-less.
@MainActor
final class NoteLocationProviderTests: XCTestCase {
    /// Standalone fake — not a `CLLocationManager` subclass, so nothing
    /// depends on which of its members happen to be `open`. The delegate
    /// callbacks it fires carry a throwaway `CLLocationManager` as their
    /// first argument, which the provider ignores for fix/failure events.
    private final class FakeLocationManager: LocationFixing {
        enum FixOutcome {
            case success(CLLocation)
            case failure
            /// Never delivers on `requestLocation` — the test delivers by
            /// hand (single-flight timing).
            case manual
        }

        weak var delegate: CLLocationManagerDelegate?
        var authorizationStatus: CLAuthorizationStatus
        var desiredAccuracy: CLLocationAccuracy = 0
        private(set) var requestLocationCount = 0
        private(set) var requestAuthCount = 0
        private let outcome: FixOutcome
        private let dummy = CLLocationManager()

        init(status: CLAuthorizationStatus, fix: FixOutcome = .manual) {
            self.authorizationStatus = status
            self.outcome = fix
        }

        func requestWhenInUseAuthorization() {
            requestAuthCount += 1
        }

        func requestLocation() {
            requestLocationCount += 1
            switch outcome {
            case .success(let loc):
                delegate?.locationManager?(dummy, didUpdateLocations: [loc])
            case .failure:
                delegate?.locationManager?(dummy, didFailWithError: NSError(domain: "test", code: 1))
            case .manual:
                break
            }
        }

        func deliver(_ location: CLLocation) {
            delegate?.locationManager?(dummy, didUpdateLocations: [location])
        }
    }

    func testGrantedFixResolvesToCoordinateAndPlaceName() async {
        let fake = FakeLocationManager(
            status: .authorizedAlways,
            fix: .success(CLLocation(latitude: 48.8566, longitude: 2.3522))
        )
        let provider = NoteLocationProvider(manager: fake, geocode: { _ in "Testville" })

        let loc = await provider.current(promptIfNeeded: true)

        XCTAssertEqual(loc?.latitude ?? 0, 48.8566, accuracy: 0.0001)
        XCTAssertEqual(loc?.longitude ?? 0, 2.3522, accuracy: 0.0001)
        XCTAssertEqual(loc?.placeName, "Testville")
        XCTAssertEqual(fake.requestLocationCount, 1)
    }

    func testDeniedAuthorizationYieldsNilWithoutRequestingAFix() async {
        let fake = FakeLocationManager(status: .denied)
        let provider = NoteLocationProvider(manager: fake, geocode: { _ in "Testville" })

        let loc = await provider.current(promptIfNeeded: true)

        XCTAssertNil(loc)
        XCTAssertEqual(fake.requestLocationCount, 0)
    }

    func testUndeterminedWithoutPromptDeclinesWithoutPromptingOrFixing() async {
        // A background capture (Siri, the watch relay) must not block on a
        // permission prompt it can't show — undetermined → nil at once.
        let fake = FakeLocationManager(status: .notDetermined)
        let provider = NoteLocationProvider(manager: fake, geocode: { _ in "Testville" })

        let loc = await provider.current(promptIfNeeded: false)

        XCTAssertNil(loc)
        XCTAssertEqual(fake.requestAuthCount, 0, "must not prompt in the background")
        XCTAssertEqual(fake.requestLocationCount, 0)
    }

    func testFixFailureYieldsNil() async {
        let fake = FakeLocationManager(status: .authorizedAlways, fix: .failure)
        let provider = NoteLocationProvider(manager: fake, geocode: { _ in "Testville" })

        let loc = await provider.current(promptIfNeeded: true)

        XCTAssertNil(loc)
    }

    func testGeocodeTimeoutFallsBackToCoordinateOnly() async {
        let fake = FakeLocationManager(
            status: .authorizedAlways,
            fix: .success(CLLocation(latitude: 10, longitude: 20))
        )
        // The geocode never returns in time; the fix is already in hand, so
        // the coordinate must survive with a nil place name.
        let provider = NoteLocationProvider(
            manager: fake,
            geocodeTimeout: .milliseconds(50),
            geocode: { _ in
                try? await Task.sleep(for: .seconds(10))
                return "TooLate"
            }
        )

        let loc = await provider.current(promptIfNeeded: true)

        XCTAssertEqual(loc?.latitude ?? 0, 10, accuracy: 0.0001)
        XCTAssertEqual(loc?.longitude ?? 0, 20, accuracy: 0.0001)
        XCTAssertNil(loc?.placeName)
    }

    func testConcurrentCallsShareOneInFlightFix() async {
        let fake = FakeLocationManager(status: .authorizedAlways, fix: .manual)
        let provider = NoteLocationProvider(manager: fake, geocode: { _ in "Testville" })

        // First caller reaches `requestLocation` and parks…
        let first = Task { await provider.current(promptIfNeeded: true) }
        while fake.requestLocationCount == 0 {
            await Task.yield()
        }
        // …a second caller starts while the first is in flight and must
        // ride it rather than fire a competing request.
        let second = Task { await provider.current(promptIfNeeded: true) }
        for _ in 0 ..< 10 {
            await Task.yield()
        }

        fake.deliver(CLLocation(latitude: 1, longitude: 2))
        let firstResult = await first.value
        let secondResult = await second.value

        XCTAssertEqual(fake.requestLocationCount, 1)
        XCTAssertEqual(firstResult?.latitude ?? 0, 1, accuracy: 0.0001)
        XCTAssertEqual(secondResult?.latitude ?? 0, 1, accuracy: 0.0001)
    }
}
#endif
