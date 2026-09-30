// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation

/// Where the iPhone keeps a watch recording from the moment it arrives until
/// it has been handed to the note pipeline.
///
/// WatchConnectivity deletes a received file as soon as its delegate call
/// returns, and the work that follows — an on-device transcription, then the
/// save — can outlast the background time the delivery was granted. So each
/// recording is moved here first, beside a small state file recording its
/// metadata and progress; one still here when iOS ended the process is
/// picked up at the next launch, from where it got to.
///
/// Every item has one owner in the process: whoever admitted it, or the
/// launch scan that claimed it. Only the owner updates or discards it, so a
/// recording arriving while the scan runs is never handled twice. Nothing
/// here is backed up.
final class WatchVoiceInbox: @unchecked Sendable {
    let directory: URL
    private let lock = NSLock()
    private var owned: Set<String> = []

    /// Metadata and progress of one recording, persisted beside it.
    struct State: Codable, Equatable, Sendable {
        var metadata: [String: String]
        /// How many times processing has started. An item that keeps ending
        /// the process before it finishes is given up rather than retried
        /// forever.
        var attempts = 0
        /// The phone's transcript, once attempted — empty when it heard
        /// nothing — so a later attempt goes straight to saving the note.
        var transcript: String?
    }

    /// One recording held in the inbox, owned by whoever received it.
    struct Item: Sendable {
        let id: String
        var state: State
    }

    init(directory: URL = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        .appendingPathComponent("WatchVoiceInbox", isDirectory: true)) {
        self.directory = directory
    }

    func audioURL(_ id: String) -> URL {
        directory.appendingPathComponent("\(id).\(WatchVoiceFormat.fileExtension)")
    }

    private func stateURL(_ id: String) -> URL {
        directory.appendingPathComponent("\(id).json")
    }

    /// Move a just-received recording in, owned by the caller. Nil when it
    /// could not be kept, in which case there is nothing to process.
    func admit(file: URL, metadata: [String: Any]) -> Item? {
        let id = UUID().uuidString
        let item = Item(id: id, state: State(metadata: metadata.compactMapValues { $0 as? String }))
        lock.lock()
        owned.insert(id)
        lock.unlock()
        do {
            try prepareDirectory()
            try FileManager.default.moveItem(at: file, to: audioURL(id))
            try save(item)
        } catch {
            discard(item)
            return nil
        }
        return item
    }

    /// Claim the recordings a previous process left behind. An item already
    /// owned in this process is skipped; a state file without its recording,
    /// or a recording without its state file, is deleted.
    func claimLeftovers() -> [Item] {
        let files = (try? FileManager.default.contentsOfDirectory(at: directory, includingPropertiesForKeys: nil)) ?? []
        let ids = Set(files.map { $0.deletingPathExtension().lastPathComponent })
        var claimed: [Item] = []
        for id in ids.sorted() {
            lock.lock()
            let free = !owned.contains(id)
            if free { owned.insert(id) }
            lock.unlock()
            guard free else { continue }
            let audioExists = FileManager.default.fileExists(atPath: audioURL(id).path)
            guard audioExists,
                  let data = try? Data(contentsOf: stateURL(id)),
                  let state = try? JSONDecoder().decode(State.self, from: data)
            else {
                discard(Item(id: id, state: State(metadata: [:])))
                continue
            }
            claimed.append(Item(id: id, state: state))
        }
        return claimed
    }

    /// Persist an owned item's progress.
    func save(_ item: Item) throws {
        try JSONEncoder().encode(item.state).write(to: stateURL(item.id), options: .atomic)
    }

    /// Delete an owned item and give up its ownership.
    func discard(_ item: Item) {
        try? FileManager.default.removeItem(at: audioURL(item.id))
        try? FileManager.default.removeItem(at: stateURL(item.id))
        lock.lock()
        owned.remove(item.id)
        lock.unlock()
    }

    private func prepareDirectory() throws {
        guard !FileManager.default.fileExists(atPath: directory.path) else { return }
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        var values = URLResourceValues()
        values.isExcludedFromBackup = true
        var excluded = directory
        try? excluded.setResourceValues(values)
    }
}

/// What the iPhone tells the person about a watch relay that came to nothing.
/// Never silent: the watch said it was sent.
enum WatchRelayNotice: Equatable, Sendable {
    /// A recorded note could not be saved.
    case voiceNoteFailed
    /// A queued question arrived too late to be worth asking.
    case questionExpired
}

/// What the iPhone does with a note the watch recorded for gateway
/// dictation: transcribe it on the device for the text shown at once, then
/// save it as a voice note — the gateway transcribes the recording and
/// replaces that text when it is ready, or the note goes as text when the
/// gateway does not take voice notes. Nothing waits on the gateway here.
/// Every dependency is injected, so the logic lane drives the whole path
/// with fakes.
struct WatchVoicePipeline: Sendable {
    enum DropReason: Equatable {
        /// Not a watch recording, or missing what the note needs.
        case malformed
        /// Already saved from another copy of the same recording.
        case duplicate
        /// Processing started too many times without finishing.
        case exhausted
    }

    enum Outcome: Equatable {
        /// Handed to the note pipeline, with the phone's transcript (empty
        /// when the phone heard nothing).
        case saved(text: String)
        /// The note pipeline could not keep it. The person was told.
        case failed
        case dropped(DropReason)
    }

    /// Processing attempts before an item is given up.
    static let maxAttempts = 3

    /// On-device transcription of a recording file, nil when it produced
    /// nothing.
    let transcribeOnDevice: @Sendable (_ audio: URL, _ locale: String?) async -> String?
    /// Save a voice note, taking the recording. `id` is the recording's ref,
    /// the note's idempotency key, so a note saved just before the process
    /// ended is not saved twice. False when it could not be kept.
    let saveVoiceNote: @Sendable (
        _ text: String,
        _ captureTime: NoteCaptureTime,
        _ id: String,
        _ audio: NoteAudio
    ) async
        -> Bool
    let notify: @Sendable (WatchRelayNotice) async -> Void
    /// Record a ref as handled; false when it already was.
    let claim: @Sendable (_ ref: String) -> Bool

    /// Act on one owned inbox item, then discard it.
    func handle(_ owned: WatchVoiceInbox.Item, inbox: WatchVoiceInbox) async -> Outcome {
        var item = owned
        defer { inbox.discard(item) }
        guard let recording = WatchVoiceRecording(metadata: item.state.metadata) else { return .dropped(.malformed) }
        item.state.attempts += 1
        guard item.state.attempts <= Self.maxAttempts else {
            await notify(.voiceNoteFailed)
            return .dropped(.exhausted)
        }
        try? inbox.save(item)
        guard claim(recording.ref) else { return .dropped(.duplicate) }
        let audio = inbox.audioURL(item.id)
        if item.state.transcript == nil {
            let heard = await transcribeOnDevice(audio, recording.locale)?
                .trimmingCharacters(in: .whitespacesAndNewlines)
            item.state.transcript = heard ?? ""
            try? inbox.save(item)
        }
        let text = item.state.transcript ?? ""
        let saved = await saveVoiceNote(
            text,
            recording.captureTime,
            recording.ref,
            NoteAudio(file: audio, locale: recording.locale)
        )
        guard saved else {
            await notify(.voiceNoteFailed)
            return .failed
        }
        return .saved(text: text)
    }
}

/// What the iPhone does with a relay the watch queued after its live sends
/// failed: a note is saved, a question handed to the gateway, and a question
/// too old to ask is reported rather than dropped in silence.
struct WatchQueuedRelayHandler: Sendable {
    /// Routes a payload and records its ref as handled.
    let route: @Sendable (_ payload: [String: Any]) -> WatchRelayInbox.Action
    /// Save a note; `id` is its relay ref, when it has one, as the note's
    /// idempotency key.
    let saveNote: @Sendable (_ text: String, _ captureTime: NoteCaptureTime, _ id: String?) async -> Void
    let ask: @Sendable (_ question: String) async -> Void
    let notify: @Sendable (WatchRelayNotice) async -> Void

    @discardableResult
    func handle(_ payload: [String: Any]) async -> WatchRelayInbox.Action {
        let action = route(payload)
        switch action {
        case .saveNote(let text, let captureTime):
            await saveNote(text, captureTime, WatchNoteWire.ref(from: payload))
        case .ask(let question):
            await ask(question)
        case .drop(.expired):
            await notify(.questionExpired)
        case .drop:
            break
        }
        return action
    }
}
