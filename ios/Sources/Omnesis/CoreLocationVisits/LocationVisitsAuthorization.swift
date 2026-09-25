// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation
#if os(iOS) && canImport(CoreLocation) && canImport(UIKit)
@preconcurrency import CoreLocation
import UIKit

/// Location permission for Places, requested the way iOS expects: While Using
/// the App first, then the upgrade to Always, each awaited so the caller
/// learns what the user chose. Nothing else in the app asks for Places'
/// location access. A permission the user has already decided goes straight
/// through without waiting on any prompt.
@available(iOS 17.0, *)
@MainActor
public enum LocationVisitsAuthorization {
    private static let reader = CLLocationManager()

    public static var current: LocationVisitsPermissionState {
        state(reader.authorizationStatus)
    }

    public static var isPrecise: Bool {
        reader.accuracyAuthorization != .reducedAccuracy
    }

    /// Shows whichever location prompts iOS still has to show, and returns
    /// the permission once the user has answered them. Cancelling the calling
    /// task ends any wait at once.
    public static func request() async -> LocationVisitsPermissionState {
        await LocationPermissionPrompt().run()
    }

    static func state(_ status: CLAuthorizationStatus) -> LocationVisitsPermissionState {
        switch status {
        case .notDetermined: .notDetermined
        case .restricted: .restricted
        case .denied: .denied
        case .authorizedAlways: .always
        case .authorizedWhenInUse: .whenInUse
        @unknown default: .restricted
        }
    }
}

/// One run of the location prompts. The prompts belong to the manager that
/// requested them, so this object lives for the whole run.
@available(iOS 17.0, *)
@MainActor
private final class LocationPermissionPrompt {
    private let manager = CLLocationManager()

    private var isActive: Bool {
        UIApplication.shared.applicationState == .active
    }

    func run() async -> LocationVisitsPermissionState {
        if manager.authorizationStatus == .notDetermined {
            manager.requestWhenInUseAuthorization()
            var wait = LocationPromptWait()
            await SystemPromptActivity.shared.during(true) {
                await poll { elapsed in
                    wait.whileUsing(
                        isDecided: manager.authorizationStatus != .notDetermined,
                        isActive: isActive,
                        elapsed: elapsed
                    )
                }
            }
        }
        if manager.authorizationStatus == .authorizedWhenInUse, !Task.isCancelled {
            manager.requestAlwaysAuthorization()
            var wait = LocationPromptWait()
            var promptShown = false
            await poll { elapsed in
                let step = wait.alwaysUpgrade(
                    isAlways: manager.authorizationStatus == .authorizedAlways,
                    isActive: isActive,
                    elapsed: elapsed
                )
                if step == .promptShown {
                    promptShown = true
                    SystemPromptActivity.shared.begin()
                }
                return step
            }
            if promptShown {
                SystemPromptActivity.shared.end()
            }
        }
        return LocationVisitsAuthorization.state(manager.authorizationStatus)
    }

    /// Reads `step` every 100 ms until it says to stop or the task is cancelled.
    private func poll(_ step: (Duration) -> LocationPromptWait.Step) async {
        let start = ContinuousClock.now
        while !Task.isCancelled {
            if step(ContinuousClock.now - start) == .stop { return }
            try? await Task.sleep(for: .milliseconds(100))
        }
    }
}
#endif
