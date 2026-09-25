// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation
#if canImport(SwiftUI) && canImport(UIKit)
import SwiftUI

/// The interface appearance the user has chosen for the app. Drives the
/// forced `ColorScheme` and, through that, which variant every adaptive
/// `Theme` colour resolves to.
public enum AppearanceMode: String, CaseIterable, Sendable {
    /// Follow the device's system-wide Light/Dark setting.
    case system
    case light
    case dark

    /// Colour scheme to force on a presentation, or `nil` to follow the
    /// system setting (used by `.preferredColorScheme`).
    public var colorScheme: ColorScheme? {
        switch self {
        case .system: nil
        case .light: .light
        case .dark: .dark
        }
    }

    /// User-facing label for the settings picker.
    public var label: String {
        switch self {
        case .system: "System"
        case .light: "Light"
        case .dark: "Dark"
        }
    }
}

/// Persisted appearance preference. Lives in `UserDefaults.standard` so
/// it survives relaunches and is wiped on uninstall — mirrors the
/// `HealthSettings` pattern and reuses its `KeyValueDefaults` seam so
/// tests can inject an in-memory store.
public struct AppearanceSettings: Sendable {
    public enum Keys {
        public static let mode = "omnesis.appearance.mode"
    }

    /// The app shipped dark-only, so both fresh installs and existing
    /// users default to dark until they explicitly pick Light or System.
    public static let defaultMode: AppearanceMode = .dark

    private let defaults: KeyValueDefaults

    public init(defaults: KeyValueDefaults = UserDefaults.standard) {
        self.defaults = defaults
    }

    public var mode: AppearanceMode {
        get {
            defaults.string(forKey: Keys.mode)
                .flatMap(AppearanceMode.init(rawValue:)) ?? Self.defaultMode
        }
        nonmutating set { defaults.set(newValue.rawValue, forKey: Keys.mode) }
    }
}

/// Observable holder for the chosen `AppearanceMode`. A single instance
/// is created by `AppStore` and injected into the environment at the
/// window root; the `.omnesisColorScheme()` modifier reads it on every
/// presentation surface so sheets and covers honour the setting too.
///
/// Deliberately not `@MainActor`-isolated: `EnvironmentValues` needs a
/// synchronously-constructible default instance, and the only mutation
/// (writing the persisted mode) is a thread-safe `UserDefaults` write.
@Observable
public final class AppearanceStore {
    public var mode: AppearanceMode {
        didSet {
            guard mode != oldValue else { return }
            settings.mode = mode
        }
    }

    @ObservationIgnored
    private let settings: AppearanceSettings

    public init(settings: AppearanceSettings = AppearanceSettings()) {
        self.settings = settings
        self.mode = settings.mode
    }

    /// Preview / test convenience — a mode with no real persistence.
    public convenience init(mode: AppearanceMode) {
        self.init(settings: AppearanceSettings(defaults: DictionaryDefaults()))
        self.mode = mode
    }

    /// Build the appearance store for app launch. In DEBUG builds a
    /// `DEMO_APPEARANCE=light|dark|system` launch-environment value — set by
    /// the landing-asset captures (`DemoRecorderTests` for the carousel
    /// videos, `ScreenshotTests` for the showcase stills) so they can be
    /// captured in both appearances — forces that mode with no persistence.
    /// The shipping app, and any build without the variable, falls back to
    /// the persisted user preference (dark by default).
    public static func forLaunchEnvironment() -> AppearanceStore {
        #if DEBUG
        if let raw = ProcessInfo.processInfo.environment["DEMO_APPEARANCE"],
           let mode = AppearanceMode(rawValue: raw.lowercased()) {
            return AppearanceStore(mode: mode)
        }
        #endif
        return AppearanceStore()
    }

    /// The scheme to force, or `nil` to follow the system.
    public var colorScheme: ColorScheme? {
        mode.colorScheme
    }
}

// MARK: - Environment plumbing

private struct AppearanceStoreKey: EnvironmentKey {
    /// Shared default so component previews that don't inject a store
    /// still resolve a real, UserDefaults-backed appearance.
    static let defaultValue = AppearanceStore()
}

extension EnvironmentValues {
    var appearanceStore: AppearanceStore {
        get { self[AppearanceStoreKey.self] }
        set { self[AppearanceStoreKey.self] = newValue }
    }
}

private struct OmnesisColorSchemeModifier: ViewModifier {
    @Environment(\.appearanceStore) private var appearance

    func body(content: Content) -> some View {
        content.preferredColorScheme(appearance.colorScheme)
    }
}

extension View {
    /// Force the app's chosen appearance (System / Light / Dark) on this
    /// presentation root. Apply it at the top of every independently
    /// presented surface — the home shell and each sheet / full-screen
    /// cover — because a modal presentation is its own colour-scheme
    /// context and won't otherwise inherit the setting.
    func omnesisColorScheme() -> some View {
        modifier(OmnesisColorSchemeModifier())
    }
}
#endif
