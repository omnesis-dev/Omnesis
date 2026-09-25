// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation
#if canImport(SwiftUI) && canImport(UIKit)
import SwiftUI

/// Switchboard — turns a typed `AgentToolResult` into the right
/// renderer for the *non-ephemeral* result kinds: person summaries,
/// trace_connections summaries, tool errors. The ephemeral happy-paths
/// (`searchResults`, `document`, `sqlRows`) are routed in
/// `AgentPartView` straight to their dedicated `AgentEphemeral*Card`
/// views and never reach this switchboard; the silent tools
/// (`annotate`, `plan`) are intercepted upstream and never produce a
/// tool part.
@available(iOS 17.0, *)
struct AgentToolResultView: View {
    let result: AgentToolResult

    var body: some View {
        switch result {
        case .eventTrailBuilt(_, let events, let truncated, _):
            // Inline fallback is a one-line summary; the full typed
            // Timeline renders in the Citations drawer's side panel.
            AgentEventTrailSummary(eventCount: events.count, truncated: truncated)
        case .error(let code, let message):
            AgentToolResultErrorView(code: code, message: message)
        case .searchResults,
             .document,
             .documentByUrl,
             .sqlRows,
             .personResults,
             .annotateRecorded,
             .citeRecordRecorded,
             .planUpdated,
             .watchUpserted,
             .triggersListed,
             .triggerFetched,
             .triggerFirings,
             .triggerUpserted,
             .triggerToggled,
             .loopsSearched,
             .loopFetched,
             .searchBatch,
             .documentBatch,
             .annotateBatch:
            // Watch mutations have their own card (AgentWatchCard, routed
            // from AgentPartView), so they render nothing a second time here.
            // The retired read-only automation results are background data
            // fetches that never had an inline render either. Search / fetch / SQL / lookup_people /
            // lookup_document_by_url / search_loops / fetch_loop / annotate /
            // cite_record / plan all surface elsewhere via their ephemeral
            // rolling-slot cards or the Citations drawer's Timeline. The batch
            // tools (`search.batch` / `document.batch`) project their own
            // per-child ephemeral cards in AgentPartView; `annotate.batch` is
            // silent like `annotate`, never reaching this switchboard.
            EmptyView()
        case .unknown(let kind, _):
            // The gateway is on a newer protocol than this client. The
            // production app drops the unknown result silently so the
            // surrounding transcript still reads; the demo app surfaces
            // a one-line placeholder so walkthrough screenshots make
            // the version skew visible rather than hiding it.
            if AppBuild.isDemo {
                AgentUnknownPartNotice(label: "tool result", kind: kind)
            }
        }
    }
}

// MARK: - Unknown-content placeholder (demo only)

/// Inline notice rendered when the demo build encounters a wire kind
/// it doesn't know about. The production target collapses these to
/// `EmptyView()` instead so the user never sees the seam.
@available(iOS 17.0, *)
struct AgentUnknownPartNotice: View {
    let label: String
    let kind: String

    var body: some View {
        HStack(spacing: 6) {
            Image(systemName: "questionmark.circle")
                .font(.system(size: 11))
                .foregroundStyle(Theme.textMuted)
            Text("Unknown \(label) (\(kind)) — update the app to view.")
                .font(.system(size: 12))
                .foregroundStyle(Theme.textMuted)
                .lineLimit(2)
                .truncationMode(.tail)
        }
        .padding(.horizontal, 8)
        .padding(.vertical, 6)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Theme.bgTertiary.opacity(0.4))
        .overlay(
            RoundedRectangle(cornerRadius: Theme.Radius.small)
                .stroke(Theme.border, lineWidth: 1)
        )
        .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.small))
    }
}

// MARK: - trace_connections summary

/// One-line fallback for `event_trail.built` results (the wire result kind
/// of the `trace_connections` tool) — surfaces a "trace_connections · N
/// events" badge inline so the user sees the tool fired. The full typed
/// trail (with attachments, people, related references) lives in the
/// document inspector's Timeline tab; this is the transcript-only summary.
@available(iOS 17.0, *)
struct AgentEventTrailSummary: View {
    let eventCount: Int
    let truncated: Bool

    var body: some View {
        let noun = eventCount == 1 ? "event" : "events"
        HStack(spacing: 6) {
            Text("trace_connections · \(eventCount) \(noun)")
                .font(.system(size: 12))
                .foregroundStyle(Theme.textSecondary)
            if truncated {
                Text("(truncated)")
                    .font(.system(size: 11).italic())
                    .foregroundStyle(Theme.textMuted)
            }
        }
        .padding(.horizontal, 8)
        .padding(.vertical, 6)
        .background(Theme.bgTertiary.opacity(0.4))
        .overlay(
            RoundedRectangle(cornerRadius: Theme.Radius.small)
                .stroke(Theme.border, lineWidth: 1)
        )
        .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.small))
    }
}

// MARK: - Error view (collapsed by default, expandable)

/// One-line muted-red summary that expands to reveal the full
/// (potentially multi-line) error message. Mirrors the portal's
/// `ToolErrorCard`: recoverable failures (binder errors, transient
/// fetch_document misses) are interesting for debugging but noisy in
/// the answer flow — collapsed-by-default keeps the transcript
/// readable while preserving the detail one tap away.
@available(iOS 17.0, *)
struct AgentToolResultErrorView: View {
    let code: String
    let message: String
    @State private var expanded: Bool = false

    var body: some View {
        let first = firstLine(message)
        let multi = message != first
        VStack(alignment: .leading, spacing: 0) {
            // Only the multi-line variant is interactive (tap to expand).
            // A single-line error is wrapped in no Button at all, rather
            // than a `.disabled` one — a disabled Button dims its label,
            // which washes the danger red toward the light pill fill in
            // light mode.
            if multi {
                Button { expanded.toggle() } label: { header(first: first, multi: multi) }
                    .buttonStyle(.plain)
            } else {
                header(first: first, multi: multi)
            }

            if expanded, multi {
                Text(message)
                    .font(Theme.monospace(size: 11))
                    .foregroundStyle(Theme.danger.opacity(0.95))
                    .lineLimit(nil)
                    .fixedSize(horizontal: false, vertical: true)
                    .textSelection(.enabled)
                    .padding(.top, 6)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, 8)
        .padding(.vertical, 4)
        .background(Theme.danger.opacity(0.08))
        .overlay(
            // Subtle left border instead of the previous bordered red
            // box. Matches portal's `.agent-tool-error` styling — read
            // as "warning" without shouting.
            HStack(spacing: 0) {
                Rectangle()
                    .fill(Theme.danger.opacity(0.45))
                    .frame(width: 2)
                Spacer()
            }
        )
        .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.small))
    }

    /// Collapsed header row: the error code, its first line, and (when
    /// the message spans multiple lines) the expand chevron.
    private func header(first: String, multi: Bool) -> some View {
        HStack(spacing: 8) {
            Text(code)
                .font(Theme.monospace(size: 11))
                .foregroundStyle(Theme.danger)
                .layoutPriority(1)
            Text(first)
                .font(.system(size: 12))
                .foregroundStyle(Theme.danger)
                .lineLimit(1)
                .truncationMode(.tail)
            Spacer(minLength: 4)
            if multi {
                Image(systemName: expanded ? "chevron.up" : "chevron.down")
                    .font(.system(size: 11, weight: .semibold))
                    .foregroundStyle(Theme.danger.opacity(0.9))
            }
        }
        .contentShape(Rectangle())
    }
}

/// First line of a string — anything up to (but not including) the
/// first newline. Used by the collapsed error/SQL summaries.
func firstLine(_ s: String) -> String {
    if let i = s.firstIndex(of: "\n") { return String(s[s.startIndex ..< i]) }
    return s
}

#if DEBUG
@available(iOS 17.0, *)
#Preview("AgentToolResult — trace_connections summary") {
    NavigationStack {
        ScrollView {
            AgentToolResultView(result: PreviewMocks.agentToolEventTrail)
                .padding()
        }
        .background(Theme.bgPrimary)
    }
    .environment(AppStore.preview())
    .preferredColorScheme(.dark)
}

@available(iOS 17.0, *)
#Preview("AgentToolResult — error") {
    NavigationStack {
        ScrollView {
            AgentToolResultView(result: .error(code: "sql_failed", message: "Parser Error: syntax error at or near \"FORM\""))
                .padding()
        }
        .background(Theme.bgPrimary)
    }
    .preferredColorScheme(.dark)
}

@available(iOS 17.0, *)
#Preview("AgentToolResult — multi-line binder error") {
    NavigationStack {
        ScrollView {
            AgentToolResultView(result: .error(
                code: "sql_failed",
                message: """
                Binder Error: Referenced column "metric_slug" not found in FROM clause!
                LINE 9:   AND metric_slug = 'heart_rate'
                              ^
                Candidate bindings: "metric", "slug", "metric_id"
                """
            ))
            .padding()
        }
        .background(Theme.bgPrimary)
    }
    .preferredColorScheme(.dark)
}

@available(iOS 17.0, *)
#Preview("AgentToolResult — unknown notice (demo)") {
    NavigationStack {
        ScrollView {
            AgentUnknownPartNotice(label: "tool result", kind: "trigger.upserted")
                .padding()
        }
        .background(Theme.bgPrimary)
    }
    .preferredColorScheme(.dark)
}

@available(iOS 17.0, *)
#Preview("AgentEventTrailSummary — truncated") {
    NavigationStack {
        ScrollView {
            AgentEventTrailSummary(eventCount: 42, truncated: true)
                .padding()
        }
        .background(Theme.bgPrimary)
    }
    .environment(AppStore.preview())
    .preferredColorScheme(.dark)
}
#endif
#endif
