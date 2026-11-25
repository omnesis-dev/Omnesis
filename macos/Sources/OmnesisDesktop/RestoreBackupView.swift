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
                        Text("This connected Mac cannot replace your library’s stores or silently become a new library Mac.")
                            .foregroundStyle(.secondary)
                    } else if flow.startupVerified {
                        Label(
                            flow.outcome?.status == .rolledBack ? "Previous library is running" : "Backup restored and verified",
                            systemImage: "checkmark.shield"
                        )
                        .font(.title2).foregroundStyle(.green)
                        Text(
                            "The library has passed its startup and encryption checks. Review Sources and resume only the connections you want to collect from."
                        )
                        if flow.outcome?.modelRolesPaused == true {
                            Text("Model connections are kept; model assignments pause until you review them in Settings.")
                        }
                        if let review = flow.status?.review { DesktopRestoreReviewView(review: review) }
                        Button("Review models") { store.settingsTab = "ai"
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
                                .status == .committed ? "Backup applied; start to verify" : "Previous library recovered; start to verify",
                            systemImage: "pause.circle"
                        )
                        .font(.headline)
                        Text(
                            "Omnesis remains stopped. Start it explicitly to check the library before treating this restoration as complete."
                        )
                        if outcome.modelRolesPaused == true {
                            Text("Model connections are kept; model assignments pause until you review them in Settings.")
                        }
                        if let review = flow.status?.review { DesktopRestoreReviewView(review: review) }
                        if outcome
                            .automaticDeletionPaused ==
                            true { Text("Automatic deletion is paused. Review storage and retention after verification.") }
                        if let count = outcome.sourcesPaused { LabeledContent("Sources kept paused", value: count.formatted()) }
                        if let count = outcome.watchesPaused { LabeledContent("Watches kept paused", value: count.formatted()) }
                        Text(outcome
                            .recoveryCopyRetained ? "A protected recovery copy has been kept." : "No retained recovery copy was reported.")
                            .foregroundStyle(.secondary)
                        if flow.requiresAccount { accountFields }
                        Button("Start and verify library") {
                            flow.startAndVerify(params: accountParameters)
                            invitation = ""
                        }.buttonStyle(.borderedProminent).disabled(flow.busy || (flow.requiresAccount && !termsAccepted))
                        recoveryControls
                    } else if let status = flow.status, status.status == .pending || status.status == .recoveryRequired {
                        Label("A previous restoration needs attention", systemImage: "exclamationmark.triangle")
                        Text(
                            "Omnesis has kept this library stopped. Check the pending operation or return to its verified recovery copy before starting another restore."
                        )
                        Button("Verify pending restoration") { flow.startAndVerify() }.disabled(flow.busy || status.status != .pending)
                        recoveryControls
                    } else if flow.requiresAccount {
                        accountFields
                        Button("Connect account for restoration") {
                            flow.connectAccount(params: accountParameters)
                            invitation = ""
                        }.buttonStyle(.borderedProminent).disabled(!termsAccepted || flow.busy)
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
                            "This explicitly prepares a library here. Keep any other Mac serving that library stopped while you recover it. Your devices may need to connect again."
                        )
                        Toggle("I want this Mac to keep the restored library", isOn: $confirmedHome)
                        Button("Prepare this Mac for restoration") {
                            flow.prepareHome(name: Host.current().localizedName ?? "My Mac")
                        }.disabled(!confirmedHome || flow.busy)
                    }
                    if let error = flow.error { Text(error).foregroundStyle(.red).textSelection(.enabled) }
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
            .onChange(of: store.state.phase) { flow.observeAccountContext(store.state) }
            .onDisappear { invitation = ""
                Task { await flow.cancel() }
            }
            .sheet(item: $store.interaction) { RuntimeInteractionView(interaction: $0).environment(store) }
            .confirmationDialog("Replace this Mac’s managed library stores?", isPresented: $confirmApply) {
                Button("Apply the reviewed backup", role: .destructive) { flow.apply() }
            } message: {
                Text(
                    "Current managed stores will be replaced by the reviewed backup. Omnesis first preserves a protected recovery copy. Model connections are kept; model assignments pause until you review them in Settings. Automatic deletion is paused for review. Omnesis stays stopped until you explicitly start and verify it."
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
            Toggle("Allow Omnesis to create my secure address under the certificate authority’s terms", isOn: $termsAccepted)
            if let terms = flow.signup?.acmeTermsUrl, terms.scheme == "https", terms.user == nil, terms.password == nil {
                Link("Certificate authority terms", destination: terms)
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
            Toggle("Replace this Mac’s managed library stores with this backup", isOn: $flow.confirmReplacement)
            Text("Model connections are kept; model assignments pause until you review them in Settings.")
            Text("Automatic deletion will be paused until you review storage and retention choices.")
            Button("Apply backup…") { confirmApply = true }.buttonStyle(.borderedProminent).disabled(!flow.canApply)
        }
    }

    private func count(_ label: String, _ value: Int64?) -> some View {
        LabeledContent(label, value: value.map { $0 >= 0 ? $0.formatted() : "Unavailable" } ?? "Not measured")
    }
}
