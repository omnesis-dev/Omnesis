// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

#if canImport(SwiftUI) && canImport(UIKit)
import SwiftUI

@available(iOS 17.0, *)
extension CaptureView {
    func noteHistoryModel(pairing: Pairing?) -> NotesHistoryModel {
        #if DEBUG
        if let previewHistoryModel { return previewHistoryModel }
        #endif
        return NotesHistoryModel(
            client: pairing.map { NotesClient(baseURL: $0.url, token: $0.token) },
            tasks: pairing.map { TasksClient(baseURL: $0.url, token: $0.token) }
        )
    }
}

@available(iOS 17.0, *)
struct NotesHistoryView: View {
    @Environment(AppStore.self) private var store
    @Binding var menuOpen: Bool

    var body: some View {
        NotesHistoryScreen(
            model: NotesHistoryModel(
                client: store.pairing.map { NotesClient(baseURL: $0.url, token: $0.token) },
                tasks: store.pairing.map { TasksClient(baseURL: $0.url, token: $0.token) }
            ),
            menuOpen: $menuOpen,
            historyRevision: store.notes.historyRevision
        )
        .id(store.pairing.map { [$0.url.absoluteString, $0.pairingGeneration ?? $0.token] })
    }
}

@available(iOS 17.0, *)
struct NotesHistoryScreen: View {
    @State var model: NotesHistoryModel
    @Binding var menuOpen: Bool
    var onClose: (() -> Void)?
    var historyRevision = 0
    @Environment(\.openCapture) private var openCapture

    var body: some View {
        NavigationStack {
            Group {
                if model.entries.isEmpty, let error = model.error {
                    GatewayErrorView(context: "load notes", error: error) { Task { await model.load() } }
                } else if model.entries.isEmpty, model.loading {
                    ProgressView("Loading notes…").tint(Theme.accent)
                } else if model.entries.isEmpty {
                    emptyState
                } else {
                    history
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .background(Theme.bgPrimary.ignoresSafeArea())
            .navigationTitle("Notes")
            .navigationBarTitleDisplayMode(.inline)
            .toolbarBackground(Theme.bgPrimary, for: .navigationBar)
            .toolbarBackground(.visible, for: .navigationBar)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button { if let onClose { onClose() } else { menuOpen = true } } label: {
                        Image(systemName: onClose == nil ? "line.3.horizontal" : "xmark")
                    }
                    .accessibilityLabel(onClose == nil ? "Open menu" : "Back to capture")
                }
                if onClose == nil {
                    ToolbarItem(placement: .topBarTrailing) {
                        Button { openCapture?() } label: { Label("Tell Omnesis", systemImage: "mic.fill") }
                    }
                }
            }
            .onChange(of: historyRevision) { _, _ in
                Task { await model.refreshAfterCapture() }
            }
            .task {
                await model.load()
                while !Task.isCancelled {
                    do { try await Task.sleep(for: .seconds(5)) } catch { break }
                    await model.refreshPending()
                }
            }
        }
        .background(Theme.bgPrimary.ignoresSafeArea())
        .tint(Theme.accent)
        .omnesisColorScheme()
    }

    private var history: some View {
        ScrollView {
            LazyVStack(spacing: Theme.Spacing.md) {
                if let error = model.error {
                    Button { Task { await model.load() } } label: {
                        Label(GatewayErrorView.classify(error).title, systemImage: "exclamationmark.triangle")
                            .font(.subheadline)
                            .foregroundStyle(Theme.warning)
                            .frame(maxWidth: .infinity, alignment: .leading)
                    }
                }
                ForEach(model.entries) { note in
                    NavigationLink {
                        NoteHistoryDetail(note: note, model: model)
                    } label: {
                        NoteHistoryRow(note: note)
                    }
                    .buttonStyle(.plain)
                }
                if model.nextCursor != nil {
                    Button { Task { await model.load(more: true) } } label: {
                        HStack(spacing: 8) {
                            if model.loading { ProgressView().controlSize(.small) }
                            Text("Load older notes")
                        }
                        .font(.subheadline.weight(.medium))
                        .frame(maxWidth: .infinity, minHeight: Theme.tapTarget)
                    }
                    .disabled(model.loading)
                }
            }
            .padding(Theme.Spacing.lg)
        }
        .refreshable { await model.load() }
    }

    private var emptyState: some View {
        VStack(spacing: Theme.Spacing.md) {
            Image(systemName: "note.text")
                .font(.system(size: 30, weight: .light))
                .foregroundStyle(Theme.accent)
                .frame(width: 72, height: 72)
                .background(Theme.accent.opacity(0.08), in: RoundedRectangle(cornerRadius: 18))
            Text("Your notes will appear here")
                .font(.title3.weight(.semibold)).foregroundStyle(Theme.textPrimary)
            Text("Tell Omnesis something, then return here to see your note and what Omnesis did with it.")
                .font(.subheadline)
                .foregroundStyle(Theme.textSecondary)
                .multilineTextAlignment(.center)
                .frame(maxWidth: 310)
        }
        .padding(Theme.Spacing.xl)
    }
}

@available(iOS 17.0, *)
struct NoteHistoryDetail: View {
    @State var note: NoteEntry
    let model: NotesHistoryModel
    @Environment(\.dismiss) private var dismiss
    @State private var confirmDelete = false
    @State private var editing = false
    @State private var draft = ""
    @State private var busy = false
    @State private var error: Error?

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: Theme.Spacing.xl) {
                NoteReadingHeader(note: note)
                if editing {
                    editor
                } else {
                    Text(note.text)
                        .font(.body)
                        .lineSpacing(5)
                        .foregroundStyle(Theme.textPrimary)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .textSelection(.enabled)
                }
                NoteResponseCard(note: note, undone: model.undoneSequences, busy: busy) { seq in
                    Task { await undo(seq) }
                }
                if let error {
                    let kind = GatewayErrorView.classify(error)
                    VStack(alignment: .leading, spacing: 6) {
                        Label(kind.title, systemImage: "exclamationmark.triangle")
                            .font(.subheadline.weight(.medium)).foregroundStyle(Theme.warning)
                        Text(kind.detail(for: "update this note"))
                            .font(.footnote).foregroundStyle(Theme.textSecondary)
                    }
                }
                captureDetails
                VStack(alignment: .leading, spacing: Theme.Spacing.sm) {
                    Button("Delete note", role: .destructive) { confirmDelete = true }
                        .font(.subheadline.weight(.medium))
                        .frame(minHeight: Theme.tapTarget)
                        .disabled(busy)
                    Text("Deleting a note removes it from note history and search. Changes Omnesis already made to tasks or memory remain.")
                        .font(.caption).foregroundStyle(Theme.textSecondary)
                }
            }
            .padding(Theme.Spacing.lg)
            .padding(.bottom, Theme.Spacing.lg)
        }
        .background(Theme.bgPrimary.ignoresSafeArea())
        .tint(Theme.accent)
        .scrollDismissesKeyboard(.interactively)
        .toolbarBackground(Theme.bgPrimary, for: .navigationBar)
        .toolbarBackground(.visible, for: .navigationBar)
        .navigationTitle("Note")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button("Edit") { draft = note.text
                    editing = true
                }.disabled(busy || editing)
            }
        }
        .confirmationDialog("Delete this note?", isPresented: $confirmDelete, titleVisibility: .visible) {
            Button("Delete note", role: .destructive) { Task { await remove() } }
        } message: { Text("This cannot be undone. Existing task and memory changes remain.") }
        .refreshable { await refresh() }
        .task {
            // Receipts and gateway transcripts can arrive while this note is open.
            while !Task.isCancelled {
                await refresh()
                guard note.shouldRefreshReceipt() else { break }
                do { try await Task.sleep(for: .seconds(5)) } catch { break }
            }
        }
    }

    private var editor: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.md) {
            TextEditor(text: $draft)
                .font(.body)
                .foregroundStyle(Theme.textPrimary)
                .scrollContentBackground(.hidden)
                .frame(minHeight: 180)
                .padding(Theme.Spacing.sm)
                .background(Theme.bgSecondary, in: RoundedRectangle(cornerRadius: Theme.Radius.large))
                .overlay {
                    RoundedRectangle(cornerRadius: Theme.Radius.large).strokeBorder(Theme.accent.opacity(0.4))
                }
                .disabled(busy)
                .accessibilityIdentifier("notes.editor")
            Text("Edits update your saved note; they do not ask Omnesis to process it again.")
                .font(.footnote).foregroundStyle(Theme.textSecondary)
            if draft.utf16.count > 8192 {
                Text("Shorten this note to 8,192 characters to save.")
                    .font(.footnote).foregroundStyle(Theme.warning)
            }
            ViewThatFits(in: .horizontal) {
                HStack(spacing: Theme.Spacing.md) { editingActions }
                VStack(alignment: .leading, spacing: Theme.Spacing.sm) { editingActions }
            }
        }
    }

    @ViewBuilder
    private var editingActions: some View {
        Button("Save changes") { Task { await save() } }
            .buttonStyle(.borderedProminent)
            .tint(Theme.accent)
            .foregroundStyle(Theme.bgPrimary)
            .disabled(busy || draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || draft.utf16.count > 8192)
        Button("Cancel editing") { editing = false }
            .disabled(busy)
    }

    @ViewBuilder
    private var captureDetails: some View {
        if note.capturedTimeZoneId != nil || (note.updatedAt != note.capturedAt && note.updatedAt != note.transcribedAt) {
            VStack(alignment: .leading, spacing: Theme.Spacing.sm) {
                Text("CAPTURE DETAILS")
                    .font(.caption.weight(.semibold)).tracking(0.6).foregroundStyle(Theme.textSecondary)
                if let zone = note.capturedTimeZoneId {
                    Label(zone, systemImage: "globe")
                        .font(.caption).foregroundStyle(Theme.textSecondary)
                }
                if note.updatedAt != note.capturedAt, note.updatedAt != note.transcribedAt {
                    Text("Edited " + (NotesTime.date(fromISO: note.updatedAt)?.formatted() ?? note.updatedAt))
                        .font(.caption).foregroundStyle(Theme.textSecondary)
                }
            }
        }
    }

    #if DEBUG
    static func editingPreview(note: NoteEntry, busy: Bool = false) -> Self {
        var view = Self(note: note, model: NotesHistoryModel(client: nil))
        view._editing = State(initialValue: true)
        view._draft = State(initialValue: note.text)
        view._busy = State(initialValue: busy)
        return view
    }
    #endif

    private func refresh() async {
        guard !editing, !busy else { return }
        do {
            if let updated = try await model.refresh(note) {
                guard !editing, !busy else { return }
                note = updated
                error = nil
            } else { dismiss() }
        } catch { if !Task.isCancelled { self.error = error } }
    }

    private func undo(_ seq: Int) async {
        guard !busy else { return }
        busy = true
        defer { busy = false }
        do { try await model.undo(seq: seq)
            error = nil
        } catch { self.error = error }
    }

    private func save() async {
        guard !busy else { return }
        busy = true
        defer { busy = false }
        do { note = try await model.edit(note, text: draft)
            editing = false
            error = nil
        } catch GatewayClient.Error.notFound {
            dismiss()
        } catch { self.error = error }
    }

    private func remove() async {
        guard !busy else { return }
        busy = true
        defer { busy = false }
        do { try await model.remove(note)
            dismiss()
        } catch { self.error = error }
    }
}

extension NoteEntry {
    var capturedLabel: String {
        NotesTime.date(fromISO: capturedAt)?.formatted(date: .abbreviated, time: .shortened) ?? capturedAt
    }

    var statusLabel: String {
        transcription == "pending" ? "Transcribing voice note" : agent?.statusLabel ?? "Saved"
    }
}

#if DEBUG
#Preview("Notes") {
    NotesHistoryScreen(model: NotesHistoryModel(client: nil, entries: PreviewMocks.noteHistory), menuOpen: .constant(false))
}

#Preview("No notes") {
    NotesHistoryScreen(model: NotesHistoryModel(client: nil), menuOpen: .constant(false))
}

#Preview("Note response") {
    NavigationStack {
        NoteHistoryDetail(note: PreviewMocks.noteHistory[0], model: NotesHistoryModel(client: nil))
    }
}

#Preview("Editing note") {
    NavigationStack {
        NoteHistoryDetail.editingPreview(note: PreviewMocks.noteHistory[0])
    }
}

#Preview("Saving note edits") {
    NavigationStack {
        NoteHistoryDetail.editingPreview(note: PreviewMocks.noteHistory[0], busy: true)
    }
}

#Preview("Loading notes") {
    NotesHistoryScreen(model: NotesHistoryModel(client: nil, loading: true), menuOpen: .constant(false))
}

#Preview("Notes error") {
    NotesHistoryScreen(
        model: NotesHistoryModel(client: nil, error: URLError(.notConnectedToInternet)),
        menuOpen: .constant(false)
    )
    .environment(AppStore.preview())
}

#Preview("Long note, large text") {
    NavigationStack {
        NoteHistoryDetail(note: PreviewMocks.longHistoryNote, model: NotesHistoryModel(client: nil))
    }
    .dynamicTypeSize(.accessibility3)
}

#Preview("Notes section") {
    NotesHistoryView(menuOpen: .constant(false)).environment(AppStore.preview())
}
#endif
#endif
