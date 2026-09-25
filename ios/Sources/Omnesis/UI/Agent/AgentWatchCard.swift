// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation
#if canImport(SwiftUI) && canImport(UIKit)
import SwiftUI

/// Tool names whose successful call is an automation write worth a card.
/// `watch_create` / `watch_update` are what the agent calls today; the retired
/// `trigger_*` authoring names stay listed so transcripts recorded before
/// watches still render their cards when reopened.
let agentAutomationTools: Set<String> = [
    "watch_create", "watch_update", "trigger_upsert", "trigger_toggle",
]

/// Whether an automation card handles this tool call.
func agentAutomationCardHandles(_ tool: String) -> Bool {
    agentAutomationTools.contains(tool)
}

/// Inline transcript card the agent surfaces every time it successfully
/// writes an automation. Mirrors the portal's `TriggerActionCard`:
///
///   - **Lightning glyph** (SF Symbol `bolt.fill`) in `Theme.accent` on
///     the leading edge — the consistent "agent just performed an
///     action" cue.
///   - **Primary line**: verb + automation name. Verb is derived from the
///     result kind: created / updated for `trigger.upserted`, and
///     enabled / disabled for a `trigger.toggled` result in an older
///     transcript.
///   - **Secondary line** (`triggerUpserted` only): the one-line summary
///     explaining what the automation does.
///   - **Pending stub**: while the tool block is open but the result
///     hasn't landed yet, show a muted "Setting up watch…" line so
///     the user sees something is in flight.
///
/// Read-only trigger tools (`triggers_list`, `trigger_get`,
/// `trigger_firings`) intentionally do NOT route here — they're
/// background data fetches, not user-visible actions.
@available(iOS 17.0, *)
struct AgentWatchCard: View {
    @Environment(NotificationRouter.self) private var router
    let call: AgentToolCall

    var body: some View {
        switch resolve() {
        case .pending:
            pendingBody
        case .error(let code, let message):
            AgentToolErrorCard(code: code, message: message)
        case .action(let verb, let name, let summary, let watchId):
            Button {
                // Channel the tap through the existing NotificationRouter so
                // it shares one deep-link path with a watch-firing push. The
                // HomeView flips to the Watches section and WatchesView's
                // consumeRouterTarget pushes the watch onto the nav stack —
                // where the person can read what it will do and stop it if
                // that is not what they meant.
                router.pendingTarget = .watch(watchId: watchId)
            } label: {
                actionBody(verb: verb, name: name, summary: summary)
            }
            .buttonStyle(.plain)
            .accessibilityLabel(Text("\(verb) \(name) — open watch details"))
        }
    }

    private var pendingBody: some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            Image(systemName: "bolt.fill")
                .font(.system(size: 11, weight: .medium))
                .foregroundStyle(Theme.textMuted)
            Text("Setting up watch…")
                .font(.system(size: 13))
                .foregroundStyle(Theme.textMuted)
            Spacer(minLength: 0)
        }
        .padding(.vertical, 6)
        .padding(.horizontal, 8)
        .background(
            HStack {
                Rectangle()
                    .fill(Theme.border)
                    .frame(width: 2)
                Spacer()
            }
        )
    }

    private func actionBody(verb: String, name: String, summary: String?) -> some View {
        HStack(alignment: .top, spacing: 8) {
            Image(systemName: "bolt.fill")
                .font(.system(size: 11, weight: .semibold))
                .foregroundStyle(Theme.accent)
                .padding(.top, 2)
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 4) {
                    Text(verb)
                        .font(.system(size: 13, weight: .medium))
                        .foregroundStyle(Theme.textPrimary)
                    Text(name)
                        .font(.system(size: 13, weight: .medium))
                        .foregroundStyle(Theme.accent)
                        .lineLimit(1)
                        .truncationMode(.tail)
                }
                if let summary, !summary.isEmpty {
                    Text(summary)
                        .font(.system(size: 12))
                        .foregroundStyle(Theme.textSecondary)
                        .lineLimit(2)
                }
            }
            Spacer(minLength: 0)
        }
        .padding(.vertical, 8)
        .padding(.horizontal, 8)
        .background(
            HStack {
                Rectangle()
                    .fill(Theme.accent)
                    .frame(width: 2)
                Color.clear
            }
        )
        .background(Theme.accent.opacity(0.06))
        .clipShape(RoundedRectangle(cornerRadius: 6, style: .continuous))
    }

    // MARK: - Result interpretation

    private enum Resolved {
        case pending
        case error(code: String, message: String)
        case action(verb: String, name: String, summary: String?, watchId: String)
    }

    private func resolve() -> Resolved {
        guard let result = call.result else { return .pending }
        switch result {
        case .error(let code, let message):
            return .error(code: code, message: message)
        case .watchUpserted(let watchId, let name, let action, _, let summary):
            let verb = action == "created" ? "Created watch" : "Updated watch"
            return .action(verb: verb, name: name, summary: summary, watchId: watchId)
        case .triggerUpserted(let watchId, let name, let action, _, let summary):
            // Cards from conversations stored before the rename. Rendered
            // rather than dropped: they still describe something the user
            // asked for, and a stored transcript is still theirs.
            let verb = action == "created" ? "Created watch" : "Updated watch"
            return .action(verb: verb, name: name, summary: summary, watchId: watchId)
        case .triggerToggled(let watchId, let name, let enabled):
            return .action(
                verb: enabled ? "Enabled watch" : "Disabled watch",
                name: name,
                summary: nil,
                watchId: watchId
            )
        default:
            // Any other result that somehow reaches this card (routing is
            // gated upstream in AgentPartView) collapses to a "pending"
            // placeholder so nothing crashes if the contract ever drifts.
            return .pending
        }
    }
}

// MARK: - Reusable error card (lifts out of AgentToolCallView for AgentWatchCard reuse)

/// Compact, expandable error card. Identical visual language to
/// `AgentToolCallView`'s inline error rendering; lifted into a
/// standalone view so other transcript surfaces (like
/// `AgentWatchCard`) can render tool errors with the same look.
@available(iOS 17.0, *)
struct AgentToolErrorCard: View {
    let code: String
    let message: String

    @State private var expanded: Bool = false

    var body: some View {
        let first = firstLine(message)
        let hasMore = message != first
        VStack(alignment: .leading, spacing: 4) {
            Button {
                if hasMore {
                    withAnimation(.easeInOut(duration: 0.15)) { expanded.toggle() }
                }
            } label: {
                HStack(spacing: 6) {
                    Text(code)
                        .font(.system(size: 11, weight: .semibold))
                        .foregroundStyle(Theme.danger)
                    Text(first)
                        .font(.system(size: 12))
                        .foregroundStyle(Theme.textSecondary)
                        .lineLimit(1)
                        .truncationMode(.tail)
                    Spacer(minLength: 0)
                    if hasMore {
                        Image(systemName: expanded ? "chevron.up" : "chevron.down")
                            .font(.system(size: 9, weight: .medium))
                            .foregroundStyle(Theme.textMuted)
                    }
                }
            }
            .buttonStyle(.plain)
            if expanded, hasMore {
                Text(message)
                    .font(Theme.monospace(size: 11))
                    .foregroundStyle(Theme.textSecondary)
                    .textSelection(.enabled)
            }
        }
        .padding(.vertical, 4)
        .padding(.horizontal, 8)
        .background(
            HStack {
                Rectangle()
                    .fill(Theme.danger.opacity(0.45))
                    .frame(width: 2)
                Color.clear
            }
        )
        .background(Theme.danger.opacity(0.04))
        .clipShape(RoundedRectangle(cornerRadius: 4, style: .continuous))
    }

    private func firstLine(_ text: String) -> String {
        guard let idx = text.firstIndex(of: "\n") else { return text }
        return String(text[..<idx])
    }
}

#if DEBUG
@available(iOS 17.0, *)
#Preview("Trigger card — created") {
    let call = AgentToolCall(
        toolCallId: "tu_1",
        tool: "trigger_upsert",
        args: JSONAny(value: NSNull()),
        argsSummary: "create",
        argsKnown: true,
        result: .watchUpserted(
            watchId: "wat_a",
            name: "Email digest",
            action: "created",
            enabled: true,
            summary: "Notify when a new invoice email arrives in Gmail"
        ),
        durationMs: 120
    )
    return VStack(alignment: .leading) {
        AgentWatchCard(call: call)
    }
    .padding()
    .background(Theme.bgPrimary)
    .environment(NotificationRouter())
    .preferredColorScheme(.dark)
}

@available(iOS 17.0, *)
#Preview("Trigger card — updated, no summary") {
    let call = AgentToolCall(
        toolCallId: "tu_2",
        tool: "trigger_upsert",
        args: JSONAny(value: NSNull()),
        argsSummary: "update",
        argsKnown: true,
        result: .watchUpserted(
            watchId: "wat_b",
            name: "Daily summary",
            action: "updated",
            enabled: true,
            summary: nil
        ),
        durationMs: 95
    )
    return VStack(alignment: .leading) {
        AgentWatchCard(call: call)
    }
    .padding()
    .background(Theme.bgPrimary)
    .environment(NotificationRouter())
    .preferredColorScheme(.dark)
}

@available(iOS 17.0, *)
#Preview("Watch card — toggled off") {
    let call = AgentToolCall(
        toolCallId: "tu_3",
        tool: "trigger_toggle",
        args: JSONAny(value: NSNull()),
        argsSummary: "disable",
        argsKnown: true,
        result: .triggerToggled(
            triggerId: "trg_c",
            name: "Workout reminder",
            enabled: false
        ),
        durationMs: 40
    )
    return VStack(alignment: .leading) {
        AgentWatchCard(call: call)
    }
    .padding()
    .background(Theme.bgPrimary)
    .environment(NotificationRouter())
    .preferredColorScheme(.dark)
}

@available(iOS 17.0, *)
#Preview("Trigger card — pending (no result yet)") {
    let call = AgentToolCall(
        toolCallId: "tu_4",
        tool: "trigger_upsert",
        args: JSONAny(value: NSNull()),
        argsSummary: "create",
        argsKnown: true,
        result: nil,
        durationMs: nil
    )
    return VStack(alignment: .leading) {
        AgentWatchCard(call: call)
    }
    .padding()
    .background(Theme.bgPrimary)
    .environment(NotificationRouter())
    .preferredColorScheme(.dark)
}

@available(iOS 17.0, *)
#Preview("Trigger card — error") {
    let call = AgentToolCall(
        toolCallId: "tu_5",
        tool: "trigger_upsert",
        args: JSONAny(value: NSNull()),
        argsSummary: "create",
        argsKnown: true,
        result: .error(
            code: "non_ios_actions",
            message: "every action in a trigger the agent manages must be `notify-ios`; got exec"
        ),
        durationMs: 8
    )
    return VStack(alignment: .leading) {
        AgentWatchCard(call: call)
    }
    .padding()
    .background(Theme.bgPrimary)
    .environment(NotificationRouter())
    .preferredColorScheme(.dark)
}
#endif
#endif
