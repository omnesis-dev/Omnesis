// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

#if canImport(SwiftUI) && canImport(UIKit)
import SwiftUI

/// Exceptional recovery surface for notes that have remained on the
/// phone. It deliberately shows only the local delivery queue—not note
/// history already accepted by the gateway.
@available(iOS 17.0, *)
struct PendingNotesDiagnosticSheet: View {
    @Environment(AppStore.self) private var store
    @Environment(\.dismiss) private var dismiss
    @State private var retrying = false

    var body: some View {
        NavigationStack {
            Group {
                if store.notes.pending.isEmpty {
                    ContentUnavailableView(
                        "Queue is clear",
                        systemImage: "checkmark.circle",
                        description: Text("Every note has reached the gateway.")
                    )
                } else {
                    List {
                        Text("These notes are stored securely on this phone until the gateway accepts them.")
                            .font(.footnote)
                            .foregroundStyle(Theme.textSecondary)
                            .listRowBackground(Theme.bgPrimary)
                            .listRowSeparator(.hidden)

                        ForEach(store.notes.pending) { note in
                            PendingNoteDiagnosticRow(note: note) {
                                Task { await store.notes.deletePending(id: note.id) }
                            }
                            .listRowBackground(Theme.bgPrimary)
                            .listRowSeparator(.visible, edges: .bottom)
                            .listRowSeparatorTint(Theme.borderLight)
                            .alignmentGuide(.listRowSeparatorLeading) { _ in 0 }
                        }
                    }
                    .listStyle(.plain)
                    .scrollContentBackground(.hidden)
                    .background(Theme.bgPrimary)
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .background(Theme.bgPrimary.ignoresSafeArea())
            .navigationTitle("Unsent notes")
            .navigationBarTitleDisplayMode(.inline)
            .toolbarBackground(Theme.bgPrimary, for: .navigationBar)
            .toolbarBackground(.visible, for: .navigationBar)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Done") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button {
                        Task { await retry() }
                    } label: {
                        if retrying {
                            ProgressView()
                        } else {
                            Text("Retry")
                        }
                    }
                    .disabled(retrying || store.notes.pending.isEmpty)
                }
            }
        }
        .presentationBackground(Theme.bgPrimary)
        .presentationDetents([.medium, .large])
        .presentationDragIndicator(.visible)
        .task { await store.notes.refreshPending() }
    }

    private func retry() async {
        retrying = true
        await store.notes.drainPending()
        retrying = false
    }
}

@available(iOS 17.0, *)
private struct PendingNoteDiagnosticRow: View {
    let note: PendingNote
    let onDiscard: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.md) {
            Text(note.text)
                .font(.system(size: 15))
                .foregroundStyle(Theme.textPrimary)
                .lineLimit(8)

            VStack(alignment: .leading, spacing: 5) {
                detail("Captured", note.capturedAt.formatted(date: .abbreviated, time: .shortened))
                detail("Surface", surfaceLabel(note.surface))
                if let diagnostics = note.deliveryDiagnostics {
                    detail("Last failure", failureLabel(diagnostics.lastFailure))
                    detail("Attempts", "\(diagnostics.attemptCount)")
                    if let attemptedAt = diagnostics.lastAttemptAt {
                        detail("Last tried", attemptedAt.formatted(date: .abbreviated, time: .shortened))
                    }
                } else {
                    detail("Delivery", "Waiting for retry; no diagnostics from this app version")
                }
                Text("Queue ID \(note.id)")
                    .font(.system(size: 10, design: .monospaced))
                    .foregroundStyle(Theme.textMuted)
                    .lineLimit(1)
                    .truncationMode(.middle)
            }

            Button(role: .destructive, action: onDiscard) {
                Label("Discard from this phone", systemImage: "trash")
                    .font(.footnote.weight(.medium))
            }
        }
        .padding(.vertical, Theme.Spacing.xs)
    }

    private func detail(_ label: String, _ value: String) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: Theme.Spacing.sm) {
            Text(label)
                .foregroundStyle(Theme.textMuted)
            Text(value)
                .foregroundStyle(Theme.textSecondary)
            Spacer(minLength: 0)
        }
        .font(.caption)
    }

    private func failureLabel(_ failure: PendingNoteDeliveryFailure) -> String {
        let reason = switch failure.kind {
        case .unpaired: "Phone is not paired"
        case .unreachable: "Gateway unreachable"
        case .featureOff: "Feature unavailable"
        case .unauthorized: "Authentication rejected"
        case .rejected: "Note rejected"
        }
        guard let code = failure.code else { return reason }
        return "\(reason) (code \(code))"
    }

    private func surfaceLabel(_ slug: String) -> String {
        switch NoteSurface(rawValue: slug) {
        case .siri: "Siri"
        case .actionButton: "Action Button"
        case .control: "Control Center"
        case .widget: "Widget"
        case .quickAction: "Quick action"
        case .watch: "Apple Watch"
        case .app: "Omnesis app"
        case .none: slug
        }
    }
}

#if DEBUG
@available(iOS 17.0, *)
struct PendingNotesPresentedPreview: View {
    private let store: AppStore
    @State private var isPresented = true

    init() {
        let store = AppStore.preview()
        store.notes.installPreviewState(pending: PreviewMocks.pendingNotes)
        self.store = store
    }

    var body: some View {
        Theme.bgSecondary
            .ignoresSafeArea()
            .sheet(isPresented: $isPresented) {
                PendingNotesDiagnosticSheet().environment(store)
            }
    }
}

@available(iOS 17.0, *)
#Preview("Unsent notes — populated flat list") {
    let store = AppStore.preview()
    store.notes.installPreviewState(pending: PreviewMocks.pendingNotes)
    return PendingNotesDiagnosticSheet().environment(store)
}

@available(iOS 17.0, *)
#Preview("Unsent notes — queue clear") {
    PendingNotesDiagnosticSheet().environment(AppStore.preview())
}

@available(iOS 17.0, *)
#Preview("Unsent notes — presented sheet") {
    PendingNotesPresentedPreview()
}
#endif
#endif
