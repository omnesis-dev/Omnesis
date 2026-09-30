// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

#if os(watchOS)
import Foundation

/// The watch's durable outbox of recorded notes (`WatchOutboxPolicy`): each
/// note is its recording, `<ref>.m4a`, beside `<ref>.json` recording its
/// metadata and delivery history. Both are flushed to disk before the note
/// counts as sent, so a note survives the app ending — by itself, or by the
/// system — and is sent again on the next launch. Not backed up.
final class WatchVoiceOutbox: @unchecked Sendable {
    static let shared = WatchVoiceOutbox()

    let directory = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        .appendingPathComponent("WatchVoiceOutbox", isDirectory: true)
    private let lock = NSLock()
    private let droppedKey = "watchVoiceOutboxDropped"

    /// Where a new recording is written, before it joins the outbox.
    func recordingURL(ref: String) throws -> URL {
        try prepareDirectory()
        return audioURL(ref)
    }

    /// Make a finished recording a waiting note: write its metadata, and
    /// flush both files to disk. Throws when either cannot be made durable;
    /// the note is then not in the outbox.
    func add(_ recording: WatchVoiceRecording, now: Date = Date()) throws {
        lock.lock()
        defer { lock.unlock() }
        let entry = WatchOutboxPolicy.Entry(metadata: recording.metadata, queuedAt: now)
        do {
            try Self.writeDurably(JSONEncoder().encode(entry), to: entryURL(recording.ref))
            try Self.flush(audioURL(recording.ref))
        } catch {
            try? FileManager.default.removeItem(at: entryURL(recording.ref))
            throw error
        }
    }

    /// The waiting notes. A recording without its metadata, or metadata
    /// without its recording, is left over from a note that never made it
    /// in, and is deleted.
    func entries() -> [WatchOutboxPolicy.Entry] {
        lock.lock()
        defer { lock.unlock() }
        let files = (try? FileManager.default.contentsOfDirectory(at: directory, includingPropertiesForKeys: nil)) ?? []
        var entries: [WatchOutboxPolicy.Entry] = []
        for ref in Set(files.map { $0.deletingPathExtension().lastPathComponent }) {
            guard FileManager.default.fileExists(atPath: audioURL(ref).path),
                  let data = try? Data(contentsOf: entryURL(ref)),
                  let entry = try? JSONDecoder().decode(WatchOutboxPolicy.Entry.self, from: data),
                  entry.ref == ref
            else {
                // A recording still being made has no metadata yet.
                if !FileManager.default.fileExists(atPath: entryURL(ref).path), isRecent(audioURL(ref)) { continue }
                removeFiles(ref)
                continue
            }
            entries.append(entry)
        }
        return entries
    }

    func audioURL(_ ref: String) -> URL {
        directory.appendingPathComponent("\(ref).\(WatchVoiceFormat.fileExtension)")
    }

    /// A transfer delivered the note: it leaves the outbox.
    func remove(_ ref: String) {
        lock.lock()
        defer { lock.unlock() }
        removeFiles(ref)
    }

    /// A transfer failed: count it, for the backoff.
    func recordFailure(_ ref: String, now: Date = Date()) {
        lock.lock()
        defer { lock.unlock() }
        guard let data = try? Data(contentsOf: entryURL(ref)),
              var entry = try? JSONDecoder().decode(WatchOutboxPolicy.Entry.self, from: data)
        else { return }
        entry.failures += 1
        entry.lastFailureAt = now
        try? Self.writeDurably(JSONEncoder().encode(entry), to: entryURL(ref))
    }

    /// Drop a note that waited too long, remembering it until the person
    /// has been told.
    func drop(_ ref: String) {
        lock.lock()
        defer { lock.unlock() }
        removeFiles(ref)
        UserDefaults.standard.set(droppedCount + 1, forKey: droppedKey)
    }

    /// Notes dropped since the person was last told.
    var droppedCount: Int {
        UserDefaults.standard.integer(forKey: droppedKey)
    }

    func acknowledgeDropped() {
        UserDefaults.standard.set(0, forKey: droppedKey)
    }

    // MARK: - Files

    private func entryURL(_ ref: String) -> URL {
        directory.appendingPathComponent("\(ref).json")
    }

    private func removeFiles(_ ref: String) {
        try? FileManager.default.removeItem(at: audioURL(ref))
        try? FileManager.default.removeItem(at: entryURL(ref))
    }

    /// Written within the longest recording's span: possibly being recorded.
    private func isRecent(_ url: URL) -> Bool {
        let modified = (try? url.resourceValues(forKeys: [.contentModificationDateKey]))?.contentModificationDate
        return modified.map { Date().timeIntervalSince($0) < WatchVoiceFormat.maxDuration + 60 } ?? false
    }

    private func prepareDirectory() throws {
        guard !FileManager.default.fileExists(atPath: directory.path) else { return }
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        var values = URLResourceValues()
        values.isExcludedFromBackup = true
        var excluded = directory
        try? excluded.setResourceValues(values)
    }

    private static func writeDurably(_ data: Data, to url: URL) throws {
        try data.write(to: url, options: .atomic)
        try flush(url)
    }

    private static func flush(_ url: URL) throws {
        let handle = try FileHandle(forUpdating: url)
        defer { try? handle.close() }
        try handle.synchronize()
    }
}
#endif
