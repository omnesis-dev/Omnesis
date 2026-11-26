// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import DesktopCore
import SwiftUI

struct DesktopRecoveryCopiesSection: View {
    var context: DesktopAPIContext?
    @Environment(DesktopStore.self) private var store
    @State private var flow: DesktopRecoveryCopiesFlow?
    @State private var confirmRetry = false
    var loadCatalog = true
    init(flow: DesktopRecoveryCopiesFlow? = nil, loadCatalog: Bool = true, context: DesktopAPIContext? = nil) {
        self.context = context
        _flow = State(initialValue: flow)
        self.loadCatalog = loadCatalog
    }

    private var disabled: Bool {
        store.busy || store.state.retired == true
    }

    var body: some View {
        Section("Automatic recovery copies on this Mac") {
            Text(
                "Omnesis keeps protected copies before updates and restorations. These stay on this Mac and are separate from the backups and exports you save elsewhere."
            )
            .foregroundStyle(DesktopTheme.secondary)
            if store.state.mode == "joined" {
                Text(store.state.homeName
                    .map { "These protect this Mac’s setup. Your library stays on \($0); manage its backups there." }
                    ?? "These protect this Mac’s setup. Manage library backups on your library server.")
                    .font(.callout).foregroundStyle(DesktopTheme.secondary)
            }
            if let flow {
                if flow.busy {
                    HStack {
                        ProgressView(flow.stopping ? "Waiting for Omnesis to stop safely…" : flow.progress)
                        Spacer()
                        if flow.canStop {
                            Button("Stop") { flow.cancelActive() }.buttonStyle(DesktopButtonStyle()).disabled(flow.stopping)
                                .accessibilityIdentifier("stop-recovery-cleanup")
                        }
                    }
                }
                if !flow.catalogCurrent, !flow.busy, flow.error == nil {
                    Text("Refresh the list before changing or removing a copy.").foregroundStyle(DesktopTheme.secondary)
                }
                if let error = flow
                    .error { Text(error).foregroundStyle(DesktopTheme.danger).accessibilityIdentifier("recovery-copy-error") }
                if let notice = flow
                    .notice { Text(notice).foregroundStyle(DesktopTheme.secondary).accessibilityIdentifier("recovery-copy-notice") }
                Button("Refresh recovery copies") { Task { await flow.refresh() } }.buttonStyle(DesktopButtonStyle())
                    .disabled(flow.busy || store.busy)
                    .accessibilityIdentifier("refresh-recovery-copies")
                if let catalog = flow.catalog {
                    LabeledContent("Recorded copies", value: "\(catalog.items.count) of \(catalog.limit)")
                    if let pending = catalog.pending { pendingView(pending, catalog: catalog, flow: flow) }
                    ForEach(catalog.items) { copy in
                        VStack(alignment: .leading, spacing: 8) {
                            Text(copyName(copy)).font(.headline)
                            LabeledContent(
                                "Retained",
                                value: copy.retainedDate?.formatted(date: .abbreviated, time: .shortened) ?? "Date unavailable"
                            )
                            LabeledContent("Recorded size", value: size(copy.bytes))
                            Text(copy.protectionLabel).font(.callout).foregroundStyle(DesktopTheme.secondary)
                            HStack {
                                Toggle("Always keep this copy", isOn: Binding(get: { copy.pinned }, set: { value in
                                    Task { await flow.setPinned(copy.id, value) }
                                }))
                                .disabled(flow.busy || disabled || !flow.catalogCurrent || catalog.pending != nil || copy
                                    .disposition == .unavailable)
                                .accessibilityIdentifier("keep-recovery-" + copy.id)
                                Spacer()
                                if copy.canReview, !copy.pinned,
                                   [.redundantSnapshot, .lastCopyOldEpoch].contains(copy.disposition) {
                                    Button("Review removal") { Task { await flow.review(copy.id) } }
                                        .buttonStyle(DesktopButtonStyle())
                                        .disabled(flow.busy || disabled || !flow.catalogCurrent || catalog.pending != nil)
                                        .accessibilityIdentifier("review-recovery-" + copy.id)
                                }
                            }
                        }.padding(.vertical, 8)
                    }
                    ForEach(Array(catalog.partialCopies.enumerated()), id: \.offset) { _, copy in
                        VStack(alignment: .leading, spacing: 8) {
                            Label(
                                copy.purpose == .update ? "An unfinished update copy is kept" : "An unfinished restoration copy is kept",
                                systemImage: "pause.circle"
                            )
                            if copy.ownership == .unknown {
                                Text("Its ownership could not be confirmed, so Omnesis keeps it unchanged.").font(.callout)
                                    .foregroundStyle(DesktopTheme.secondary)
                            } else if copy.canReview {
                                Button("Review unfinished copy") {
                                    Task { await flow.review(copy.id, staging: copy.staging, partial: true) }
                                }
                                .buttonStyle(DesktopButtonStyle())
                                .disabled(flow.busy || disabled || !flow.catalogCurrent || catalog.pending != nil)
                                .accessibilityIdentifier("review-partial-recovery-" + copy.id)
                            }
                        }
                    }
                    if catalog.unregisteredCopies > 0 {
                        Text(
                            "Older copies not listed individually: \(catalog.unregisteredCopies). Their ownership is uncertain, so they stay kept."
                        )
                        .font(.callout).foregroundStyle(DesktopTheme.secondary)
                    }
                    if catalog.items.isEmpty, catalog.partialCopies.isEmpty, catalog.unregisteredCopies == 0 {
                        Text("No automatic recovery copies are recorded on this Mac.").foregroundStyle(DesktopTheme.secondary)
                    }
                }
            }
        }
        .omnesisSheet(isPresented: Binding(get: { flow?.preview != nil }, set: { if !$0 { flow?.dismissReview() } })) {
            if let flow, let preview = flow.preview { DesktopRecoveryCopyConfirmation(flow: flow, preview: preview).omnesisTheme() }
        }
        .task {
            if flow == nil { flow = DesktopRecoveryCopiesFlow { [weak store] name, params in
                guard let store else { throw DesktopRecoveryCopiesFlow.Failure("Reopen Omnesis to continue.") }
                guard let context else { throw CancellationError() }
                return try await context.perform { _ in try await store.request(name, params: params) }
            } }
            if loadCatalog { await flow?.refresh() }
        }
        .onDisappear { flow?.cancelActive() }
    }

    private func pendingView(
        _ pending: DesktopRecoveryCopiesCatalog.Pending,
        catalog: DesktopRecoveryCopiesCatalog,
        flow: DesktopRecoveryCopiesFlow
    )
        -> some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(pending.phase == .deleting ? "A recovery-copy removal needs to finish" : "A recovery-copy removal is pending")
                .font(.headline)
            Text(pendingName(pending, catalog: catalog)).foregroundStyle(DesktopTheme.secondary)
            if let keeper = catalog.items.first(where: { $0.id == pending.keeperId }) {
                Text(
                    "Kept copy: \(copyName(keeper)) · \(keeper.retainedDate?.formatted(date: .abbreviated, time: .shortened) ?? "Date unavailable")"
                )
                .font(.callout).foregroundStyle(DesktopTheme.secondary)
            }
            Text(
                pending.phase == .deleting ? "Some of this selected copy may already be removed. Finishing uses the same original copy; other copies are kept."
                    : "You can finish removing this selected copy, or keep it and cancel the pending removal."
            )
            .font(.callout).foregroundStyle(DesktopTheme.secondary)
            if !pending.hasCleanupBinding {
                Text("Omnesis could not identify this pending choice safely. Refresh the list before continuing.").font(.callout)
                    .foregroundStyle(DesktopTheme.secondary)
            }
            HStack {
                Button("Finish removal", role: .destructive) { confirmRetry = true }
                    .buttonStyle(DesktopButtonStyle())
                    .disabled(flow.busy || disabled || !flow.catalogCurrent || !pending.hasCleanupBinding)
                    .accessibilityIdentifier("retry-recovery-cleanup")
                if pending.phase == .planned, pending.canCancel {
                    Button("Keep the copy") { Task { await flow.cancelPending(expectedId: pending.id) } }.buttonStyle(DesktopButtonStyle())
                        .disabled(flow.busy || disabled || !flow.catalogCurrent || !pending.hasCleanupBinding)
                        .accessibilityIdentifier("cancel-pending-recovery-cleanup")
                }
            }
        }.padding(.vertical, 8)
            .confirmationDialog("Finish removing this automatic recovery copy?", isPresented: $confirmRetry, titleVisibility: .visible) {
                Button("Finish removal", role: .destructive) { Task { await flow.retryPending(expectedId: pending.id) } }
                Button("Keep pending", role: .cancel) {}
            } message: { Text(pendingName(pending, catalog: catalog) + "\nPersonal backups and exports are kept.") }
    }

    private func pendingName(_ pending: DesktopRecoveryCopiesCatalog.Pending, catalog: DesktopRecoveryCopiesCatalog) -> String {
        if pending.mode == .incompleteOwned { return "The unfinished automatic copy selected earlier" }
        guard let copy = catalog.items.first(where: { $0.id == pending.snapshotId })
        else { return "The automatic recovery copy selected earlier" }
        return copyName(copy) + " · " + (copy.retainedDate?.formatted(date: .abbreviated, time: .shortened) ?? "Date unavailable")
    }

    private func copyName(_ copy: DesktopRecoveryCopiesCatalog.Copy) -> String {
        "Copy \(copy.order.formatted()) · \(copy.purpose == .update ? "Before an update" : "Before a restoration") · Omnesis \(copy.oldVersion)"
    }

    private func size(_ bytes: Int64) -> String {
        ByteCountFormatter.string(fromByteCount: bytes, countStyle: .file)
    }
}

struct DesktopRecoveryCopyConfirmation: View {
    @Bindable var flow: DesktopRecoveryCopiesFlow
    let preview: DesktopRecoveryCleanupPreview
    @State private var understood = false
    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            Text("Remove this automatic recovery copy?").font(.title2.bold()).accessibilityAddTraits(.isHeader)
            Text(preview.selected?.label ?? "The selected unfinished automatic recovery copy").font(.headline)
            LabeledContent(
                "Recorded size",
                value: preview.bytes.map { ByteCountFormatter.string(fromByteCount: $0, countStyle: .file) } ?? "Not measured"
            )
            if let keeper = preview.keeper {
                VStack(alignment: .leading, spacing: 6) {
                    Label("This newer recovery copy stays kept", systemImage: "checkmark.shield")
                    Text(keeper.label).font(.callout).foregroundStyle(DesktopTheme.secondary)
                }
            } else if preview.mode == .lastCopyOldEpoch {
                Text(
                    "This is the last automatic copy for that earlier Omnesis app. Omnesis checks that the app is no longer using it before removal."
                )
                .foregroundStyle(DesktopTheme.secondary)
            }
            Text(preview.message).foregroundStyle(DesktopTheme.secondary)
            Toggle("I understand this removes the selected automatic copy", isOn: $understood)
                .accessibilityIdentifier("confirm-recovery-copy-understood")
            HStack {
                Spacer()
                Button("Keep copy", role: .cancel) { flow.dismissReview() }.buttonStyle(DesktopButtonStyle())
                    .keyboardShortcut(.cancelAction)
                Button("Remove copy", role: .destructive) { Task { await flow.removeReviewed(confirmationId: preview.confirmationId) } }
                    .buttonStyle(DesktopButtonStyle(primary: true)).disabled(!understood || !preview.valid || flow.busy)
                    .accessibilityIdentifier("confirm-remove-recovery-copy")
            }
        }.padding(24).frame(width: 620).fixedSize(horizontal: false, vertical: true)
            .interactiveDismissDisabled(flow.busy)
    }
}
