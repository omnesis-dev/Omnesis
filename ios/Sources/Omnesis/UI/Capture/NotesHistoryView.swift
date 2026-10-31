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
                    ProgressView("Loading notes…")
                } else if model.entries.isEmpty {
                    ContentUnavailableView(
                        "Your notes will appear here",
                        systemImage: "note.text",
                        description: Text("Tell Omnesis something, then return here to see your note and what Omnesis did with it.")
                    )
                } else {
                    List {
                        if let error = model.error {
                            Button { Task { await model.load() } } label: {
                                Label(GatewayErrorView.classify(error).title, systemImage: "exclamationmark.triangle")
                            }
                        }
                        ForEach(model.entries) { note in
                            NavigationLink {
                                NoteHistoryDetail(note: note, model: model)
                            } label: {
                                VStack(alignment: .leading, spacing: 8) {
                                    Text(note.text).font(.body).lineLimit(3)
                                    Text(note.capturedLabel).font(.caption).foregroundStyle(.secondary)
                                    Label(note.statusLabel, systemImage: note.transcription == "pending" ? "waveform" : "sparkles")
                                        .font(.caption).foregroundStyle(.secondary)
                                    if let reply = note.agent?.receipt?.text, !reply.isEmpty {
                                        Text(reply).font(.subheadline).foregroundStyle(.secondary).lineLimit(2)
                                    }
                                }.padding(.vertical, 6)
                            }
                        }
                        if model.nextCursor != nil {
                            Button("Load older notes") { Task { await model.load(more: true) } }
                                .disabled(model.loading)
                        }
                    }.refreshable { await model.load() }
                }
            }
            .navigationTitle("Notes")
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
        }.tint(Theme.accent).omnesisColorScheme()
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
        List {
            Section("Your note") {
                if editing {
                    TextEditor(text: $draft)
                        .frame(minHeight: 180)
                        .disabled(busy)
                        .accessibilityIdentifier("notes.editor")
                    Text("Edits update your saved note; they do not ask Omnesis to process it again.").font(.footnote)
                        .foregroundStyle(.secondary)
                    if draft.utf16.count > 8192 {
                        Text("Shorten this note to 8,192 characters to save.").font(.footnote).foregroundStyle(Theme.warning)
                    }
                    Button("Save changes") { Task { await save() } }
                        .disabled(busy || draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || draft.utf16.count > 8192)
                    Button("Cancel editing") { editing = false }
                        .disabled(busy)
                } else { Text(note.text).textSelection(.enabled) }
            }
            Section("Omnesis") {
                Label(note.statusLabel, systemImage: "sparkles")
                if let receipt = note.agent?.receipt {
                    Text(receipt.text).textSelection(.enabled)
                    ForEach(Array(receipt.changes.enumerated()), id: \.offset) { _, change in
                        VStack(alignment: .leading, spacing: 8) {
                            Label(change.text, systemImage: "checkmark.circle")
                            if let seq = change.undoSeq {
                                Button(model.undoneSequences.contains(seq) ? "Undone" : "Undo change") {
                                    Task { await undo(seq) }
                                }.disabled(busy || model.undoneSequences.contains(seq))
                            }
                        }
                    }
                } else if note.agent == nil {
                    Text("No agent response is recorded for this note.").foregroundStyle(.secondary)
                }
            }
            Section("Captured") {
                LabeledContent("When", value: note.capturedLabel)
                if let surface = note.surfaceLabel { LabeledContent("From", value: surface) }
                if let place = note.placeName { LabeledContent("Place", value: place) }
                if let zone = note.capturedTimeZoneId { LabeledContent("Time zone", value: zone) }
                if note.updatedAt != note.capturedAt, note.updatedAt != note.transcribedAt { LabeledContent(
                    "Edited",
                    value: NotesTime.date(fromISO: note.updatedAt)?.formatted() ?? note.updatedAt
                ) }
            }
            if let error {
                Section {
                    let kind = GatewayErrorView.classify(error)
                    Label(kind.title, systemImage: "exclamationmark.triangle")
                    Text(kind.detail(for: "update this note")).font(.footnote).foregroundStyle(.secondary)
                }
            }
            Section {
                Button("Delete note", role: .destructive) { confirmDelete = true }.disabled(busy)
            } footer: {
                Text("Deleting a note removes it from note history and search. Changes Omnesis already made to tasks or memory remain.")
            }
        }
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
    fileprivate var capturedLabel: String {
        NotesTime.date(fromISO: capturedAt)?.formatted(date: .abbreviated, time: .shortened) ?? capturedAt
    }

    fileprivate var statusLabel: String {
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
