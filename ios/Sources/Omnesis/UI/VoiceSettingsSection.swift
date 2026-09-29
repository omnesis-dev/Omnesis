// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

#if canImport(SwiftUI) && canImport(UIKit)
import SwiftUI

/// Settings → Voice: the gateway dictation switch (experimental). Shown only
/// while the paired gateway runs in experimental mode and advertises the
/// setting.
///
/// The switch is a gateway setting, written with `PATCH /admin/config`, so it
/// applies to every device paired with the gateway. When it is on but the
/// transcriber cannot run, the gateway's reason is stated here, beside the
/// control that depends on it, and dictation stays on-device meanwhile.
@available(iOS 17.0, *)
struct VoiceSettingsSection: View {
    @Environment(AppStore.self) private var store
    let status: DictationStatus

    /// The value being written while the change is in flight.
    @State private var pending: Bool?
    /// A value the gateway accepted that `/status` has not reflected yet —
    /// its refresh failed or lags. Shown until the status agrees.
    @State private var saved: Bool?
    @State private var writeError: String?

    init(status: DictationStatus, previewWriteError: String? = nil) {
        self.status = status
        _writeError = State(initialValue: previewWriteError)
    }

    var body: some View {
        Section {
            Toggle(isOn: Binding(get: { shown }, set: write)) {
                VStack(alignment: .leading, spacing: 4) {
                    Text("Transcribe on gateway")
                    ExperimentalTag()
                }
            }
            .disabled(pending != nil || store.pairing == nil)
            .accessibilityIdentifier("gatewayDictationToggle")

            if pending == nil, saved == nil, let reason = status.blockedReason {
                VStack(alignment: .leading, spacing: 4) {
                    notice(reason, color: Theme.warning)
                        .font(.subheadline.weight(.semibold))
                    Text("Dictation uses on-device transcription until the gateway's transcriber can run.")
                        .font(.footnote)
                        .foregroundStyle(Theme.textMuted)
                }
                .fixedSize(horizontal: false, vertical: true)
            }

            if saved != nil {
                Text("Saved. The gateway's status will catch up on the next refresh.")
                    .font(.footnote)
                    .foregroundStyle(Theme.textMuted)
                    .fixedSize(horizontal: false, vertical: true)
            }

            if let writeError {
                notice(writeError, color: Theme.danger)
                    .font(.footnote)
                    .fixedSize(horizontal: false, vertical: true)
            }
        } header: {
            Text("Voice")
        } footer: {
            Text(
                "When on, the audio you dictate in this app — the agent, Briefs and Tell Omnesis — is sent "
                    + "to your gateway, which transcribes it and returns the text. Nothing is stored. This is "
                    + "a gateway setting, so it applies to every device paired with it. Siri and Apple Watch "
                    + "dictation are unaffected."
            )
        }
        .listRowBackground(Theme.bgSecondary)
        .onChange(of: status.enabled) { _, enabled in
            if enabled == saved { saved = nil }
        }
    }

    private var shown: Bool {
        pending ?? saved ?? status.enabled
    }

    /// A warning line with its icon set tight against the text, rather than
    /// in the list's icon column.
    private func notice(_ text: String, color: Color) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 6) {
            Image(systemName: "exclamationmark.triangle.fill")
            Text(text)
        }
        .foregroundStyle(color)
    }

    private func write(_ enabled: Bool) {
        guard pending == nil, enabled != shown else { return }
        pending = enabled
        writeError = nil
        Task {
            do {
                try await store.setGatewayDictation(enabled: enabled)
                // The write landed; keep showing it even if the status
                // refresh that follows did not.
                saved = store.dictationStatus?.enabled == enabled ? nil : enabled
            } catch {
                writeError = GatewayErrorView.classify(error).detail(for: "change gateway dictation")
            }
            pending = nil
        }
    }
}

#if DEBUG
@available(iOS 17.0, *)
#Preview("Voice — off") {
    Form { VoiceSettingsSection(status: PreviewMocks.dictationStatusOff) }
        .scrollContentBackground(.hidden)
        .background(Theme.bgPrimary)
        .environment(AppStore.preview())
}

@available(iOS 17.0, *)
#Preview("Voice — on, transcriber running") {
    Form { VoiceSettingsSection(status: PreviewMocks.dictationStatusActive) }
        .scrollContentBackground(.hidden)
        .background(Theme.bgPrimary)
        .environment(AppStore.preview())
}

@available(iOS 17.0, *)
#Preview("Voice — on, transcriber cannot run") {
    Form { VoiceSettingsSection(status: PreviewMocks.dictationStatusBlocked) }
        .scrollContentBackground(.hidden)
        .background(Theme.bgPrimary)
        .environment(AppStore.preview())
}

@available(iOS 17.0, *)
#Preview("Voice — write failed") {
    Form {
        VoiceSettingsSection(
            status: PreviewMocks.dictationStatusOff,
            previewWriteError: "Check that the gateway is running and this phone has internet."
        )
    }
    .scrollContentBackground(.hidden)
    .background(Theme.bgPrimary)
    .environment(AppStore.preview())
}
#endif
#endif
