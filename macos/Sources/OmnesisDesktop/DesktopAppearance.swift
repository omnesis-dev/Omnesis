// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import SwiftUI

enum DesktopAppearance: String, CaseIterable, Identifiable {
    case system, light, dark

    static let storageKey = "desktop-appearance"
    var id: String {
        rawValue
    }

    var title: String {
        switch self {
        case .system: "System"
        case .light: "Light"
        case .dark: "Dark"
        }
    }

    var colorScheme: ColorScheme? {
        switch self {
        case .system: nil
        case .light: .light
        case .dark: .dark
        }
    }
}

private struct DesktopAppearanceOverrideKey: EnvironmentKey {
    static let defaultValue: DesktopAppearance? = nil
}

extension EnvironmentValues {
    /// A local preview/test preference; nil uses the owning app's persisted setting.
    var desktopAppearanceOverride: DesktopAppearance? {
        get { self[DesktopAppearanceOverrideKey.self] }
        set { self[DesktopAppearanceOverrideKey.self] = newValue }
    }
}

struct DesktopAppearancePicker: View {
    @AppStorage(DesktopAppearance.storageKey) private var selection = DesktopAppearance.system.rawValue

    var body: some View {
        Picker("Appearance", selection: Binding(
            get: { DesktopAppearance(rawValue: selection)?.rawValue ?? DesktopAppearance.system.rawValue },
            set: { selection = $0 }
        )) {
            ForEach(DesktopAppearance.allCases) { appearance in
                Text(appearance.title).tag(appearance.rawValue)
            }
        }
        .accessibilityIdentifier("desktop-appearance")
    }
}
