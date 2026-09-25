// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation

/// One thing a person should be told about a source on one device. Mirrors
/// `SourceNotice` in packages/types/src/source-notice.ts. The gateway writes
/// every word; clients present them and never interpret the underlying
/// status fields themselves.
public struct SourceNotice: Decodable, Equatable, Hashable, Sendable {
    /// How loudly to present a notice. Ordered from least to most severe, so
    /// `max()` picks the one a single indicator should show.
    public enum Severity: String, Comparable, Sendable, CaseIterable {
        case info
        case warning
        case error

        private var rank: Int {
            switch self {
            case .info: 0
            case .warning: 1
            case .error: 2
            }
        }

        public static func < (lhs: Severity, rhs: Severity) -> Bool {
            lhs.rank < rhs.rank
        }

        /// The noun for a count of notices at this severity, as the portal
        /// words it: problems, warnings and notes.
        public func noun(count: Int) -> String {
            switch self {
            case .info: count == 1 ? "note" : "notes"
            case .warning: count == 1 ? "warning" : "warnings"
            case .error: count == 1 ? "problem" : "problems"
            }
        }
    }

    /// Stable category (`error`, `needs-auth`, `coverage-partial`, …). Kept as
    /// a string so a kind this build has never seen still decodes.
    public let kind: String
    /// A severity this build does not know decodes as `.warning`: shown, never
    /// dropped, never alarming.
    public let severity: Severity
    public let title: String
    public let detail: String?
    public let steps: [String]?
    /// ISO 8601 time the condition was first observed.
    public let since: String?

    public init(
        kind: String,
        severity: Severity,
        title: String,
        detail: String? = nil,
        steps: [String]? = nil,
        since: String? = nil
    ) {
        self.kind = kind
        self.severity = severity
        self.title = title
        self.detail = detail
        self.steps = steps
        self.since = since
    }

    private enum CodingKeys: String, CodingKey {
        case kind
        case severity
        case title
        case detail
        case steps
        case since
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        kind = try container.decode(String.self, forKey: .kind)
        let rawSeverity = try container.decodeIfPresent(String.self, forKey: .severity)
        severity = rawSeverity.flatMap(Severity.init(rawValue:)) ?? .warning
        title = try container.decode(String.self, forKey: .title)
        detail = try container.decodeIfPresent(String.self, forKey: .detail)
        steps = try container.decodeIfPresent([String].self, forKey: .steps)
        since = try container.decodeIfPresent(String.self, forKey: .since)
    }
}

/// The notices one device has for a source. `deviceId` is `nil` when the
/// gateway named no device for them.
public struct DeviceNotices: Equatable, Sendable {
    public let deviceId: String?
    public let notices: [SourceNotice]

    public init(deviceId: String?, notices: [SourceNotice]) {
        self.deviceId = deviceId
        self.notices = notices
    }
}

extension SourceSyncStatus {
    /// The notices to show for this status. A gateway that serves `notices`
    /// is taken at its word, including an empty list. For one that does not —
    /// an older gateway, or a status the socket has just moved into a new
    /// state before the gateway was read again — the notice is derived from
    /// the state itself, in the gateway's own words, so a failure or warning
    /// is never left unmentioned.
    public var displayNotices: [SourceNotice] {
        if let notices { return notices }
        return fallbackNotices
    }

    private var fallbackNotices: [SourceNotice] {
        let message = errorMessage.flatMap { $0.isEmpty ? nil : $0 }
        switch state {
        case "needs-auth":
            return [SourceNotice(
                kind: "needs-auth",
                severity: .error,
                title: "Needs sign-in",
                detail: message.flatMap { strippingPrefix("needs reauth: ", from: $0) }
            )]
        case "rate-limited":
            return [SourceNotice(
                kind: "rate-limited",
                severity: .info,
                title: "Paused by the provider's rate limit",
                detail: message.flatMap { strippingPrefix("rate-limited: ", from: $0) }
            )]
        case "stale" where staleHint?.isEmpty == false:
            return [SourceNotice(kind: "stale", severity: .warning, title: "No new data is arriving", detail: staleHint)]
        case "auth-expiring" where consentExpiresAt != nil:
            let title = parseISODate(consentExpiresAt).map {
                "Connection expires on \($0.formatted(.dateTime.day().month(.wide).year()))"
            } ?? "Connection expires soon"
            return [SourceNotice(kind: "auth-expiring", severity: .warning, title: title)]
        default:
            guard state == "error" || message != nil else { return [] }
            return [SourceNotice(kind: "error", severity: .error, title: "The last sync failed", detail: message)]
        }
    }

    private func strippingPrefix(_ prefix: String, from message: String) -> String? {
        let stripped = message.hasPrefix(prefix) ? String(message.dropFirst(prefix.count)) : message
        return stripped.isEmpty ? nil : stripped
    }

    /// The notices a status keeps when a socket event updates it. Notices
    /// never ride an event, so the last ones read are kept — unless the event
    /// changed the state or the failure, when they may describe the old state.
    /// Then there are none (`nil`), and `displayNotices` derives one from the
    /// new state until the gateway is read again.
    static func carriedNotices(
        from existing: SourceSyncStatus?,
        state: String,
        errorMessage: String?
    )
        -> [SourceNotice]? {
        guard let existing, existing.state == state, existing.errorMessage == errorMessage else { return nil }
        return existing.notices
    }

    /// A copy with the notices of a fresher read of the same source. Every
    /// other field is kept, so a status the socket has moved on since the read
    /// was taken keeps its newer state. Members are matched by device; one the
    /// read does not list has nothing to say. When the read has members this
    /// copy lacks, their rows are taken whole, since there is no newer
    /// per-device state to keep.
    func adoptingNotices(from fresh: SourceSyncStatus) -> SourceSyncStatus {
        let updatedMembers: [SourceSyncStatus]? = if let members, !members.isEmpty {
            members.map { member in
                guard let freshMember = fresh.members?.first(where: { $0.deviceId == member.deviceId }) else {
                    return member.withNotices([])
                }
                return member.withNotices(freshMember.notices)
            }
        } else {
            fresh.members
        }
        return replacingMembers(updatedMembers).withNotices(fresh.notices)
    }

    private func withNotices(_ notices: [SourceNotice]?) -> SourceSyncStatus {
        SourceSyncStatus(
            sourceId: sourceId,
            deviceId: deviceId,
            members: members,
            state: state,
            unitName: unitName,
            progress: progress,
            startedAt: startedAt,
            lastSyncAt: lastSyncAt,
            errorMessage: errorMessage,
            erroredAt: erroredAt,
            lastUpdated: lastUpdated,
            consentExpiresAt: consentExpiresAt,
            staleHint: staleHint,
            notices: notices
        )
    }

    /// Adopt the notices of a fresh read into every status already held.
    /// Sources the read adds or drops are left to the full refresh.
    static func adoptingNotices(
        from fresh: [SourceSyncStatus],
        into current: [String: SourceSyncStatus]
    )
        -> [String: SourceSyncStatus] {
        var updated = current
        for status in fresh {
            guard let held = current[status.sourceId] else { continue }
            updated[status.sourceId] = held.adoptingNotices(from: status)
        }
        return updated
    }

    /// The notices for each device that contributes to this source. A
    /// multi-device status reads each member's own list; any other status
    /// belongs wholly to one device — its own `deviceId`, or
    /// `fallbackDeviceId` (the source's registered host) when it names none.
    public func noticesByDevice(fallbackDeviceId: String?) -> [DeviceNotices] {
        if let members, !members.isEmpty {
            return members.map { DeviceNotices(deviceId: $0.deviceId, notices: $0.displayNotices) }
        }
        return [DeviceNotices(deviceId: deviceId ?? fallbackDeviceId, notices: displayNotices)]
    }

    /// Every notice across the source's devices, for a surface with room for
    /// only one indicator.
    public var allDisplayNotices: [SourceNotice] {
        if let members, !members.isEmpty {
            return members.flatMap(\.displayNotices)
        }
        return displayNotices
    }
}

/// A notice list ordered most severe first, keeping the gateway's order
/// within a severity.
func sortedBySeverity(_ notices: [SourceNotice]) -> [SourceNotice] {
    notices.enumerated()
        .sorted { lhs, rhs in
            lhs.element.severity != rhs.element.severity
                ? lhs.element.severity > rhs.element.severity
                : lhs.offset < rhs.offset
        }
        .map(\.element)
}

/// The label for one severity's icon: "2 warnings for studio-desk".
func sourceNoticeGroupLabel(severity: SourceNotice.Severity, count: Int, deviceName: String?) -> String {
    let base = "\(count) \(severity.noun(count: count))"
    guard let deviceName, !deviceName.isEmpty else { return base }
    return "\(base) for \(deviceName)"
}

/// The label for a single icon standing for many notices: "3 notices,
/// including 1 problem, for studio-desk and travel-laptop". When every notice
/// shares a severity, the count names it: "2 warnings".
func sourceNoticeSummaryLabel(_ notices: [SourceNotice], deviceNames: [String]) -> String {
    guard let worst = notices.map(\.severity).max() else { return "" }
    let worstCount = notices.filter { $0.severity == worst }.count
    var label = if worstCount == notices.count {
        "\(notices.count) \(worst.noun(count: notices.count))"
    } else {
        "\(notices.count) notices, including \(worstCount) \(worst.noun(count: worstCount))"
    }
    let names = deviceNames.filter { !$0.isEmpty }
    if !names.isEmpty {
        label += "\(worstCount == notices.count ? "" : ",") for \(ListFormatter.localizedString(byJoining: names))"
    }
    return label
}

/// "Since 2 Jan, 03:04" — the portal's phrasing, in the reader's locale.
func noticeSinceText(_ iso: String?) -> String? {
    guard let date = parseISODate(iso) else { return nil }
    return "Since \(date.formatted(.dateTime.day().month(.abbreviated).hour().minute()))"
}

/// Parse an ISO 8601 timestamp, with or without fractional seconds
/// (`ISO8601DateFormatter` accepts only the form its options name, so both
/// are tried).
func parseISODate(_ iso: String?) -> Date? {
    guard let iso, !iso.isEmpty else { return nil }
    let withFractional = ISO8601DateFormatter()
    withFractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    if let date = withFractional.date(from: iso) { return date }
    let plain = ISO8601DateFormatter()
    plain.formatOptions = [.withInternetDateTime]
    return plain.date(from: iso)
}
