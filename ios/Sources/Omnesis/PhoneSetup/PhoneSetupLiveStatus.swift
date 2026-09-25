// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation

/// Plain-language reading of this phone's sync status for one source, shared
/// by Settings and phone setup.
public enum LocalSyncStatusText {
    public static func headline(_ status: SourceSyncStatus?) -> String {
        switch status?.state {
        case "syncing": "Syncing…"
        case "error": "Last sync failed"
        case "needs-auth": "Needs authorization"
        case "auth-expiring": "Authorization expiring"
        case "rate-limited": "Temporarily limited"
        case "stale": "Not receiving new data"
        case "paused", "disabled": "Sync paused"
        case "unavailable": "Unavailable"
        case "permission-degraded", "background-access-missing": "Needs attention"
        case "synced", "completed": "Up to date"
        default: status?.lastSyncAt == nil ? "Not synced yet" : "Up to date"
        }
    }

    public static func kind(_ status: SourceSyncStatus?) -> PhoneSetupLiveStatus.Kind {
        switch status?.state {
        case "syncing": .syncing
        case "synced", "completed": .upToDate
        case "error", "needs-auth", "auth-expiring", "rate-limited", "stale", "paused", "disabled", "unavailable",
             "permission-degraded", "background-access-missing":
            .attention
        default: status?.lastSyncAt == nil ? .notSynced : .upToDate
        }
    }

    /// "1,284 processed" while a sync runs and reports a count above zero, otherwise nil.
    public static func processed(_ status: SourceSyncStatus?) -> String? {
        guard status?.state == "syncing", let processed = status?.progress?.processed, processed > 0 else { return nil }
        if let unit = status?.unitName {
            return "\(processed.formatted()) \(unit) processed"
        }
        return "\(processed.formatted()) processed"
    }
}

/// One source's live contribution from this device, for the outcome page and
/// Finish.
public struct PhoneSetupLiveStatus: Equatable, Sendable {
    public enum Kind: Equatable, Sendable {
        case syncing
        case upToDate
        case notSynced
        /// Failed, paused, or otherwise needing the user.
        case attention
    }

    public let headline: String
    /// A count of what has been processed, when the sync reports one.
    public let count: String?
    public let kind: Kind
    /// Completed share of the current sync, 0…1, when the source reports one.
    public let fraction: Double?

    /// The line for a source that is on here while the gateway has not yet
    /// accepted this device as one of its hosts.
    public static let awaitingGatewayHeadline = "Waiting for your gateway to confirm this iPhone"
    /// The line for a source that is on here while the collector is rebuilt
    /// around it, which waits for any sync already running.
    public static let gettingReadyHeadline = "Getting ready…"

    public init(headline: String, count: String? = nil, kind: Kind, fraction: Double? = nil) {
        self.headline = headline
        self.count = count
        self.kind = kind
        self.fraction = fraction
    }

    public init(_ status: SourceSyncStatus?) {
        let kind = LocalSyncStatusText.kind(status)
        self.init(
            headline: LocalSyncStatusText.headline(status),
            count: LocalSyncStatusText.processed(status),
            kind: kind,
            fraction: kind == .syncing ? status?.progress.flatMap(Self.fraction(of:)) : nil
        )
    }

    /// The count when there is one, otherwise the headline.
    public var line: String {
        count ?? headline
    }

    private static func fraction(of progress: SourceSyncStatus.Progress) -> Double? {
        if let percent = progress.percentComplete {
            return min(1, max(0, percent / 100))
        }
        if let total = progress.total, total > 0, let done = progress.processed {
            return min(1, max(0, Double(done) / Double(total)))
        }
        return nil
    }
}
