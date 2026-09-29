// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation

/// Where the iPhone keeps a watch recording from the moment it arrives until
/// it has been turned into a note or a question.
///
/// WatchConnectivity deletes a received file as soon as its delegate call
/// returns, and the work that follows — a gateway transcription, then a save
/// or an ask — can outlast the background time the delivery was granted. So
/// each recording is moved here first, beside a small state file recording
/// its metadata and progress; one still here when iOS ended the process is
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
        /// The text, once transcribed. The recording is deleted at that
        /// point, so a later attempt goes straight to acting on it.
        var transcript: String?
        var transcribedOnDevice = false
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
    /// owned in this process is skipped; a state file without a recording
    /// and without a transcript, or a recording without a state file, is
    /// deleted.
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
            guard let data = try? Data(contentsOf: stateURL(id)),
                  let state = try? JSONDecoder().decode(State.self, from: data),
                  audioExists || state.transcript != nil
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

    /// Delete an owned item's recording, keeping its state.
    func removeAudio(_ item: Item) {
        try? FileManager.default.removeItem(at: audioURL(item.id))
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

/// What the iPhone tells the person about a watch recording it could not
/// turn into a note or a question. Never silent: the watch said "Sent".
enum WatchVoiceNotice: Equatable, Sendable {
    /// Neither transcriber produced text.
    case untranscribed(WatchVoiceKind)
    /// The question arrived too late to be worth asking.
    case questionExpired
}

/// What the iPhone does with a recording the watch sent for gateway
/// dictation: transcribe it — with the gateway, or on the device when the
/// gateway cannot — and hand the text to the note or ask pipeline a dictated
/// relay goes through. Every dependency is injected, so the logic lane drives
/// the whole path with fakes.
struct WatchVoicePipeline: Sendable {
    enum Transcriber: Equatable {
        case gateway
        case onDevice
    }

    enum DropReason: Equatable {
        /// Not a watch recording, or missing what the pipelines need.
        case malformed
        /// Already acted on from another copy of the same recording.
        case duplicate
        /// A question older than `WatchRelayQueue.askExpiry`.
        case expired
        /// Processing started too many times without finishing.
        case exhausted
    }

    enum Outcome: Equatable {
        case savedNote(text: String, by: Transcriber)
        case asked(question: String, by: Transcriber)
        /// Neither transcriber produced text. The person was told; nothing
        /// was kept.
        case untranscribed(WatchVoiceKind)
        case dropped(DropReason)
    }

    /// Processing attempts before an item is given up.
    static let maxAttempts = 3

    /// The gateway to transcribe with, or nil when gateway dictation is off
    /// or the phone is not paired.
    let gatewayRoute: @Sendable () async -> GatewayDictationRoute?
    /// On-device transcription of a recording file, nil when it produced
    /// nothing.
    let transcribeOnDevice: @Sendable (_ audio: URL, _ locale: String?) async -> String?
    /// Save a note. `id` is the recording's ref, the note's idempotency key,
    /// so a note saved just before the process ended is not saved twice.
    let saveNote: @Sendable (_ text: String, _ captureTime: NoteCaptureTime, _ id: String) async -> Void
    let ask: @Sendable (_ question: String) async -> Void
    let notify: @Sendable (WatchVoiceNotice) async -> Void
    /// Record a ref as handled; false when it already was.
    let claim: @Sendable (_ ref: String) -> Bool
    let now: @Sendable () -> Date

    /// Act on one owned inbox item, then discard it.
    func handle(_ owned: WatchVoiceInbox.Item, inbox: WatchVoiceInbox) async -> Outcome {
        var item = owned
        defer { inbox.discard(item) }
        guard let recording = WatchVoiceRecording(metadata: item.state.metadata) else { return .dropped(.malformed) }
        item.state.attempts += 1
        guard item.state.attempts <= Self.maxAttempts else {
            await notify(.untranscribed(recording.kind))
            return .dropped(.exhausted)
        }
        try? inbox.save(item)
        // A question answered long after it was asked arrives as a
        // notification about something the person has moved on from — the
        // same limit a queued question has.
        if recording.kind == .ask,
           now().timeIntervalSince(recording.captureTime.capturedAt) > WatchRelayQueue.askExpiry {
            await notify(.questionExpired)
            return .dropped(.expired)
        }
        guard claim(recording.ref) else { return .dropped(.duplicate) }
        if item.state.transcript == nil {
            guard let transcript = await transcribe(inbox.audioURL(item.id), recording: recording) else {
                await notify(.untranscribed(recording.kind))
                return .untranscribed(recording.kind)
            }
            item.state.transcript = transcript.text
            item.state.transcribedOnDevice = transcript.by == .onDevice
            try? inbox.save(item)
            inbox.removeAudio(item)
        }
        let text = item.state.transcript ?? ""
        let by: Transcriber = item.state.transcribedOnDevice ? .onDevice : .gateway
        switch recording.kind {
        case .note:
            await saveNote(text, recording.captureTime, recording.ref)
            return .savedNote(text: text, by: by)
        case .ask:
            await ask(text)
            return .asked(question: text, by: by)
        }
    }

    private func transcribe(_ audio: URL, recording: WatchVoiceRecording) async -> (text: String, by: Transcriber)? {
        if let route = await gatewayRoute(),
           let text = await Self.gatewayText(audio, route: route, language: recording.languageCode) {
            return (text, .gateway)
        }
        let local = await transcribeOnDevice(audio, recording.locale)?.trimmingCharacters(in: .whitespacesAndNewlines)
        if let local, !local.isEmpty { return (local, .onDevice) }
        return nil
    }

    /// The gateway's text for a recording, or nil on any failure — including
    /// a recording over the gateway's limit, and gateway dictation having
    /// been switched off since the watch recorded.
    static func gatewayText(_ audio: URL, route: GatewayDictationRoute, language: String?) async -> String? {
        guard let data = try? Data(contentsOf: audio), !data.isEmpty, data.count <= route.maxAudioBytes else {
            return nil
        }
        let result = try? await route.transcriber.transcribe(
            audio: data,
            contentType: WatchVoiceFormat.contentType,
            language: language
        )
        let text = result?.text.trimmingCharacters(in: .whitespacesAndNewlines)
        return text?.isEmpty == false ? text : nil
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
    let notify: @Sendable (WatchVoiceNotice) async -> Void

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
