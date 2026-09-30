// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation

// Gateway dictation for watch notes: the contract both ends share.
//
// The watch cannot reach the gateway itself, so when gateway dictation is on
// it records a note, hands the recording to the iPhone with
// `WCSession.transferFile`, and moves on. The iPhone saves it as a voice
// note — its own transcript at once, the gateway's when ready. Pure and
// platform-free so it compiles into both apps and the sim-less logic lane
// covers the wire.

/// How the watch encodes a recording: mono AAC at a speech bit rate, small
/// enough to cross WatchConnectivity quickly.
public enum WatchVoiceFormat {
    public static let sampleRate: Double = 16000
    public static let bitRate = 24000
    public static let contentType = "audio/mp4"
    public static let fileExtension = "m4a"
    /// The longest recording the watch makes. A note is short, and a longer
    /// one keeps the transfer and the transcriber busy.
    public static let maxDuration: TimeInterval = 2 * 60

    /// Watch → iPhone, right after a transfer: a message with no content
    /// whose only job is to wake the iPhone app, which a file transfer alone
    /// may not do. The phone ignores it; the transfer is what it acts on.
    public static let nudgeMessage = ["kind": "voiceNudge"]
}

/// What the iPhone tells the watch about gateway dictation, through the
/// session's application context: whether to record for the gateway, and how
/// large a recording it accepts.
public struct WatchDictationGate: Equatable, Sendable {
    public let active: Bool
    public let maxAudioBytes: Int
    /// When the iPhone last read the gateway's status.
    public let updatedAt: Date

    static let contextKey = "dictationGate"
    static let activeKey = "active"
    static let maxAudioBytesKey = "maxAudioBytes"
    static let updatedAtKey = "updatedAt"

    /// A gate the iPhone has not refreshed for this long is not trusted: the
    /// watch goes back to system dictation rather than act on old news.
    public static let staleAfter: TimeInterval = 7 * 24 * 60 * 60

    public init(active: Bool, maxAudioBytes: Int, updatedAt: Date) {
        self.active = active
        self.maxAudioBytes = maxAudioBytes
        self.updatedAt = updatedAt
    }

    /// iPhone side: the application context carrying this gate.
    public var applicationContext: [String: Any] {
        [
            Self.contextKey: [
                Self.activeKey: active ? "1" : "0",
                Self.maxAudioBytesKey: String(maxAudioBytes),
                Self.updatedAtKey: String(updatedAt.timeIntervalSince1970),
            ],
        ]
    }

    /// Watch side: the gate in a received application context, or nil when
    /// there is none or it cannot be read.
    public init?(applicationContext: [String: Any]) {
        guard let fields = applicationContext[Self.contextKey] as? [String: String],
              let active = fields[Self.activeKey],
              let bytes = fields[Self.maxAudioBytesKey].flatMap({ Int($0) }),
              let seconds = fields[Self.updatedAtKey].flatMap({ TimeInterval($0) }),
              seconds.isFinite
        else { return nil }
        self.init(active: active == "1", maxAudioBytes: bytes, updatedAt: Date(timeIntervalSince1970: seconds))
    }

    /// How long the watch may record for the gateway, or nil when it should
    /// use system dictation: the gate is off, stale, or leaves no room.
    public func recordingLimit(now: Date) -> TimeInterval? {
        guard active, maxAudioBytes > 0, now.timeIntervalSince(updatedAt) < Self.staleAfter else { return nil }
        // Nine tenths of the byte limit at the nominal rate, leaving room for
        // the container and the encoder's drift.
        let byBytes = Double(maxAudioBytes) * 0.9 / (Double(WatchVoiceFormat.bitRate) / 8)
        let limit = min(WatchVoiceFormat.maxDuration, byBytes)
        return limit >= 1 ? limit : nil
    }
}

/// The metadata travelling with one recorded note.
public struct WatchVoiceRecording: Equatable, Sendable {
    /// Identifies the note across transfers and relaunches: the iPhone saves
    /// it under this id, so it is saved once.
    public let ref: String
    public let captureTime: NoteCaptureTime
    /// The watch's locale identifier (such as `en_GB`): the on-device
    /// recognizer's locale, and the note's `language` for the gateway.
    public let locale: String?

    /// Marks the metadata as a watch voice note's.
    static let kindKey = "voiceKind"
    static let noteKind = "note"
    static let refKey = "ref"
    static let capturedAtKey = "capturedAt"
    static let timeZoneIdKey = "capturedTimeZoneId"
    static let utcOffsetSecondsKey = "capturedUtcOffsetSeconds"
    static let localeKey = "locale"

    public init(ref: String, captureTime: NoteCaptureTime, locale: String?) {
        self.ref = ref
        self.captureTime = captureTime
        self.locale = locale
    }

    /// Watch side: the `transferFile` metadata.
    public var metadata: [String: String] {
        var fields = [
            Self.kindKey: Self.noteKind,
            Self.refKey: ref,
            Self.capturedAtKey: captureTime.isoString,
            Self.timeZoneIdKey: captureTime.timeZoneId,
            Self.utcOffsetSecondsKey: String(captureTime.utcOffsetSeconds),
        ]
        if let locale { fields[Self.localeKey] = locale }
        return fields
    }

    /// iPhone side: the recording described by transfer metadata, or nil when
    /// it is not a watch recording or is missing what the pipelines need.
    public init?(metadata: [String: Any]) {
        guard metadata[Self.kindKey] as? String == Self.noteKind,
              let ref = metadata[Self.refKey] as? String, !ref.isEmpty,
              let capturedAt = (metadata[Self.capturedAtKey] as? String).flatMap(NoteCaptureTime.parseDate),
              let timeZoneId = metadata[Self.timeZoneIdKey] as? String, !timeZoneId.isEmpty,
              let offset = (metadata[Self.utcOffsetSecondsKey] as? String).flatMap({ Int($0) }),
              (-64800 ... 64800).contains(offset)
        else { return nil }
        self.init(
            ref: ref,
            captureTime: NoteCaptureTime(capturedAt: capturedAt, timeZoneId: timeZoneId, utcOffsetSeconds: offset),
            locale: metadata[Self.localeKey] as? String
        )
    }
}

/// When the watch app leaves the screen by itself after sending a note —
/// recorded or dictated — so a complication tap reads as one gesture: tap,
/// speak, send, back to the watch face.
///
/// watchOS offers no public call that returns to the watch face — no
/// suspend, no scene or window dismissal (`DismissWindowAction` is
/// unavailable on watchOS) — so the app ends its own process. That is safe
/// for the note only once WatchConnectivity carries it: a queued file
/// transfer continues after the sending app exits and reports how it ended
/// on the next launch, and the outbox sends again anything a transfer does
/// not carry. It is not safe for anything else the app is doing, so the app
/// leaves only while the "Sent" confirmation is still what it shows and
/// nothing else is under way. Pure, so the logic lane covers the rule.
public enum WatchVoiceDismissal {
    /// How long "Sent" stays on screen before the app leaves.
    public static let confirmationDelay: TimeInterval = 1.8

    /// Whether to leave now.
    /// - `showingSent`: the confirmation is still on screen — a failure, a
    ///   tap on it, or a new recording keeps the app.
    /// - `carriedByTransfer`: WatchConnectivity has the note — a transfer,
    ///   or a live message awaiting the phone's reply. One still waiting for
    ///   the link keeps the app running, so the outbox can hand it over when
    ///   the link comes back.
    /// - `otherWorkInFlight`: an ask or a dictated note is still relaying,
    ///   or an answer is being spoken.
    public static func shouldLeave(showingSent: Bool, carriedByTransfer: Bool, otherWorkInFlight: Bool) -> Bool {
        showingSent && carriedByTransfer && !otherWorkInFlight
    }
}

/// The watch's durable outbox of notes, and what to do with each: notes
/// recorded for gateway dictation, and notes dictated as text on the system's
/// screen.
///
/// A note counts as sent once it is safely in the outbox — its metadata, and
/// its recording when it has one, on disk — whatever the state of the link to
/// the iPhone. From there it is handed to WatchConnectivity, and handed again
/// whenever nothing carries it: at launch, when the iPhone becomes reachable,
/// when the iPhone app is installed, and after a delivery fails (then after a
/// backoff, so a failing link is not hammered). It leaves the outbox only when
/// the iPhone confirms it — a transfer reporting success, or the phone's reply
/// to a live message — or when it has waited so long it is dropped, and the
/// person is told. Every copy carries the same ref, so the phone saves the
/// note once however many copies reach it. Pure, so the logic lane covers the
/// policy.
public enum WatchOutboxPolicy {
    /// How long a note may wait for the iPhone before it is dropped.
    public static let retention: TimeInterval = 7 * 24 * 60 * 60
    /// The most notes kept waiting; the oldest beyond it are dropped. Two
    /// minutes of speech at the watch's bit rate is about 360 KB, so this
    /// bounds the outbox to a few tens of megabytes.
    public static let maxEntries = 50

    /// One waiting note, as the outbox records it beside the recording.
    public struct Entry: Codable, Equatable, Sendable {
        public let metadata: [String: String]
        public let queuedAt: Date
        /// Transfers that ended in an error.
        public var failures: Int
        public var lastFailureAt: Date?

        public init(metadata: [String: String], queuedAt: Date, failures: Int = 0, lastFailureAt: Date? = nil) {
            self.metadata = metadata
            self.queuedAt = queuedAt
            self.failures = failures
            self.lastFailureAt = lastFailureAt
        }

        public var ref: String? {
            metadata[WatchVoiceRecording.refKey]
        }

        /// A note dictated as text (`WatchNoteWire`), with no recording.
        public var isTextNote: Bool {
            WatchNoteWire.text(from: metadata) != nil
        }
    }

    /// How a note is handed over.
    public enum Transport: Equatable, Sendable {
        /// A recording goes as a file transfer.
        case file
        /// A text note to a reachable iPhone goes as a live message, whose
        /// reply confirms it at once — and as a queued transfer when that
        /// message fails.
        case liveMessage
        /// A text note to an iPhone out of reach goes as a queued transfer,
        /// which the system delivers when the iPhone app next runs.
        case queuedTransfer
    }

    public static func transport(for entry: Entry, phoneReachable: Bool) -> Transport {
        guard entry.isTextNote else { return .file }
        return phoneReachable ? .liveMessage : .queuedTransfer
    }

    /// What set the outbox moving.
    public enum Trigger: Equatable, Sendable {
        /// Launch, the iPhone becoming reachable, the iPhone app installed:
        /// the link may have just come back, so every waiting note is sent.
        case linkMayHaveChanged
        /// A transfer failed, or the backoff after one ran out: notes that
        /// failed are sent again only once their backoff has passed.
        case retry
    }

    public enum Action: Equatable, Sendable {
        /// Hand it to WatchConnectivity.
        case send
        /// A transfer carries it, or it is waiting out a backoff.
        case wait
        /// Waited too long, or pushed out by newer notes: delete it and say so.
        case drop
    }

    /// The pause before a note that failed `failures` times is sent again.
    public static func backoff(afterFailures failures: Int) -> TimeInterval {
        let steps: [TimeInterval] = [30, 2 * 60, 10 * 60, 30 * 60, 60 * 60]
        return steps[min(max(failures, 1), steps.count) - 1]
    }

    /// What to do with each waiting note, by ref. `carried` are the refs a
    /// transfer is already carrying — never sent twice.
    public static func plan(
        _ entries: [Entry],
        carried: Set<String>,
        trigger: Trigger,
        now: Date
    )
        -> [String: Action] {
        let newestFirst = entries.filter { $0.ref != nil }.sorted { $0.queuedAt > $1.queuedAt }
        var actions: [String: Action] = [:]
        for (index, entry) in newestFirst.enumerated() {
            guard let ref = entry.ref else { continue }
            if index >= maxEntries || now.timeIntervalSince(entry.queuedAt) > retention {
                actions[ref] = .drop
            } else if carried.contains(ref) {
                actions[ref] = .wait
            } else if trigger == .retry, entry.failures > 0, let failed = entry.lastFailureAt,
                      now.timeIntervalSince(failed) < backoff(afterFailures: entry.failures) {
                actions[ref] = .wait
            } else {
                actions[ref] = .send
            }
        }
        return actions
    }

    /// When the next backed-off note falls due, if any is waiting on one.
    public static func nextRetry(_ entries: [Entry], carried: Set<String>, now: Date) -> Date? {
        let dues = entries.compactMap { entry -> Date? in
            guard let ref = entry.ref, !carried.contains(ref), entry.failures > 0,
                  let failed = entry.lastFailureAt
            else { return nil }
            let due = failed.addingTimeInterval(backoff(afterFailures: entry.failures))
            return due > now ? due : nil
        }
        return dues.min()
    }
}
