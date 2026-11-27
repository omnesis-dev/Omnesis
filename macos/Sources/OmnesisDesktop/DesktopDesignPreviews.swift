// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

#if DEBUG
import SwiftUI

/// Development-only real controls. Hover, focus and press remain interactive in the preview.
private struct DesktopDesignPreview: View {
    let appearance: DesktopAppearance
    let width: CGFloat
    var showAccessibilityPreferences = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.accessibilityReduceTransparency) private var reduceTransparency
    @State private var text = "An invented project outline with a deliberately long title"
    @State private var selected: String? = "Sources"
    @State private var enabled = true
    @FocusState private var inputFocused: Bool
    private let suite = "dev.omnesis.design-preview." + UUID().uuidString

    var body: some View {
        let defaults = UserDefaults(suiteName: suite)!
        ScrollView {
            VStack(alignment: .leading, spacing: DesktopDesignTokens.Space.section) {
                DesktopBrandHeading(subtitle: "Design components")
                Text("A quiet workspace").font(DesktopDesignTokens.Typography.pageTitle)
                Text("Existing native controls share semantic surfaces, readable text and deliberate spacing.")
                    .foregroundStyle(DesktopTheme.secondary)
                if showAccessibilityPreferences {
                    VStack(alignment: .leading, spacing: DesktopDesignTokens.Space.small) {
                        Text("Current system accessibility").font(DesktopDesignTokens.Typography.section)
                            .accessibilityAddTraits(.isHeader)
                        LabeledContent("Reduce Motion", value: reduceMotion ? "On" : "Off")
                        LabeledContent("Reduce Transparency", value: reduceTransparency ? "On" : "Off")
                        Text("These are inherited system settings; this preview does not change them.")
                            .font(DesktopDesignTokens.Typography.secondary).foregroundStyle(DesktopTheme.secondary)
                    }
                }
                ViewThatFits(in: .horizontal) {
                    HStack { actions }
                    VStack(alignment: .leading) { actions }
                }
                HStack {
                    Button("Unavailable") {}.disabled(true).buttonStyle(DesktopButtonStyle(primary: true))
                    ProgressView("Reading the library…").controlSize(.small)
                }
                VStack(alignment: .leading, spacing: DesktopDesignTokens.Space.xSmall) {
                    Text("Project title").font(DesktopDesignTokens.Typography.secondary.weight(.medium))
                    TextField("Project title", text: $text).textFieldStyle(.roundedBorder)
                        .focused($inputFocused)
                        .accessibilityLabel("Project title")
                }
                HStack {
                    Toggle("Enabled", isOn: $enabled)
                    Spacer()
                    Button("Focus input") { inputFocused = true }
                }
                List(selection: $selected) {
                    Label("Ask", systemImage: "bubble.left").tag("Ask")
                    Label("Sources", systemImage: "square.stack.3d.up").tag("Sources")
                    Label("A longer navigation label", systemImage: "gearshape").tag("Settings")
                }.listStyle(.sidebar).frame(height: 130)
                VStack(alignment: .leading, spacing: DesktopDesignTokens.Space.small) {
                    Label("Ready", systemImage: "checkmark.circle").foregroundStyle(DesktopTheme.success)
                    Label("Setup needs attention", systemImage: "exclamationmark.triangle").foregroundStyle(DesktopTheme.warning)
                    Label("The connection could not finish", systemImage: "xmark.circle").foregroundStyle(DesktopTheme.danger)
                    Text("Supporting information remains readable.").foregroundStyle(DesktopTheme.tertiary)
                }
                if appearance == .system { DesktopAppearancePicker() }
            }.padding(DesktopDesignTokens.Space.section)
        }
        .buttonStyle(DesktopButtonStyle()).omnesisTheme()
        .defaultAppStorage(defaults)
        .environment(\.desktopAppearanceOverride, appearance == .system ? nil : appearance)
        .frame(width: width, height: 700)
        .onDisappear { defaults.removePersistentDomain(forName: suite) }
    }

    @ViewBuilder private var actions: some View {
        Button("Continue") {}.buttonStyle(DesktopButtonStyle(primary: true))
        Button("Review") {}.buttonStyle(DesktopButtonStyle())
        Button("Remove", role: .destructive) {}.buttonStyle(DesktopButtonStyle())
        Button("Refresh", systemImage: "arrow.clockwise") {}.labelStyle(.iconOnly)
            .help("Refresh").accessibilityLabel("Refresh")
            .buttonStyle(DesktopButtonStyle(iconOnly: true))
    }
}

#Preview("Light · compact") { DesktopDesignPreview(appearance: .light, width: 520) }
#Preview("Dark · wide") { DesktopDesignPreview(appearance: .dark, width: 920) }
#Preview("System · inherited") { DesktopDesignPreview(appearance: .system, width: 680) }
#Preview("Light · increased contrast") {
    DesktopDesignPreview(appearance: .light, width: 680).environment(\.desktopContrast, .increased)
}

#Preview("Current system accessibility") {
    DesktopDesignPreview(appearance: .system, width: 680, showAccessibilityPreferences: true)
}
#endif
