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

/// The gate the iPhone last published, kept across launches, so it is
/// published again only when it changes and can be re-sent to a watch app
/// installed later.
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
