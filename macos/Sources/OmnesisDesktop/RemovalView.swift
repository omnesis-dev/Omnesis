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
    @State private var movingApplication = false
    @State private var confirmTrash = false
    @State private var confirmErase = false
    @State private var localFailure: String?

    @State private var bodyHeight: CGFloat?
    private static let maximumBodyHeight: CGFloat = 320

    var body: some View {
        VStack(alignment: .leading, spacing: DesktopDesignTokens.Space.large) {
            if let outcome = store.removalOutcome {
                Label(outcome.title, systemImage: outcome.finished ? "checkmark.circle.fill" : "exclamationmark.triangle")
                    .font(DesktopDesignTokens.Typography.pageTitle).accessibilityAddTraits(.isHeader)
                    .accessibilityIdentifier("removal-title")
            } else {
                Text("Remove Omnesis from this Mac").font(DesktopDesignTokens.Typography.pageTitle).accessibilityAddTraits(.isHeader)
                    .accessibilityIdentifier("removal-title")
            }
            ScrollView {
                removalDetails.frame(maxWidth: .infinity, alignment: .leading).fixedSize(horizontal: false, vertical: true)
                    .background(GeometryReader { geometry in
                        Color.clear.preference(key: RemovalBodyHeight.self, value: geometry.size.height)
                    })
            }
            .scrollBounceBehavior(.basedOnSize)
            .frame(height: min(bodyHeight ?? Self.maximumBodyHeight, Self.maximumBodyHeight))
            .onPreferenceChange(RemovalBodyHeight.self) { height in
                if let height, height.isFinite, height >= 0 { bodyHeight = height }
            }
            .accessibilityIdentifier("removal-content")
            removalActions
        }.buttonStyle(DesktopButtonStyle()).padding(DesktopDesignTokens.Space.section).frame(width: 540)
            .fixedSize(horizontal: false, vertical: true)
            .disabled(store.busy || movingApplication)
            .interactiveDismissDisabled(store.busy || movingApplication)
            .onAppear {
                if store.state.retirement?.mode == "erase-data", store.state.retirement?.phase != "complete" { eraseData = true }
            }
            .confirmationDialog("Move this Omnesis app to Trash?", isPresented: $confirmTrash) {
                Button("Move app to Trash and quit", role: .destructive) {
                    guard let outcome = store.removalOutcome, outcome.finished else { return }
                    movingApplication = true
                    Task {
                        do { try await DesktopApplicationTrash.removeCurrentApplication(after: outcome) }
                        catch {
                            localFailure =
                                "Omnesis could not move this app to Trash. Quit, then move this copy of the app to Trash in Finder."
                        }
                        movingApplication = false
                    }
                }
            } message: {
                Text("Only this copy of the Omnesis app is moved. Your library follows the removal choice already completed above.")
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

    private var removalDetails: some View {
        VStack(alignment: .leading, spacing: DesktopDesignTokens.Space.large) {
            if let outcome = store.removalOutcome {
                Text(outcome.message).textSelection(.enabled).accessibilityIdentifier("removal-outcome-message")
                if outcome.finished {
                    Text("You can keep the app for later or move this copy of Omnesis to Trash and quit.")
                    if let localFailure { Text(localFailure).foregroundStyle(DesktopTheme.danger) }
                    if movingApplication { ProgressView("Moving Omnesis to Trash…") }
                }
            } else {
                Text("Omnesis will stop on this Mac and will no longer start when you sign in.")
                if store.state.mode == "home" {
                    Text(
                        "This Mac keeps your library. Your other devices will not be able to search or ask Omnesis until you set it up again."
                    )
                    .foregroundStyle(DesktopTheme.secondary)
                }
                Toggle("Also erase the Omnesis library on this Mac", isOn: $eraseData)
                    .onChange(of: eraseData) { store.removalPlan = nil }
                    .accessibilityIdentifier("remove-erase-data")
                Text(eraseData ?
                    "This permanently deletes Omnesis data and its saved encryption key on this Mac. Your original files and accounts are unaffected." :
                    "Your library and its encryption key will be kept so you can reinstall later.")
                    .font(DesktopDesignTokens.Typography.secondary)
                    .foregroundStyle(eraseData ? DesktopTheme.warning : DesktopTheme.secondary)
                if let plan = store.removalPlan {
                    Text(plan.summary).textSelection(.enabled)
                }
                if let failure = localFailure ?? store
                    .failure { Text(failure).foregroundStyle(DesktopTheme.danger).textSelection(.enabled)
                    .accessibilityIdentifier("removal-error")
                }
                if store.busy { ProgressView("Preparing removal…") }
            }
        }
    }

    private var removalActions: some View {
        VStack(alignment: .leading, spacing: DesktopDesignTokens.Space.large) {
            if let outcome = store.removalOutcome {
                if outcome.finished {
                    HStack {
                        Button("Done") { dismiss() }
                        Spacer()
                        Button("Move app to Trash and quit…", role: .destructive) { confirmTrash = true }
                            .buttonStyle(DesktopButtonStyle(primary: true))
                    }
                } else {
                    Button("Retry saved key cleanup") { review() }.buttonStyle(DesktopButtonStyle(primary: true))
                    Button("Keep the app for now") { dismiss() }
                }
            } else {
                if let plan = store.removalPlan {
                    if plan.canConfirm, plan.mode == (eraseData ? .eraseData : .keepData) {
                        Button(
                            eraseData ? "Remove Omnesis and erase its library…" : "Remove Omnesis, keep my library",
                            role: .destructive
                        ) {
                            if eraseData { confirmErase = true } else { remove(plan) }
                        }.buttonStyle(DesktopButtonStyle(primary: true))
                    }
                }
                if localFailure != nil { Button("Open Login Items settings") { SMAppService.openSystemSettingsLoginItems() } }
                HStack {
                    Button("Cancel") { dismiss() }.keyboardShortcut(.cancelAction)
                    Spacer()
                    if store.removalPlan == nil { Button("Review removal") { review() }.buttonStyle(DesktopButtonStyle(primary: true)) }
                }
            }
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

private struct RemovalBodyHeight: PreferenceKey {
    static let defaultValue: CGFloat? = nil
    static func reduce(value: inout CGFloat?, nextValue: () -> CGFloat?) {
        guard let next = nextValue() else { return }
        value = value.map { max($0, next) } ?? next
    }
}
