// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import AppKit
import DesktopCore
import ServiceManagement
import SwiftUI

struct DesktopRemovalView: View {
    @Environment(DesktopStore.self) private var store
    @Environment(\.dismiss) private var dismiss
    @State private var eraseData = false
    @State private var confirmErase = false
    @State private var localFailure: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 20) {
            if let outcome = store.removalOutcome {
                Label(outcome.title, systemImage: outcome.finished ? "checkmark.circle.fill" : "exclamationmark.triangle")
                    .font(.title2.bold())
                Text(outcome.message).textSelection(.enabled)
                if outcome.finished {
                    Text("Quit Omnesis, then move the Omnesis app from Applications to Trash.")
                    HStack {
                        Button("Done") { dismiss() }
                        Spacer()
                        Button("Quit Omnesis") { NSApp.terminate(nil) }.buttonStyle(.borderedProminent)
                    }
                } else {
                    Button("Retry saved key cleanup") { review() }.buttonStyle(.borderedProminent)
                    Button("Keep the app for now") { dismiss() }
                }
            } else {
                Text("Remove Omnesis from this Mac").font(.title2.bold())
                Text("Omnesis will stop on this Mac and will no longer start when you sign in.")
                if store.state.mode == "home" {
                    Text(
                        "This Mac keeps your library. Your other devices will not be able to search or ask Omnesis until you set it up again."
                    )
                    .foregroundStyle(.secondary)
                }
                Toggle("Also erase the Omnesis library on this Mac", isOn: $eraseData)
                    .onChange(of: eraseData) { store.removalPlan = nil }
                    .accessibilityIdentifier("remove-erase-data")
                Text(eraseData ?
                    "This permanently deletes Omnesis data and its saved encryption key on this Mac. Your original files and accounts are unaffected." :
                    "Your library and its encryption key will be kept so you can reinstall later.")
                    .font(.callout).foregroundStyle(eraseData ? Color.orange : Color.secondary)
                if let plan = store.removalPlan {
                    Text(plan.summary).textSelection(.enabled)
                    if plan.canConfirm, plan.mode == (eraseData ? .eraseData : .keepData) {
                        Button(
                            eraseData ? "Remove Omnesis and erase its library…" : "Remove Omnesis, keep my library",
                            role: .destructive
                        ) {
                            if eraseData { confirmErase = true } else { remove(plan) }
                        }.buttonStyle(.borderedProminent)
                    }
                }
                if let failure = localFailure ?? store.failure { Text(failure).foregroundStyle(.red).textSelection(.enabled) }
                if localFailure != nil { Button("Open Login Items settings") { SMAppService.openSystemSettingsLoginItems() } }
                HStack {
                    Button("Cancel") { dismiss() }.keyboardShortcut(.cancelAction)
                    Spacer()
                    if store.removalPlan == nil { Button("Review removal") { review() }.buttonStyle(.borderedProminent) }
                }
                if store.busy { ProgressView("Preparing removal…") }
            }
        }.padding(30).frame(width: 540).disabled(store.busy)
            .interactiveDismissDisabled(store.busy)
            .onAppear {
                if store.state.retirement?.mode == "erase-data", store.state.retirement?.phase != "complete" { eraseData = true }
            }
            .confirmationDialog("Permanently erase the Omnesis library on this Mac?", isPresented: $confirmErase) {
                Button("Erase the library and remove Omnesis", role: .destructive) {
                    if let plan = store.removalPlan, plan.mode == .eraseData { remove(plan) }
                }
                Button("Cancel", role: .cancel) {}
            } message: {
                Text(
                    "This removes the local Omnesis library and its saved encryption key. It cannot be undone. Your original files and accounts are unaffected."
                )
            }
    }

    private func review() {
        localFailure = nil
        store.removalPlan = nil
        store.removalOutcome = nil
        store.command("removePreview", params: ["eraseData": .bool(eraseData)])
    }

    private func remove(_ plan: DesktopRemovalPlan) {
        guard plan.canConfirm, let confirmationId = plan.confirmationId, !store.busy else { return }
        do {
            let service = SMAppService.loginItem(identifier: "dev.omnesis.desktop.background")
            if service.status == .enabled || service.status == .requiresApproval { try service.unregister() }
            store.command("remove", params: ["eraseData": .bool(plan.mode == .eraseData), "confirmationId": .string(confirmationId)])
        } catch { localFailure = "Omnesis could not turn off starting at sign-in. Try again, or turn it off in System Settings first." }
    }
}
