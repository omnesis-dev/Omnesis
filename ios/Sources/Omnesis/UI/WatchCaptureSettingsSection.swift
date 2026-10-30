// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

#if canImport(SwiftUI) && os(iOS)
import Speech
import SwiftUI

struct WatchCaptureSettingsSection: View {
    @Environment(AppStore.self) private var store
    let status: WatchCaptureStatus
    @State private var pending = false
    @State private var saved: Bool?
    @State private var error: String?
    @State private var authorized = SFSpeechRecognizer.authorizationStatus() == .authorized

    var body: some View {
        Section {
            if status.supported {
                Toggle("Use decision gate for Apple Watch complication", isOn: Binding(
                    get: { saved ?? status.enabled }, set: save
                ))
                .disabled(pending || store.pairing == nil)
                if status.enabled, !status.active {
                    Text("Assign a decision model to use Send. Until then, the Watch shows Ask and Tell.")
                        .font(.footnote).foregroundStyle(Theme.textMuted)
                }
            }
            if !authorized {
                Button("Enable iPhone transcription for Watch") {
                    SFSpeechRecognizer.requestAuthorization { result in
                        Task { @MainActor in
                            authorized = result == .authorized
                            if authorized {
                                WatchRelayReceiver.shared.retryComplicationCaptures()
                            } else {
                                error =
                                    "Allow Speech Recognition for Omnesis in iPhone Settings. "
                                        + "On-device recognition also requires a supported language."
                            }
                        }
                    }
                }
            }
            if let error { Text(error).font(.footnote).foregroundStyle(Theme.danger) }
        } header: { Text("Apple Watch") }
            footer: {
                Text(
                    "Speak from the Omnesis complication, then tap once to send. "
                        + "When gateway transcription is off, your iPhone transcribes privately on-device with vocabulary hints. "
                        + "No live transcript appears on the Watch."
                )
            }
            .listRowBackground(Theme.bgSecondary)
            .onChange(of: status.enabled) { _, value in if saved == value { saved = nil } }
    }

    private func save(_ value: Bool) {
        guard !pending, let client = store.dictationClient else { return }
        pending = true
        error = nil
        Task {
            defer { pending = false }
            do {
                try await client.setWatchDecisionGate(value)
                saved = value
                await store.refreshGatewayStats()
            } catch { self.error = "Couldn't save the Watch setting. Try again when your gateway is reachable." }
        }
    }
}

#if DEBUG
#Preview("Watch automatic") {
    Form { WatchCaptureSettingsSection(status: .init(supported: true, enabled: true, active: true)) }
        .environment(AppStore.preview())
}

#Preview("Watch manual") {
    Form { WatchCaptureSettingsSection(status: .init(supported: true, enabled: false, active: false)) }
        .environment(AppStore.preview())
}

#Preview("Watch decision unavailable") {
    Form { WatchCaptureSettingsSection(status: .init(supported: true, enabled: true, active: false)) }
        .environment(AppStore.preview())
}
#endif
#endif
