// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import AppKit
import DesktopCore
import SwiftUI

struct DesktopRestoreBackupView: View {
    @Environment(DesktopStore.self) private var store
    @Environment(\.dismiss) private var dismiss
    @Environment(\.openSettings) private var openSettings
    @State var flow: DesktopRestoreBackupFlow
    @State private var confirmedHome = false
    @State private var confirmApply = false
    @State private var confirmRecovery = false
    @State private var accountIntent = DesktopAccountIntent.existing
    @State private var invitation = ""
    @State private var termsAccepted = false

    var body: some View {
        @Bindable var flow = flow
        @Bindable var store = store
        VStack(alignment: .leading, spacing: 16) {
            Text("Restore a backup").font(.title2.bold())
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    if store.state.mode == "joined" {
                        Text(store.state.homeName
                            .map { "Your library is kept on \($0). Restore its backup there." } ??
                            "Restore a backup on the Mac that keeps your library.")
                        Text("This Mac connects to that library. It cannot restore the library stored on your other Mac.")
                            .foregroundStyle(.secondary)
                    } else if flow.startupVerified {
                        Label(
                            flow.outcome?.status == .rolledBack ? "Previous library is running" : "Your backup is restored",
                            systemImage: "checkmark.shield"
                        )
                        .font(.title2).foregroundStyle(.green)
                        Text(
                            "The library has passed its startup and encryption checks. Review Sources and resume only the connections you want to collect from."
                        )
                        if flow.outcome?.modelRolesPaused == true {
                            Text("Your model connections are kept. Choose which models may use your restored information in Settings.")
                        }
                        if let review = flow.status?.review { DesktopRestoreReviewView(review: review) }
                        DesktopRecordingReviewNotice(afterRestore: true)
                        Button("Review models") { store.reviewModelsAfterRestore = true
                            store.settingsTab = "ai"
                            dismiss()
                            openSettings()
                        }
                        if flow.outcome?.automaticDeletionPaused == true {
                            Text("Automatic deletion stays paused until you review storage and retention choices.")
                        }
                        Button("Review storage and retention") { store.settingsTab = "storage"
                            dismiss()
                            openSettings()
                        }
                    } else if let outcome = flow.outcome {
                        Label(
                            outcome
                                .status == .committed ? "Backup applied; check it by starting Omnesis" :
                                "Previous library recovered; check it by starting Omnesis",
                            systemImage: "pause.circle"
                        )
                        .font(.headline)
                        Text(
                            "Your backup has been applied, but Omnesis has not checked it while running yet. Start Omnesis below to finish restoring."
                        )
                        if outcome.modelRolesPaused == true {
                            Text("Your model connections are kept. Choose which models may use your restored information in Settings.")
                        }
                        if let review = flow.status?.review { DesktopRestoreReviewView(review: review) }
                        if outcome
                            .automaticDeletionPaused ==
                            true { Text("Automatic deletion is paused. Review how long information is kept after your library starts.") }
                        if let count = outcome.sourcesPaused { LabeledContent("Sources kept paused", value: count.formatted()) }
                        if let count = outcome.watchesPaused { LabeledContent("Watches kept paused", value: count.formatted()) }
                        Text(outcome
                            .recoveryCopyRetained ? "A protected recovery copy has been kept." : "No retained recovery copy was reported.")
                            .foregroundStyle(.secondary)
                        if flow.requiresAccount { accountFields }
                        Button("Start Omnesis and finish restoring") {
                            flow.startAndVerify(params: accountParameters)
                            invitation = ""
                        }.buttonStyle(DesktopButtonStyle(primary: true))
                            .disabled(flow.busy || (flow.requiresAccount && (!termsAccepted || flow.signup?.readableTermsURL == nil)))
                        recoveryControls
                    } else if let status = flow.status, status.status == .pending || status.status == .recoveryRequired {
                        Label("A previous restoration needs attention", systemImage: "exclamationmark.triangle")
                        Text(
                            "Omnesis has kept this library stopped. Check the pending operation or return to its verified recovery copy before starting another restore."
                        )
                        Button("Start Omnesis to check the restoration") { flow.startAndVerify() }
                            .disabled(flow.busy || status.status != .pending)
                        recoveryControls
                    } else if flow.requiresAccount {
                        accountFields
                        Button("Connect account for restoration") {
                            flow.connectAccount(params: accountParameters)
                            invitation = ""
                        }.buttonStyle(DesktopButtonStyle(primary: true))
                            .disabled(!termsAccepted || flow.signup?.readableTermsURL == nil || flow.busy)
                    } else if let preview = flow.preview {
                        if preview.needsRecoveryCode {
                            DesktopRestoreRecoveryInput(code: $flow.recoveryCode, envelope: $flow.recoveryEnvelope)
                            Button("Unlock and review backup") { flow.unlockOrReview() }
                                .disabled(flow.busy || flow.recoveryCode.isEmpty || flow.recoveryCode.count > 512)
                        } else {
                            review(preview)
                        }
                    } else if let slot = flow.slot, slot.selectable {
                        DesktopRestoreSelectionView(maximumBytes: slot.maxBytes ?? 0, selected: flow.selected) { flow.select($0) }
                            .disabled(flow.busy || flow.imported)
                        if flow.imported {
                            Button("Review imported backup again") { flow.unlockOrReview() }.disabled(flow.busy)
                        }
                    } else if store.state.mode == "home" {
                        Text(
                            "Choose an Omnesis backup to review before replacing this Mac’s managed library stores. A recovery copy is required before any replacement."
                        )
                        Button("Prepare backup selection") { flow.begin() }.disabled(flow.busy)
                    } else {
                        Text("Restore your saved library on this Mac")
                            .font(.headline)
                        Text(
                            "Choose the Mac you leave at home and keep awake. Your other devices cannot use its library while this Mac sleeps."
                        )
                        Text(
                            "This will keep the restored library on this Mac. Leave any other Mac that keeps this library stopped while you restore it. You may need to reconnect your devices."
                        )
                        Toggle("I want this Mac to keep the restored library", isOn: $confirmedHome)
                        Button("Prepare this Mac for restoration") {
                            flow.prepareHome(name: Host.current().localizedName ?? "My Mac")
                        }.disabled(!confirmedHome || flow.busy)
                    }
                    if let error = flow.error { Text(error).foregroundStyle(DesktopTheme.danger).textSelection(.enabled) }
                }.frame(maxWidth: .infinity, alignment: .leading)
            }
            if flow.busy || flow
                .cancelling { ProgressView(flow.cancelling ? "Cancelling and checking the operation…" : "Working on the backup…") }
            HStack {
                Button(flow.busy ? "Cancel operation" : "Close") {
                    let wasRunning = flow.busy
                    Task { await flow.cancel()
                        if !flow.busy, !flow.cancelling, !wasRunning || !flow.needsRecoveryAttention { dismiss() }
                    }
                }.disabled(flow.cancelling)
                Spacer()
            }
        }.padding(28).frame(width: 680, height: 650)
            .interactiveDismissDisabled(flow.busy || flow.cancelling)
            .task { flow.observeAccountContext(store.state)
                if flow.status == nil {
                    if store.state.mode == "home" { flow.begin() }
                    else { flow.refreshRecovery() }
                }
            }
            .onChange(of: store.state) { flow.observeAccountContext(store.state) }
            .onChange(of: flow.signup?.readableTermsURL) { termsAccepted = false }
            .onDisappear { invitation = ""
                Task { await flow.cancel() }
            }
            .omnesisSheet(item: $store.interaction) { RuntimeInteractionView(interaction: $0).environment(store) }
            .confirmationDialog("Replace this Mac’s library?", isPresented: $confirmApply) {
                Button("Apply the reviewed backup", role: .destructive) { flow.apply() }
            } message: {
                Text(
                    "This Mac’s library will be replaced by the backup you reviewed. Omnesis first preserves a protected recovery copy. Your model connections are kept. Choose which models may use your restored information in Settings. Automatic deletion is paused for review. Omnesis stays stopped until you choose to start it and finish checking the restored library."
                )
            }
            .confirmationDialog("Return to the previous library?", isPresented: $confirmRecovery) {
                Button("Recover previous library", role: .destructive) { flow.recoverPreviousLibrary() }
            } message: {
                Text(
                    "Omnesis will use its verified recovery copy, or verify that the previous library was not changed before clearing the interrupted operation. This replaces changes from the pending restoration. Omnesis stays stopped until you start it."
                )
            }
    }

    @ViewBuilder private var recoveryControls: some View {
        if flow.status?.recoveryOperation != nil {
            Button("Return to previous library…") { confirmRecovery = true }.disabled(flow.busy)
        }
        Button("Refresh recovery status") { flow.refreshRecovery() }.disabled(flow.busy)
    }

    private var accountParameters: [String: BridgeValue] {
        flow.requiresAccount ? accountIntent.parameters(invite: invitation, termsAccepted: termsAccepted) : [:]
    }

    private var accountFields: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Connect your account before starting").font(.headline)
            Picker("Omnesis account", selection: $accountIntent) {
                Text("I have an account").tag(DesktopAccountIntent.existing)
                Text("Create an account").tag(DesktopAccountIntent.create)
            }.pickerStyle(.segmented)
            if accountIntent == .create, flow.signup?.policy != "open" {
                TextField("Invitation code or link", text: $invitation).privacySensitive()
            }
            Text("A certificate authority issues the certificate for your private address, so your devices can verify this Mac.")
                .font(.callout).foregroundStyle(.secondary)
            Toggle("I accept the certificate authority’s terms for my secure address", isOn: $termsAccepted)
                .disabled(flow.signup?.readableTermsURL == nil)
            if let terms = flow.signup?.readableTermsURL {
                Link("Certificate authority terms", destination: terms)
            } else {
                Text(
                    "The certificate authority’s terms could not be loaded. Check your connection, then check restoration status again before continuing."
                )
                .font(.callout).foregroundStyle(.secondary)
            }
            Text(
                "Finish sign-in in your browser and return here. A startup check still has to pass before this backup is reported restored."
            )
            .font(.callout).foregroundStyle(.secondary)
        }
    }

    private func review(_ preview: DesktopRestorePreview) -> some View {
        @Bindable var flow = flow
        return VStack(alignment: .leading, spacing: 12) {
            Text("Review this backup").font(.headline)
            if let selected = flow.selected { Text(URL(fileURLWithPath: selected.path).lastPathComponent).privacySensitive() }
            if let version = preview.version { LabeledContent("Created by Omnesis", value: version) }
            if let date = preview.createdAt { LabeledContent("Backup date", value: date) }
            count("Documents", preview.summary?.documents)
            count("Sources", preview.summary?.sources)
            count("Watches", preview.summary?.watches)
            count("Analytics rows", preview.summary?.analyticsRows)
            ForEach(preview.includedData ?? [], id: \.self) { Text($0) }
            ForEach(preview.consequences ?? [], id: \.self) { Label($0, systemImage: "info.circle") }
            if preview.originalMayBeReadable {
                Text(
                    "The original selected archive may contain readable private information. Omnesis does not change or remove that original file."
                )
                Toggle("I understand the original file remains readable", isOn: $flow.acknowledgeReadableOriginal)
            }
            Toggle("Replace this Mac’s library with this backup", isOn: $flow.confirmReplacement)
            Text("Your model connections are kept. Choose which models may use your restored information in Settings.")
            Text("Automatic deletion will be paused until you review storage and retention choices.")
            Button("Apply backup…") { confirmApply = true }.buttonStyle(DesktopButtonStyle(primary: true)).disabled(!flow.canApply)
        }
    }

    private func count(_ label: String, _ value: Int64?) -> some View {
        LabeledContent(label, value: value.map { $0 >= 0 ? $0.formatted() : "Unavailable" } ?? "Not measured")
    }
}
