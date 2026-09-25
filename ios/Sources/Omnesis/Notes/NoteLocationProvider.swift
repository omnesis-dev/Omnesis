// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

#if canImport(CoreLocation)
@preconcurrency import CoreLocation

/// The slice of `CLLocationManager` the provider drives, behind a
/// protocol so tests can substitute a fake with no live location
/// hardware or network. `CLLocationManager` satisfies it unchanged.
protocol LocationFixing: AnyObject {
    var delegate: CLLocationManagerDelegate? { get set }
    var authorizationStatus: CLAuthorizationStatus { get }
    var desiredAccuracy: CLLocationAccuracy { get set }
    func requestWhenInUseAuthorization()
    func requestLocation()
}

extension CLLocationManager: LocationFixing {}

/// Device implementation of `NoteLocationProviding`: a single-shot
/// current-location fix reverse-geocoded to a place name, attached to a
/// note when location permission is granted (photo parity — the
/// permission prompt is the opt-in). Everything is best-effort and time
/// -boxed: a note is never held up waiting on a fix, and a missing fix
/// (permission denied, indoors, a background Siri capture the OS won't
/// serve) simply yields a note without a location.
///
/// `@MainActor` so all `CLLocationManager` access and its delegate
/// callbacks are serialized on one actor without locks. Single-flight:
/// concurrent callers share one in-progress resolve.
@MainActor
public final class NoteLocationProvider: NSObject, NoteLocationProviding, CLLocationManagerDelegate {
    public static let shared = NoteLocationProvider()

    private let manager: LocationFixing
    /// Reverse-geocode step, injectable so tests avoid the network.
    private let geocode: @Sendable (CLLocation) async -> String?
    private let fixTimeout: Duration
    private let authTimeout: Duration
    private let geocodeTimeout: Duration

    private var inFlight: Task<NoteLocation?, Never>?

    /// Each of the three awaited steps parks one continuation and arms one
    /// timeout `Task`. The timeout is held so a normal resume can cancel
    /// it: an un-cancelled timeout outlives its resolve and, since resumes
    /// are single-flighted, would otherwise fire during the *next*
    /// resolve and null out its result.
    private var fixWaiter: CheckedContinuation<CLLocation?, Never>?
    private var fixTimeoutTask: Task<Void, Never>?
    private var authWaiter: CheckedContinuation<CLAuthorizationStatus, Never>?
    private var authTimeoutTask: Task<Void, Never>?
    private var geocodeWaiter: CheckedContinuation<String?, Never>?
    private var geocodeTimeoutTask: Task<Void, Never>?

    /// Internal (not public): the `LocationFixing` seam is a module detail.
    /// External callers use `.shared`; the module and `@testable` tests
    /// construct it directly with a fake manager.
    init(
        manager: LocationFixing = CLLocationManager(),
        // A fix is a coarse "where roughly" — a note is placed to a
        // neighbourhood, not a doorstep — and coarser accuracy returns
        // faster and costs less battery.
        fixTimeout: Duration = .seconds(6),
        // The authorization prompt is user-paced; give it room before
        // giving up and capturing the note location-less.
        authTimeout: Duration = .seconds(20),
        // The coordinate is already in hand, so a slow geocode only costs
        // the place name — never the note.
        geocodeTimeout: Duration = .seconds(5),
        geocode: @escaping @Sendable (CLLocation) async -> String? = { await ReverseGeocoder.placeName(for: $0) }
    ) {
        self.manager = manager
        self.fixTimeout = fixTimeout
        self.authTimeout = authTimeout
        self.geocodeTimeout = geocodeTimeout
        self.geocode = geocode
        super.init()
        manager.delegate = self
        manager.desiredAccuracy = kCLLocationAccuracyHundredMeters
    }

    public func current(promptIfNeeded: Bool) async -> NoteLocation? {
        // Single-flight: a second capture racing the first rides the same
        // in-progress fix rather than firing a competing `requestLocation`.
        if let inFlight { return await inFlight.value }
        let task = Task { await self.resolve(promptIfNeeded: promptIfNeeded) }
        inFlight = task
        let result = await task.value
        inFlight = nil
        return result
    }

    private func resolve(promptIfNeeded: Bool) async -> NoteLocation? {
        guard await ensureAuthorized(promptIfNeeded: promptIfNeeded) else { return nil }
        guard let fix = await requestFix() else { return nil }
        // The coordinate stands on its own; the place name is enrichment,
        // time-boxed so a hung geocode can't hold up the capture.
        let place = await placeName(for: fix)
        return NoteLocation(
            latitude: fix.coordinate.latitude,
            longitude: fix.coordinate.longitude,
            placeName: place
        )
    }

    // MARK: - Authorization

    private func ensureAuthorized(promptIfNeeded: Bool) async -> Bool {
        switch manager.authorizationStatus {
        // `.authorizedWhenInUse` is the iOS/watchOS grant this feature
        // asks for; it doesn't exist on macOS (where the type still
        // compiles for the sim-less logic lane), so the case is gated.
        #if os(macOS)
        case .authorizedAlways:
            return true
        #else
        case .authorizedWhenInUse, .authorizedAlways:
            return true
        #endif
        case .denied, .restricted:
            return false
        case .notDetermined:
            // Only the foreground in-app capture prompts. A background
            // capture (Siri, the watch relay) can't show or answer the OS
            // dialog, and blocking on `awaitAuthChange` there would just
            // burn the caller's budget — so it declines location instead.
            guard promptIfNeeded else { return false }
            manager.requestWhenInUseAuthorization()
            return await isGranted(awaitAuthChange())
        @unknown default:
            return false
        }
    }

    private func isGranted(_ status: CLAuthorizationStatus) -> Bool {
        #if os(macOS)
        return status == .authorizedAlways
        #else
        return status == .authorizedWhenInUse || status == .authorizedAlways
        #endif
    }

    /// Suspend until the authorization status changes, or the prompt
    /// budget elapses (the user walked away from the dialog).
    private func awaitAuthChange() async -> CLAuthorizationStatus {
        await withCheckedContinuation { (continuation: CheckedContinuation<CLAuthorizationStatus, Never>) in
            authWaiter = continuation
            authTimeoutTask = Task {
                try? await Task.sleep(for: authTimeout)
                self.resumeAuth(manager.authorizationStatus)
            }
        }
    }

    private func resumeAuth(_ status: CLAuthorizationStatus) {
        guard let waiter = authWaiter else { return }
        authWaiter = nil
        authTimeoutTask?.cancel()
        authTimeoutTask = nil
        waiter.resume(returning: status)
    }

    // MARK: - Fix

    private func requestFix() async -> CLLocation? {
        await withCheckedContinuation { (continuation: CheckedContinuation<CLLocation?, Never>) in
            fixWaiter = continuation
            manager.requestLocation()
            fixTimeoutTask = Task {
                try? await Task.sleep(for: fixTimeout)
                self.resumeFix(nil)
            }
        }
    }

    private func resumeFix(_ location: CLLocation?) {
        guard let waiter = fixWaiter else { return }
        fixWaiter = nil
        fixTimeoutTask?.cancel()
        fixTimeoutTask = nil
        waiter.resume(returning: location)
    }

    // MARK: - Reverse geocode

    private func placeName(for fix: CLLocation) async -> String? {
        await withCheckedContinuation { (continuation: CheckedContinuation<String?, Never>) in
            geocodeWaiter = continuation
            Task {
                let name = await geocode(fix)
                self.resumeGeocode(name)
            }
            geocodeTimeoutTask = Task {
                try? await Task.sleep(for: geocodeTimeout)
                self.resumeGeocode(nil)
            }
        }
    }

    private func resumeGeocode(_ name: String?) {
        guard let waiter = geocodeWaiter else { return }
        geocodeWaiter = nil
        geocodeTimeoutTask?.cancel()
        geocodeTimeoutTask = nil
        waiter.resume(returning: name)
    }

    // MARK: - CLLocationManagerDelegate

    public nonisolated func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) {
        let status = manager.authorizationStatus
        Task { @MainActor in self.resumeAuth(status) }
    }

    public nonisolated func locationManager(
        _ manager: CLLocationManager,
        didUpdateLocations locations: [CLLocation]
    ) {
        let last = locations.last
        Task { @MainActor in self.resumeFix(last) }
    }

    public nonisolated func locationManager(
        _ manager: CLLocationManager,
        didFailWithError error: Error
    ) {
        Task { @MainActor in self.resumeFix(nil) }
    }
}
#endif
