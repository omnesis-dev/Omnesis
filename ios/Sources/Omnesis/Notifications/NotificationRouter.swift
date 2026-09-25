// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation

/// Single observable receiver for "user tapped a push notification and
/// wants to be deep-linked somewhere". The AppDelegate writes into it
/// when `UNUserNotificationCenter` reports a tap; SwiftUI views
/// observe the `pendingTarget` property to push the right detail view
/// onto the nav stack.
///
/// Keeping this small + decoupled means notification handling lives
/// outside the `AppStore` god class. The router only carries pending
/// deep-link state; it doesn't fetch anything.
@available(iOS 17.0, *)
@MainActor
@Observable
public final class NotificationRouter {
    /// What the next foregrounding should navigate to. HomeView flips
    /// the active section for it; the destination view (Watches,
    /// Briefs, Privacy, Agent) consumes it on appear or on change. Nil
    /// when nothing is queued.
    public var pendingTarget: PushTarget?

    /// When a target was last consumed. A destination view can take a target
    /// while something else is waiting on a network read — the ledger lookup
    /// behind a privacy decision that opens itself — and once it has, nothing
    /// is pending for that wait to notice when it finishes. This is the trace
    /// it leaves, so the wait can still tell an explicit destination arrived.
    public private(set) var lastConsumedAt: Date?

    public init() {}

    /// Read + clear in one call. A destination view calls this after it has
    /// applied the target so subsequent re-renders do not navigate again.
    @discardableResult
    public func consume() -> PushTarget? {
        defer {
            if pendingTarget != nil { lastConsumedAt = Date() }
            pendingTarget = nil
        }
        return pendingTarget
    }

    /// Whether a target was consumed at or after `date`.
    public func consumedSince(_ date: Date) -> Bool {
        guard let lastConsumedAt else { return false }
        return lastConsumedAt >= date
    }
}

/// Deep-link targets the iOS app understands.
///
///   - `watchFiring` — APNs deep-link from a watch that just came
///     true. The user tapped the push notification and lands on the
///     line of the watch's ledger it was about.
///   - `watch` — in-app deep-link from the agent's watch card
///     (lightning chip in the transcript). The user taps the card and
///     lands on the watch itself, to read what it will do and stop it
///     if that is not what they meant.
///   - `privacyApproval` - generic push for a held `/answer` response.
///     Only the opaque approval id crosses APNs; trusted detail is fetched
///     after the app opens the Privacy section.
public enum PushTarget: Equatable, Sendable {
    /// A brief push (the morning digest) — deep-links into the Briefs feed.
    case brief(briefId: String)
    /// A generic answer-privacy escalation. The opaque id is the only private
    /// request data allowed into the APNs payload; the app fetches detail after
    /// the user opens the trusted Privacy screen.
    case privacyApproval(approvalId: String)
    /// A generic MCP authorization request. It carries no request identifier
    /// or code: tapping it may only open the trusted short-code entry sheet.
    case accessAuthorization
    /// A finished agent turn whose answer outlived its spoken budget
    /// (a Siri ask handed off to the push channel) — deep-links into
    /// that conversation on the Agent surface.
    case agentAnswer(conversationId: String)
    /// A watch firing. The banner deliberately carries nothing about what the
    /// watch found — an APNs body renders on a locked screen — so the tap is
    /// how a person reaches the detail, on the device that already has it.
    case watchFiring(watchId: String, firingKey: String)
    /// A watch itself, with nothing marked on it: what the agent's card opens
    /// when it reports installing or rewriting one.
    case watch(watchId: String)
    /// A durable mobile permission alert. The affected device determines
    /// whether this phone may show its trusted local remediation snapshot.
    case sourcePermission(
        sourceId: String,
        affectedDeviceId: String?,
        sourceName: String?,
        affectedDeviceName: String?
    )
}

extension PushTarget {
    /// Short kind label safe for `.public` log interpolation — the case
    /// name only, never the associated ids (the privacy-approval id in
    /// particular is payload data and must stay redactable).
    public var kindName: String {
        switch self {
        case .brief: "brief"
        case .privacyApproval: "privacy-approval"
        case .accessAuthorization: "access-authorization"
        case .agentAnswer: "agent-answer"
        case .watchFiring: "watch-firing"
        case .watch: "watch"
        case .sourcePermission: "source-permission"
        }
    }

    /// Parse the `aps`-sibling `omnesis` dict the gateway's APNs
    /// client embeds. Returns nil for any malformed shape — taps on
    /// unrecognised payloads silently fall through to the app's
    /// normal launch flow.
    // One parser intentionally owns compatibility for canonical and legacy payloads.
    // swiftlint:disable:next cyclomatic_complexity
    public static func fromUserInfo(_ userInfo: [AnyHashable: Any]) -> PushTarget? {
        guard let omnesis = userInfo["omnesis"] as? [String: Any] else { return nil }
        let kind = omnesis["kind"] as? String
        if let targetId = omnesis["targetId"] as? String, !targetId.isEmpty {
            switch kind {
            case "brief": return .brief(briefId: targetId)
            case "privacy-approval":
                return validPrivacyApprovalId(targetId)
                    ? .privacyApproval(approvalId: targetId) : nil
            case "agent-answer", "conversation":
                return .agentAnswer(conversationId: targetId)
            case "watch": return .watch(watchId: targetId)
            case "source-permission":
                return sourcePermissionTarget(sourceId: targetId, payload: omnesis)
            case "access-authorization":
                return targetId == "access" ? .accessAuthorization : nil
            default: break
            }
        }
        if kind == "access-authorization" {
            // No payload field is authority for the pending request. The user
            // must enter the short code before the app asks the gateway for it.
            return .accessAuthorization
        }
        if kind == "brief" {
            guard let briefId = omnesis["briefId"] as? String else { return nil }
            return .brief(briefId: briefId)
        }
        if kind == "privacy-approval" {
            guard let approvalId = omnesis["approvalId"] as? String,
                  validPrivacyApprovalId(approvalId)
            else {
                return nil
            }
            return .privacyApproval(approvalId: approvalId)
        }
        if kind == "source-permission" {
            guard let sourceId = omnesis["sourceId"] as? String else { return nil }
            return sourcePermissionTarget(sourceId: sourceId, payload: omnesis)
        }
        if kind == "agent-answer" {
            guard let conversationId = omnesis["conversationId"] as? String else { return nil }
            return .agentAnswer(conversationId: conversationId)
        }
        if kind == "watch-firing" {
            guard let watchId = omnesis["watchId"] as? String,
                  let firingKey = omnesis["firingKey"] as? String
            else {
                return nil
            }
            return .watchFiring(watchId: watchId, firingKey: firingKey)
        }
        return nil
    }
}

/// Whether a source-permission push belongs to this iPhone. Older gateways did
/// not include `affectedDeviceId`, so a missing claim remains local for
/// backwards compatibility. A claim naming another paired device must never
/// lead to this phone's health snapshot or iOS repair controls.
public enum SourcePermissionTapRoute: Equatable, Sendable {
    case local
    case remote

    public static func resolve(
        affectedDeviceId: String?,
        currentDeviceId: String?
    )
        -> SourcePermissionTapRoute {
        guard let affectedDeviceId else { return .local }
        return affectedDeviceId == currentDeviceId ? .local : .remote
    }
}

private func sourcePermissionTarget(
    sourceId: String,
    payload: [String: Any]
)
    -> PushTarget? {
    guard validSourcePermissionId(sourceId) else { return nil }
    guard let rawDeviceId = payload["affectedDeviceId"] else {
        return .sourcePermission(
            sourceId: sourceId,
            affectedDeviceId: nil,
            sourceName: permissionDisplayName(payload["sourceName"]),
            affectedDeviceName: permissionDisplayName(payload["affectedDeviceName"])
        )
    }
    guard let deviceId = rawDeviceId as? String, validPrivacyApprovalId(deviceId) else {
        return nil
    }
    return .sourcePermission(
        sourceId: sourceId,
        affectedDeviceId: deviceId,
        sourceName: permissionDisplayName(payload["sourceName"]),
        affectedDeviceName: permissionDisplayName(payload["affectedDeviceName"])
    )
}

private func permissionDisplayName(_ value: Any?) -> String? {
    guard let value = value as? String,
          (1 ... 256).contains(value.count),
          value.unicodeScalars.allSatisfy({ !CharacterSet.controlCharacters.contains($0) })
    else {
        return nil
    }
    return value
}

private func validSourcePermissionId(_ value: String) -> Bool {
    guard (3 ... 200).contains(value.count), value.contains(":") else { return false }
    return value.unicodeScalars.allSatisfy { scalar in
        switch scalar.value {
        case 45, 46, 48 ... 58, 64 ... 90, 95, 97 ... 122: true
        default: false
        }
    }
}

/// The shape of a watch firing's key, as the gateway mints it.
///
/// A key is `<watchId>:<seq>` — the watch it belongs to, and the journal
/// sequence of the event that caused it. The push carries the key because that
/// is what the delivery ledger records, while the firings a device can read are
/// keyed by `seq` alone, so reaching the exact firing means taking the key
/// apart. Nothing else in the payload names the firing.
public enum WatchFiringKey {
    /// The journal sequence `key` names for `watchId`, or nil if it names none.
    ///
    /// Split from the right: a watch id is opaque to this app and may one day
    /// hold a colon, whereas the sequence never does. The prefix has to be the
    /// same watch the tap named — a key and a watch id that disagree describe
    /// two different things, and scrolling a ledger to an instant belonging to
    /// another watch is worse than not scrolling at all.
    public static func seq(in key: String, forWatch watchId: String) -> Int? {
        guard let separator = key.lastIndex(of: ":") else { return nil }
        guard key[key.startIndex ..< separator] == watchId else { return nil }
        let digits = key[key.index(after: separator)...]
        guard !digits.isEmpty, digits.allSatisfy({ $0.isASCII && $0.isNumber }) else { return nil }
        // Nil on a sequence too large to hold, which is the same answer as a
        // malformed one: this app has no firing to point at either way.
        return Int(digits)
    }
}

func validPrivacyApprovalId(_ value: String) -> Bool {
    guard (1 ... 200).contains(value.count) else { return false }
    return value.unicodeScalars.allSatisfy { scalar in
        switch scalar.value {
        case 45, 48 ... 57, 65 ... 90, 95, 97 ... 122:
            true
        default:
            false
        }
    }
}
