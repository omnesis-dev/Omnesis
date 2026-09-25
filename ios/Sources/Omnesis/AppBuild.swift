// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation

/// Compile-time identity of the running binary. The Omnesis production
/// app and the side-by-side OmnesisDemo app ship from the same source
/// tree; their Info.plists declare which build is the demo. A handful of UI sites want to soften
/// hard failures into inline notices in the demo so that walkthrough
/// transcripts captured against a newer gateway still load when the
/// shipped app is a release behind — this helper is how those sites
/// decide which mode they're in at runtime.
enum AppBuild {
    /// True when the running binary is the OmnesisDemo target. Reads
    /// the app's Info.plist rather than a compile flag so the
    /// same library / SwiftPM build is correct regardless of which
    /// host app links it in.
    static var isDemo: Bool {
        isDemo(infoDictionary: Bundle.main.infoDictionary)
    }

    static func isDemo(infoDictionary: [String: Any]?) -> Bool {
        infoDictionary?["OmnesisDemoBuild"] as? Bool == true
    }

    /// Stretch factor applied to the ephemeral tool-call cards' line cadence
    /// and minimum-visible time while the in-app auto-pilot is driving a
    /// conversation for a landing-page screen recording (the recorder sets
    /// `DEMO_AUTO_SEND` in the launch environment). On video the cards
    /// otherwise flow past faster than a first-time viewer can read, so each
    /// line lingers — and each card stays up — 1.5× longer. Returns 1.0 (no
    /// effect) everywhere else, including a human driving the demo app by
    /// hand, so the shipping experience is untouched.
    static var ephemeralRecordingPacingMultiplier: Double {
        ProcessInfo.processInfo.environment["DEMO_AUTO_SEND"] != nil ? 1.5 : 1.0
    }
}

/// Every version number this app build can state about itself.
///
/// Three numbers, three different questions, and someone looking at a phone
/// needs all of them:
///
/// - `version` is the lockstep Omnesis product version. It says how old this
///   build is relative to the gateway it pairs with — an app legitimately
///   trails the tag it was cut from while a store release is in the queue.
/// - `build` is the store's monotonic upload counter. Two builds of the same
///   product version are told apart by nothing else.
/// - `wireProtocol` is the device-socket number the gateway either speaks or
///   refuses outright. When a phone cannot connect at all, this is the value
///   that decided it.
struct AppVersionInfo: Equatable, Sendable {
    let version: String
    let build: String
    let wireProtocol: Int
}

extension AppBuild {
    /// The Omnesis product version this binary was cut from, as its bundle
    /// declares it (`CFBundleShortVersionString`).
    ///
    /// Reads a plist dictionary rather than a `Bundle` so the pure-logic
    /// test lane — whose host is an xctest runner carrying no Omnesis
    /// version — can exercise every branch. Falls back to `"0.0.0"`, an
    /// implausible version the gateway reports as such, rather than an
    /// empty string that would read as "never reported".
    static func productVersion(infoDictionary: [String: Any]?) -> String {
        nonEmptyString(infoDictionary, "CFBundleShortVersionString") ?? "0.0.0"
    }

    /// The store's upload counter for this binary (`CFBundleVersion`).
    ///
    /// Successive TestFlight builds share a product version, so this is the
    /// only number that says which one is installed.
    static func buildNumber(infoDictionary: [String: Any]?) -> String {
        nonEmptyString(infoDictionary, "CFBundleVersion") ?? "0"
    }

    /// A plist value only counts when it is a string with something in it. A
    /// blank one would render an empty row, which reads as a bug in the screen
    /// rather than as a build that declares no version.
    private static func nonEmptyString(_ infoDictionary: [String: Any]?, _ key: String) -> String? {
        guard let value = infoDictionary?[key] as? String, !value.isEmpty else { return nil }
        return value
    }
}

@available(iOS 17.0, *)
extension AppBuild {
    /// This build's full version identity, for display.
    static var versionInfo: AppVersionInfo {
        let info = Bundle.main.infoDictionary
        return AppVersionInfo(
            version: productVersion(infoDictionary: info),
            build: buildNumber(infoDictionary: info),
            wireProtocol: DeviceSocket.protocolVersion
        )
    }
}
