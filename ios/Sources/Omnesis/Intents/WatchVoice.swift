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
