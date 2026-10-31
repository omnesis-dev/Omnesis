// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation
import Observation

@available(iOS 17.0, macOS 14.0, *)
@MainActor @Observable
final class NotesHistoryModel {
    private(set) var entries: [NoteEntry] = []
    private(set) var loading = false
    private(set) var nextCursor: String?
    var error: Error?
    private(set) var undoneSequences: Set<Int> = []
    private let tasks: TasksClient?
    private let client: NotesClient?
    private var generation = 0
    private var loadWaiters: [CheckedContinuation<Void, Never>] = []

    init(client: NotesClient?, entries: [NoteEntry] = [], tasks: TasksClient? = nil, loading: Bool = false, error: Error? = nil) {
        self.client = client
        self.tasks = tasks
        self.entries = entries
        self.loading = loading
        self.error = error
    }

    func load(more: Bool = false, preserveOlder: Bool = false) async {
        guard let client, !loading else { return }
        loading = true
        error = nil
        generation += 1
        let request = generation
        defer {
            loading = false
            let waiters = loadWaiters
            loadWaiters.removeAll()
            waiters.forEach { $0.resume() }
        }
        do {
            let page = try await client.history(cursor: more ? nextCursor : nil)
            guard request == generation else { return }
            entries = more || preserveOlder ? merge(page.entries, retaining: entries) : page.entries
            nextCursor = page.pageInfo.hasMore ? page.pageInfo.nextCursor : nil
        } catch { if request == generation, !Task.isCancelled { self.error = error } }
    }

    /// The gateway history order is capture time descending, then id ascending.
    /// New pages replace cached versions of an entry while keeping that order.
    private func merge(_ fresh: [NoteEntry], retaining cached: [NoteEntry]) -> [NoteEntry] {
        var byId = Dictionary(cached.map { ($0.id, $0) }, uniquingKeysWith: { _, latest in latest })
        for entry in fresh {
            byId[entry.id] = entry
        }
        return byId.values.sorted {
            $0.capturedAt == $1.capturedAt ? $0.id < $1.id : $0.capturedAt > $1.capturedAt
        }
    }

    /// A capture can complete while the initial page is still in flight.
    /// Wait for that read before fetching the new head, retaining older pages.
    func refreshAfterCapture() async {
        if loading { await withCheckedContinuation { loadWaiters.append($0) } }
        guard !Task.isCancelled else { return }
        await load(preserveOlder: true)
    }

    func refreshPending() async {
        let days = Set(entries.filter { $0.shouldRefreshReceipt() }.map(\.day))
        guard let client, !loading else { return }
        let request = generation
        for day in days {
            do {
                let fresh = try await client.dayEntries(day: day)
                guard request == generation else { return }
                let byId = Dictionary(uniqueKeysWithValues: fresh.map { ($0.id, $0) })
                entries = entries.compactMap { $0.day == day ? byId[$0.id] : $0 }
                error = nil
            } catch { if request == generation, !Task.isCancelled { self.error = error } }
        }
    }

    func refresh(_ note: NoteEntry) async throws -> NoteEntry? {
        guard let client else { return note }
        let request = generation
        let updated = try await client.dayEntries(day: note.day).first { $0.id == note.id }
        guard request == generation else { return entries.first { $0.id == note.id } }
        if let updated, let index = entries.firstIndex(where: { $0.id == note.id }) { entries[index] = updated }
        if updated == nil { entries.removeAll { $0.id == note.id } }
        return updated
    }

    func edit(_ note: NoteEntry, text: String) async throws -> NoteEntry {
        guard let client else { throw GatewayClient.Error.unauthorized }
        generation += 1
        let saved: NoteEntry
        do {
            saved = try await client.editNote(id: note.id, text: text)
        } catch GatewayClient.Error.notFound {
            entries.removeAll { $0.id == note.id }
            throw GatewayClient.Error.notFound
        }
        generation += 1
        let enriched = NoteEntry(
            id: saved.id,
            day: saved.day,
            capturedAt: saved.capturedAt,
            updatedAt: saved.updatedAt,
            capturedTimeZoneId: saved.capturedTimeZoneId,
            capturedUtcOffsetSeconds: saved.capturedUtcOffsetSeconds,
            receivedAt: saved.receivedAt,
            text: saved.text,
            surface: saved.surface,
            deviceId: saved.deviceId,
            latitude: saved.latitude,
            longitude: saved.longitude,
            placeName: saved.placeName,
            transcribedAt: saved.transcribedAt,
            agent: note.agent
        )
        if let index = entries.firstIndex(where: { $0.id == saved.id }) { entries[index] = enriched }
        return enriched
    }

    func undo(seq: Int) async throws {
        guard let tasks else { throw GatewayClient.Error.unauthorized }
        do {
            _ = try await tasks.undo(seq: seq)
        } catch GatewayClient.Error.serverError(let status, _) where status == 409 {
            throw NoteUndoError.laterChange
        } catch GatewayClient.Error.notFound { throw NoteUndoError.taskRemoved }
        undoneSequences.insert(seq)
    }

    func remove(_ note: NoteEntry) async throws {
        guard let client else { throw GatewayClient.Error.unauthorized }
        generation += 1
        do {
            try await client.deleteNote(id: note.id)
        } catch GatewayClient.Error.notFound { /* Already deleted on another device. */ }
        generation += 1
        entries.removeAll { $0.id == note.id }
    }
}

/// Actionable failures of reversing a task change made from a note.
enum NoteUndoError: LocalizedError {
    case laterChange, taskRemoved

    var errorDescription: String? {
        switch self {
        case .laterChange: "A later change to this task has to be undone first."
        case .taskRemoved: "This task no longer exists, so its change cannot be undone."
        }
    }
}
