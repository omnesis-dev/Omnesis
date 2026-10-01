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

    var isoString: String {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter.string(from: capturedAt)
    }

    static func parseDate(_ value: String) -> Date? {
        let fractional = ISO8601DateFormatter()
        fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let parsed = fractional.date(from: value) { return parsed }
        let plain = ISO8601DateFormatter()
        plain.formatOptions = [.withInternetDateTime]
        return plain.date(from: value)
    }
}

/// What the iPhone answers a watch note's live message with. The watch
/// takes any answer as the phone's confirmation that it has the note — its
/// outbox then lets the note go — so the outcome is for the phone's own log
/// and for watch builds that show it.
///
/// Pure and platform-free so it compiles into both the iPhone app and the
/// watch app targets.
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
    /// Another copy of the same note is already on the phone; it is saved
    /// once.
    case reachedPhone
    /// The message could not be read as a note.
    case relayFailed

    /// Stable string tag, used as the WatchConnectivity reply discriminator.
    var tag: String {
        switch self {
        case .saved: "saved"
        case .queuedOnPhone: "queuedOnPhone"
        case .rejected: "rejected"
        case .captureFailed: "captureFailed"
        case .reachedPhone: "reachedPhone"
        case .relayFailed: "relayFailed"
        }
    }
}

/// The WatchConnectivity message contract for the watch → iPhone note
/// relay. The watch sends `request(text:)` — live, or on the queued channel —
/// and the iPhone answers a live one with `reply(for:)`. Both directions are
/// plain `[String: String]` so the dictionaries satisfy WatchConnectivity's
/// property-list requirement, and the parsers are defensive — a malformed
/// payload is refused rather than crashing.
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
}
