// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation

/// When the iPhone tells the watch about gateway dictation, and what it
/// tells it. Pure, so the logic lane covers every rule.
///
/// The phone only speaks from knowledge: a process the watch woke in the
/// background has not read the gateway's status yet, and publishing "off"
/// from that ignorance would switch the watch back to system dictation for
/// no reason. So an unknown status publishes nothing, and a known one is
/// published only when it changes — or once a day, so the watch can tell a
/// phone that stopped refreshing from one whose answer simply held.
enum WatchGatePublishing {
    /// How often an unchanged gate is published again, to keep it fresh on
    /// the watch (`WatchDictationGate.staleAfter`).
    static let refreshInterval: TimeInterval = 24 * 60 * 60

    /// The gate a status implies, or nil while it is unknown. Unpaired, the
    /// phone knows the answer without any status: there is no gateway.
    static func gate(status: DictationStatus?, statusKnown: Bool, paired: Bool, now: Date) -> WatchDictationGate? {
        guard paired else { return WatchDictationGate(active: false, maxAudioBytes: 0, updatedAt: now) }
        guard statusKnown else { return nil }
        guard let status, status.routesToGateway else {
            return WatchDictationGate(active: false, maxAudioBytes: 0, updatedAt: now)
        }
        return WatchDictationGate(active: true, maxAudioBytes: status.maxAudioBytes, updatedAt: now)
    }

    /// Whether `gate` should replace `last`, the gate last published.
    static func shouldPublish(_ gate: WatchDictationGate, after last: WatchDictationGate?, now: Date) -> Bool {
        guard let last else { return true }
        return gate.active != last.active
            || gate.maxAudioBytes != last.maxAudioBytes
            || now.timeIntervalSince(last.updatedAt) >= refreshInterval
    }
}

/// The gate the iPhone last published, kept across launches. It is both
/// what the watch was told and what the phone itself goes by when a
/// recording arrives, so the two never disagree.
struct WatchDictationGateStore: @unchecked Sendable {
    static let key = "watchDictationGate"
    private let defaults: UserDefaults

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
    }

    func load() -> WatchDictationGate? {
        (defaults.dictionary(forKey: Self.key)).flatMap { WatchDictationGate(applicationContext: $0) }
    }

    func save(_ gate: WatchDictationGate) {
        defaults.set(gate.applicationContext, forKey: Self.key)
    }
}

/// Which gateway, if any, transcribes a watch recording on the iPhone.
enum WatchVoiceRouting {
    /// The gate to act on: the one last published, or — when the phone has
    /// never known one, as on a first background launch — a fresh read of
    /// the gateway's status, bounded by the caller.
    static func gate(
        stored: WatchDictationGate?,
        refresh: () async -> WatchDictationGate?
    ) async
        -> WatchDictationGate? {
        if let stored { return stored }
        return await refresh()
    }

    /// The route for `gate`, when it is on.
    static func route(
        gate: WatchDictationGate?,
        transcriber: (any DictationTranscribing)?
    )
        -> GatewayDictationRoute? {
        guard let gate, gate.active, gate.maxAudioBytes > 0, let transcriber else { return nil }
        return GatewayDictationRoute(transcriber: transcriber, maxAudioBytes: gate.maxAudioBytes)
    }
}
