// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation

/// Sanitized reason the most recent gateway delivery did not complete.
/// Only a coarse category and numeric status/error code are persisted:
/// response bodies and endpoint details can contain private data and do
/// not belong in an on-device diagnostic surface.
public struct PendingNoteDeliveryFailure: Codable, Equatable, Sendable {
    public enum Kind: String, Codable, Equatable, Sendable {
        case unpaired
        case unreachable
        case featureOff
        case unauthorized
        case rejected
    }

    public let kind: Kind
    /// HTTP status or `URLError.Code.rawValue`, when one is available.
    public let code: Int?

    public init(kind: Kind, code: Int? = nil) {
        self.kind = kind
        self.code = code
    }
}

/// Delivery history kept with a queued note. Optional on `PendingNote`
/// so files written by older app builds remain valid.
public struct PendingNoteDeliveryDiagnostics: Codable, Equatable, Sendable {
    public let attemptCount: Int
    public let lastAttemptAt: Date?
    public let lastFailure: PendingNoteDeliveryFailure
    /// True once a delivery pass after enqueueing has failed. This is
    /// distinct from `attemptCount`: an unpaired capture has no initial
    /// HTTP attempt, but its first later drain is still a redelivery.
    public let redeliveryFailed: Bool

    public init(
        attemptCount: Int,
        lastAttemptAt: Date?,
        lastFailure: PendingNoteDeliveryFailure,
        redeliveryFailed: Bool = false
    ) {
        self.attemptCount = attemptCount
        self.lastAttemptAt = lastAttemptAt
        self.lastFailure = lastFailure
        self.redeliveryFailed = redeliveryFailed
    }
}

/// One quick-capture note waiting to be delivered to the gateway.
/// Carries the original capture time so a note drained hours (or days)
/// later still lands in the day it was actually spoken.
public struct PendingNote: Codable, Equatable, Sendable, Identifiable {
    public let id: String
    /// Client-generated UUID sent as the `id` on `POST /notes` — the
    /// idempotency key that makes drain retries safe (same key → same
    /// server entry, never a duplicate). Optional so queue files written
    /// before the key existed still decode; those drain without one.
    public let noteId: String?
    public let text: String
    public let capturedAt: Date
    public let capturedTimeZoneId: String?
    public let capturedUtcOffsetSeconds: Int?
    /// Capture surface slug (`NoteSurface.rawValue`).
    public let surface: String
    /// Where the note was captured, snapshotted at capture time so a
    /// drain hours later still lands the true place. Optional so queue
    /// files written before location existed (and fix-less captures)
    /// decode with no location.
    public let location: NoteLocation?
    /// Delivery diagnostics were added after the original queue format;
    /// nil means the file came from an older build with no attempt data.
    public let deliveryDiagnostics: PendingNoteDeliveryDiagnostics?

    public init(
        id: String = PendingNote.makeId(),
        noteId: String? = UUID().uuidString.lowercased(),
        text: String,
        capturedAt: Date = Date(),
        capturedTimeZoneId: String? = nil,
        capturedUtcOffsetSeconds: Int? = nil,
        surface: String,
        location: NoteLocation? = nil,
        deliveryDiagnostics: PendingNoteDeliveryDiagnostics? = nil
    ) {
        self.id = id
        self.noteId = noteId
        self.text = text
        self.capturedAt = capturedAt
        self.capturedTimeZoneId = capturedTimeZoneId
        self.capturedUtcOffsetSeconds = capturedUtcOffsetSeconds
        self.surface = surface
        self.location = location
        self.deliveryDiagnostics = deliveryDiagnostics
    }

    /// Five minutes avoids alarming on a normal short connectivity flap.
    /// A failed redelivery warns immediately because the queue has already
    /// had its ordinary second chance.
    public static let warningAgeSeconds: TimeInterval = 300 // PARITY:tell-omnesis-pending-warning-ms

    public func warrantsDeliveryWarning(
        now: Date = Date(),
        warningAge: TimeInterval = PendingNote.warningAgeSeconds
    )
        -> Bool {
        if deliveryDiagnostics?.redeliveryFailed == true { return true }
        return now.timeIntervalSince(capturedAt) >= warningAge
    }

    fileprivate func recordingDeliveryDiagnostics(
        _ diagnostics: PendingNoteDeliveryDiagnostics
    )
        -> PendingNote {
        PendingNote(
            id: id,
            noteId: noteId,
            text: text,
            capturedAt: capturedAt,
            capturedTimeZoneId: capturedTimeZoneId,
            capturedUtcOffsetSeconds: capturedUtcOffsetSeconds,
            surface: surface,
            location: location,
            deliveryDiagnostics: diagnostics
        )
    }

    fileprivate func diagnosticsAfterFailedRedelivery(
        _ failure: PendingNoteDeliveryFailure,
        at attemptedAt: Date
    )
        -> PendingNoteDeliveryDiagnostics {
        PendingNoteDeliveryDiagnostics(
            attemptCount: (deliveryDiagnostics?.attemptCount ?? 0) + 1,
            lastAttemptAt: attemptedAt,
            lastFailure: failure,
            redeliveryFailed: true
        )
    }

    /// Timestamp-prefixed id so filenames sort lexicographically in
    /// creation order (same scheme as `Batch.makeId`).
    public static func makeId(now: Date = Date()) -> String {
        let formatter = DateFormatter()
        formatter.dateFormat = "yyyyMMdd'T'HHmmssSSS"
        formatter.timeZone = TimeZone(identifier: "UTC")
        formatter.locale = Locale(identifier: "en_US_POSIX")
        let stamp = formatter.string(from: now)
        let suffix = String(UUID().uuidString.prefix(8)).lowercased()
        return "\(stamp)-\(suffix)"
    }
}

/// Durable FIFO queue of notes captured while the gateway was
/// unreachable (or rejected the write). One JSON file per note under
/// `Application Support/Omnesis/pending-notes/`, protected with the
/// `ProtectedStore.pendingNotes` class. A small `.delivery-state`
/// sidecar records retry failures without rewriting the note payload.
///
/// Unlike `OfflineBuffer`, disk is re-read on every operation instead
/// of being cached in actor state: the Siri capture intent enqueues
/// from its own store instance in the same process while the
/// coordinator holds another, and the queue is small enough (a handful
/// of tiny files) that a directory scan per operation is free. That
/// makes any two instances over the same directory automatically
/// consistent.
///
/// Deliberately NOT wiped on re-pair: queued notes are user-authored
/// content with no upstream source of truth, and they deliver
/// perfectly well to whichever gateway the device pairs with next.
public actor PendingNoteStore {
    private let directory: URL
    private let fileManager: FileManager
    private let encoder: JSONEncoder
    private let decoder: JSONDecoder

    /// `~/Library/Application Support/Omnesis/pending-notes/`.
    public static func defaultDirectory() -> URL {
        let root = (try? FileManager.default.url(
            for: .applicationSupportDirectory,
            in: .userDomainMask,
            appropriateFor: nil,
            create: true
        )) ?? URL(fileURLWithPath: NSTemporaryDirectory())
        return root.appendingPathComponent("Omnesis/pending-notes", isDirectory: true)
    }

    public init(directory: URL = PendingNoteStore.defaultDirectory(), fileManager: FileManager = .default) {
        self.directory = directory
        self.fileManager = fileManager
        let enc = JSONEncoder()
        enc.dateEncodingStrategy = .iso8601
        self.encoder = enc
        let dec = JSONDecoder()
        dec.dateDecodingStrategy = .iso8601
        self.decoder = dec
        try? fileManager.createDirectory(at: directory, withIntermediateDirectories: true)
        ProtectedStore.pendingNotes.applyProtection(toContentsOf: directory, fileManager: fileManager)
        ProtectedStore.pendingNotes.applyBackupExclusion(to: directory, fileManager: fileManager)
    }

    /// Persist a note. Throws on write failure so the caller can tell
    /// the user their note was NOT kept (silent loss is the one
    /// unacceptable outcome for this store).
    public func enqueue(_ note: PendingNote) throws {
        try ProtectedStore.pendingNotes.requireBackupExclusion(
            to: directory, fileManager: fileManager
        )
        let data = try encoder.encode(note)
        try data.write(to: fileURL(for: note.id), options: ProtectedStore.pendingNotes.writingOptions)
    }

    /// All queued notes, oldest first. Unreadable/corrupt files are
    /// skipped (a locked-device read of a sealed file is routine — the
    /// note reappears on the next unlocked list).
    public func list() -> [PendingNote] {
        noteURLs().compactMap { url in
            guard let data = try? Data(contentsOf: url) else { return nil }
            guard let note = try? decoder.decode(PendingNote.self, from: data) else { return nil }
            guard let stateData = try? Data(contentsOf: diagnosticsURL(for: note.id)),
                  let diagnostics = try? decoder.decode(PendingNoteDeliveryDiagnostics.self, from: stateData) else {
                return note
            }
            return note.recordingDeliveryDiagnostics(diagnostics)
        }
    }

    public func count() -> Int {
        noteURLs().count
    }

    /// Delete a delivered (or user-discarded) note. Missing file is a
    /// no-op — another instance may have drained it already.
    public func remove(id: String) throws {
        let url = fileURL(for: id)
        if fileManager.fileExists(atPath: url.path) {
            try fileManager.removeItem(at: url)
        }
        let diagnostics = diagnosticsURL(for: id)
        if fileManager.fileExists(atPath: diagnostics.path) {
            try fileManager.removeItem(at: diagnostics)
        }
    }

    /// Record a failed drain attempt without rewriting the queued note.
    /// A separate sidecar means a concurrent removal can at worst leave
    /// ignorable diagnostic metadata; it can never resurrect user content
    /// or put a delivered note back in the queue.
    public func recordFailedRedelivery(
        id: String,
        failure: PendingNoteDeliveryFailure,
        attemptedAt: Date = Date()
    ) throws {
        let url = fileURL(for: id)
        guard fileManager.fileExists(atPath: url.path) else { return }
        let data = try Data(contentsOf: url)
        var note = try decoder.decode(PendingNote.self, from: data)
        if let stateData = try? Data(contentsOf: diagnosticsURL(for: id)),
           let diagnostics = try? decoder.decode(PendingNoteDeliveryDiagnostics.self, from: stateData) {
            note = note.recordingDeliveryDiagnostics(diagnostics)
        }
        let diagnostics = note.diagnosticsAfterFailedRedelivery(failure, at: attemptedAt)
        try ProtectedStore.pendingNotes.requireBackupExclusion(
            to: directory, fileManager: fileManager
        )
        try encoder.encode(diagnostics).write(
            to: diagnosticsURL(for: id),
            options: ProtectedStore.pendingNotes.writingOptions
        )
    }

    /// Drop every queued note. Called on unpair, where the rest of the
    /// on-device Omnesis state is torn down too.
    public func removeAll() {
        for url in noteURLs() {
            try? fileManager.removeItem(at: url)
        }
        let contents = (try? fileManager.contentsOfDirectory(
            at: directory, includingPropertiesForKeys: nil
        )) ?? []
        for url in contents where url.pathExtension == "delivery-state" {
            try? fileManager.removeItem(at: url)
        }
    }

    // MARK: - Internals

    private func fileURL(for id: String) -> URL {
        directory.appendingPathComponent("\(id).json")
    }

    private func diagnosticsURL(for id: String) -> URL {
        directory.appendingPathComponent("\(id).delivery-state")
    }

    private func noteURLs() -> [URL] {
        let contents = (try? fileManager.contentsOfDirectory(
            at: directory, includingPropertiesForKeys: nil
        )) ?? []
        return contents
            .filter { $0.pathExtension == "json" }
            .sorted { $0.lastPathComponent < $1.lastPathComponent }
    }
}
