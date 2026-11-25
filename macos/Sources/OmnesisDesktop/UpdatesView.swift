// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import DesktopCore
import SwiftUI

struct DesktopUpdatesView: View {
    var loadStatus = true
    @Environment(DesktopStore.self) private var store
    @State private var confirmation: Action?
    private struct Action: Identifiable {
        let command: String
        let title: String
        let explanation: String
        let token: String?
        var id: String {
            command
        }
    }

    var body: some View {
        Form {
            Section("Omnesis app updates") {
                if let update = store.update {
                    LabeledContent("Current version", value: update.currentVersion)
                    if let version = update.targetVersion { LabeledContent("Update version", value: version) }
                    Text(update.message).textSelection(.enabled)
                    if update.currentApplicationAvailable == true {
                        action(
                            "Prepare the app installed on this Mac",
                            command: "updatePrepareCurrent",
                            explanation: "Omnesis will verify this app and the retained previous app. A separate confirmation is required before backing up and switching your library."
                        )
                    }
                    if update.phase == .available {
                        action(
                            "Download and verify update",
                            command: "updateDownload",
                            explanation: "Download the official installer and check its signature. Your library keeps running during this step.",
                            token: update.confirmation
                        )
                    }
                    if update.phase == .verified {
                        action(
                            "Back up and continue update…",
                            command: "updateInstall",
                            explanation: "Omnesis will stop this Mac’s library connection and preserve a private backup and the previous app. It then activates the verified installed app, or opens the verified installer in Finder. If Finder opens, drag Omnesis to Applications and open the installed app to continue.",
                            token: update.confirmation
                        )
                    }
                    if [.installerOpened, .candidateStarted, .recoveryRequired, .stopping, .backedUp, .complete].contains(update.phase) {
                        Button("Check installation") { store.command("updateStatus") }
                        action(
                            "Return to the previous app…",
                            command: "updateRestore",
                            explanation: "Restore the verified backup taken before this update and open the retained previous app. Changes made after that backup will be replaced. Omnesis refuses if the previous app or backup cannot be verified.",
                            token: update.confirmation
                        )
                    }
                    if update.phase == .candidateStarted {
                        action(
                            "Finish update",
                            command: "updateFinish",
                            explanation: "Confirm this version is working. Omnesis will check the library’s actual health before recording completion.",
                            token: update.confirmation
                        )
                    }
                } else { Text("Check your installed app and update status.").foregroundStyle(.secondary) }
                Button("Check for updates") { store.command("updateCheck") }.disabled(store.busy)
                if store.busy {
                    ProgressView("Working…")
                    if store.updateBytes > 0 {
                        Text("Downloaded \(ByteCountFormatter.string(fromByteCount: store.updateBytes, countStyle: .file))")
                            .font(.caption).foregroundStyle(.secondary)
                    }
                    Button("Cancel") { store.command("cancel") }
                }
                if let failure = store.failure { Text(failure).foregroundStyle(.red).textSelection(.enabled) }
            }
            Section("Your information") {
                Text(
                    "Updates preserve your encrypted library. A retained app alone cannot undo database changes; returning to an earlier version requires the matching verified backup."
                )
                .foregroundStyle(.secondary)
            }
        }.formStyle(.grouped)
            .task { if loadStatus, !store.busy { store.command("updateStatus") } }
            .confirmationDialog(confirmation?.title ?? "Review update", isPresented: Binding(
                get: { confirmation != nil }, set: { if !$0 { confirmation = nil } }
            ), presenting: confirmation) { action in
                Button(action.title) {
                    Task { await store.performUpdateCommand(
                        action.command,
                        params: action.token.map { ["confirmationId": .string($0)] } ?? [:]
                    ) }
                    confirmation = nil
                }
            } message: { action in Text(action.explanation) }
    }

    private func action(_ title: String, command: String, explanation: String, token: String? = nil) -> some View {
        Button(title) { confirmation = Action(command: command, title: title, explanation: explanation, token: token) }
            .disabled(store.busy || (command != "updatePrepareCurrent" && token == nil))
    }
}
