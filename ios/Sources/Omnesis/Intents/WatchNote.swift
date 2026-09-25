// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation

/// The instant and local-calendar interpretation snapshotted together at
/// capture time. Keeping the observed offset alongside the zone freezes the
/// wall clock across travel, DST-rule changes, slow location lookup, and
/// offline delivery.
public struct NoteCaptureTime: Codable, Equatable, Sendable {
    public let capturedAt: Date
    public let timeZoneId: String
    public let utcOffsetSeconds: Int

    public init(capturedAt: Date, timeZoneId: String, utcOffsetSeconds: Int) {
        self.capturedAt = capturedAt
        self.timeZoneId = timeZoneId
        self.utcOffsetSeconds = utcOffsetSeconds
    }

    public static func now(
        date: Date = Date(),
        timeZone: TimeZone = .autoupdatingCurrent
    )
        -> NoteCaptureTime {
        NoteCaptureTime(
            capturedAt: date,
            timeZoneId: timeZone.identifier,
            utcOffsetSeconds: timeZone.secondsFromGMT(for: date)
        )
    }

    fileprivate var isoString: String {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter.string(from: capturedAt)
    }

    fileprivate static func parseDate(_ value: String) -> Date? {
        let fractional = ISO8601DateFormatter()
        fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let parsed = fractional.date(from: value) { return parsed }
        let plain = ISO8601DateFormatter()
        plain.formatOptions = [.withInternetDateTime]
        return plain.date(from: value)
    }
}

/// The outcome of capturing a note from the Apple Watch. The watch holds
/// no gateway pairing, so it relays the dictated note to the paired
/// iPhone over WatchConnectivity; the iPhone saves it (attaching the
/// phone's location) through the shared `NoteCaptureService` and replies
/// with one of these, plus the watch-only relay outcomes the phone can
/// never produce (`reachedPhone`, `phoneUnreachable`, `watchLinkInactive`,
/// `relayFailed`, `queuedForPhone`).
///
/// Pure and platform-free so the sim-less logic lane covers the spoken
/// copy and the relay wire, and so it compiles into both the iPhone app
/// and the watch app targets.
public enum WatchNoteOutcome: Equatable, Sendable {
    /// The iPhone delivered the note to the gateway.
    case saved
    /// The iPhone saved the note to its durable queue (gateway
    /// unreachable, too old for notes, or a re-pair needed) — it
    /// will sync when the iPhone can reach the gateway.
    case queuedOnPhone
    /// The note itself was refused (too long, or a deterministic gateway
    /// rejection). Nothing was saved.
    case rejected
    /// The iPhone could neither deliver nor queue the note — it is lost.
    case captureFailed
    /// Watch-only: the note reached the iPhone (the send did not error) but
    /// no confirmation came back within the relay budget. The iPhone's
    /// capture is quick and durable (a POST or the offline queue), so the
    /// note almost certainly landed — this is a status, not a failure, so
    /// the user isn't nudged into re-dictating a duplicate the phone can't
    /// dedup.
    case reachedPhone
    /// Watch-only: the paired iPhone couldn't be reached to relay the note.
    case phoneUnreachable
    /// Watch-only: the watch's own connectivity session never activated,
    /// so the note never left the watch.
    case watchLinkInactive
    /// Watch-only: the relay to the iPhone failed for another reason.
    case relayFailed
    /// Watch-only: the iPhone app never picked the note up live, so the watch
    /// queued it on WatchConnectivity's guaranteed-delivery channel. The phone
    /// saves it, with its original capture time, when it next runs.
    case queuedForPhone

    /// Stable string tag, used as the WatchConnectivity reply discriminator.
    var tag: String {
        switch self {
        case .saved: "saved"
        case .queuedOnPhone: "queuedOnPhone"
        case .rejected: "rejected"
        case .captureFailed: "captureFailed"
        case .reachedPhone: "reachedPhone"
        case .phoneUnreachable: "phoneUnreachable"
        case .watchLinkInactive: "watchLinkInactive"
        case .relayFailed: "relayFailed"
        case .queuedForPhone: "queuedForPhone"
        }
    }

    init?(tag: String) {
        switch tag {
        case "saved": self = .saved
        case "queuedOnPhone": self = .queuedOnPhone
        case "rejected": self = .rejected
        case "captureFailed": self = .captureFailed
        case "reachedPhone": self = .reachedPhone
        case "phoneUnreachable": self = .phoneUnreachable
        case "watchLinkInactive": self = .watchLinkInactive
        case "relayFailed": self = .relayFailed
        case "queuedForPhone": self = .queuedForPhone
        default: return nil
        }
    }

    /// How a surface with a screen should present this outcome. A saved
    /// (or queued) note is a success; a rejection/failure reads badly if
    /// dressed up as one.
    public enum Kind: Equatable, Sendable {
        case success
        case status
        case failure
    }

    public var kind: Kind {
        switch self {
        case .saved:
            .success
        case .queuedOnPhone:
            // Saved, just not delivered yet — neither a win to celebrate
            // nor a failure to apologise for.
            .status
        case .reachedPhone:
            // The note is on the phone; only its confirmation didn't make
            // it back. Not a failure — nothing needs redoing.
            .status
        case .queuedForPhone:
            // Held for delivery, not lost — nothing needs redoing.
            .status
        case .rejected, .captureFailed, .phoneUnreachable, .watchLinkInactive, .relayFailed:
            .failure
        }
    }
}

/// The single source of spoken/'shown copy for a watch note capture,
/// shared by the watch UI so every surface reads identical sentences.
public enum WatchNoteDialog {
    public static func text(for outcome: WatchNoteOutcome) -> String {
        switch outcome {
        case .saved:
            "Noted."
        case .queuedOnPhone:
            "Noted — it will sync from your iPhone when your gateway is reachable."
        case .rejected:
            "Sorry, I couldn't save that note."
        case .captureFailed:
            "Sorry, I couldn't save that note."
        case .reachedPhone:
            "Your note reached your iPhone and is saving there."
        case .phoneUnreachable:
            "I couldn't reach your iPhone. Make sure it's nearby and unlocked, then try again."
        case .watchLinkInactive:
            "The watch couldn't open its link to your iPhone. Try again in a moment."
        case .relayFailed:
            "Sorry, something went wrong reaching your iPhone."
        case .queuedForPhone:
            "Your iPhone didn't respond in time, so your note is queued. It will save once your iPhone picks it up."
        }
    }
}

/// The WatchConnectivity message contract for the watch → iPhone note
/// relay. The watch sends `request(text:)`; the iPhone answers with
/// `reply(for:)`. Both directions are plain `[String: String]` so the
/// dictionaries satisfy WatchConnectivity's property-list requirement,
/// and both parsers are defensive — a malformed payload degrades to a
/// spoken failure rather than a crash.
///
/// The `kind` key namespaces this alongside the ask relay
/// (`SiriAskWire`): the iPhone's single WCSession delegate routes a
/// message by its `kind`, so note and ask messages never collide.
public enum WatchNoteWire {
    static let kindKey = "kind"
    static let noteKind = "note"
    static let textKey = "text"
    static let capturedAtKey = "capturedAt"
    static let timeZoneIdKey = "capturedTimeZoneId"
    static let utcOffsetSecondsKey = "capturedUtcOffsetSeconds"
    static let outcomeKey = "outcome"
    /// Identifies one captured note across its live attempts and its queued
    /// copy, so the phone saves it once however it arrives.
    static let refKey = "ref"

    /// Watch → iPhone: carry the dictated note text.
    public static func request(text: String, captureTime: NoteCaptureTime, ref: String) -> [String: String] {
        [
            kindKey: noteKind,
            textKey: text,
            capturedAtKey: captureTime.isoString,
            timeZoneIdKey: captureTime.timeZoneId,
            utcOffsetSecondsKey: String(captureTime.utcOffsetSeconds),
            refKey: ref,
        ]
    }

    /// iPhone side: the ref carried by a note, when the watch sent one.
    public static func ref(from message: [String: Any]) -> String? {
        message[refKey] as? String
    }

    /// iPhone side: extract the trimmed note text from a received message,
    /// or nil when the message isn't a well-formed note.
    public static func text(from message: [String: Any]) -> String? {
        guard message[kindKey] as? String == noteKind,
              let raw = message[textKey] as? String
        else {
            return nil
        }
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }

    public static func captureTime(from message: [String: Any]) -> NoteCaptureTime? {
        guard let capturedAt = message[capturedAtKey] as? String,
              let date = NoteCaptureTime.parseDate(capturedAt),
              let timeZoneId = message[timeZoneIdKey] as? String,
              !timeZoneId.isEmpty,
              let offsetText = message[utcOffsetSecondsKey] as? String,
              let offset = Int(offsetText),
              (-64800 ... 64800).contains(offset)
        else { return nil }
        return NoteCaptureTime(capturedAt: date, timeZoneId: timeZoneId, utcOffsetSeconds: offset)
    }

    /// iPhone → watch: encode the outcome as the relay reply.
    public static func reply(for outcome: WatchNoteOutcome) -> [String: String] {
        [outcomeKey: outcome.tag]
    }

    /// Watch side: decode a relay reply. An unrecognised or missing tag
    /// falls back to `relayFailed`.
    public static func outcome(from reply: [String: Any]) -> WatchNoteOutcome {
        guard let tag = reply[outcomeKey] as? String else { return .relayFailed }
        return WatchNoteOutcome(tag: tag) ?? .relayFailed
    }
}
