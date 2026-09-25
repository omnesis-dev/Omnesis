// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation

// Vocabulary for the agent-transcript sections of the Answer detail: attempt
// titles, the tool calls one attempt renders, and the omitted-activity notes.
//
// Mirrors the portal's `PrivacyAgentTranscripts` (`exchange-detail.js`): every
// TOOL part renders through the shared static tool card, text/thinking parts
// are shown elsewhere (the draft card above carries the answer), and the
// citation tools stay silent once settled — the Timeline owns their payload.
//
// Deliberately free of SwiftUI so the titles, the skip rules, and the notes
// are unit testable in the sim-less logic lane.

/// One renderable tool call of a stored attempt: the `{tool,args,result}`
/// record the shared card reads, plus the part JSON itself behind the raw
/// affordance.
struct AgentTraceToolCall: Equatable, Sendable {
    let tool: String
    let record: JSONValue
    let rawPart: JSONValue
}

/// Tools whose settled results never render inline. The portal renders
/// nothing for these once the result lands (citations persist via the
/// Timeline); pending ones coalesce into a live "Citing N…" pill, a
/// live-stream affordance with no after-the-fact equivalent here.
private let agentTraceSilentTools: Set<String> = ["annotate", "cite_record", "annotate_many"]

/// Every TOOL call of an attempt that earns a shared card, in first-use
/// encounter order. Stored transcripts pair `tool_use`/`tool_result` parts by
/// `toolCallId` — the portal's `chatMessagesToTurns` does the same before its
/// transcript render — so a `tool_result` with no matching `tool_use` is
/// dropped like the portal drops orphan results. Non-tool parts (text,
/// thinking) are shown elsewhere; citation calls render nothing per the
/// portal, pending or settled; malformed parts — no object, no kind, no tool
/// call id — are skipped rather than rendered as anonymous cards.
func agentTraceToolCalls(_ trace: PrivacyAgentTrace) -> [AgentTraceToolCall] {
    var order: [String] = []
    var pending: [String: (tool: String, args: JSONValue?)] = [:]
    var results: [String: JSONValue] = [:]
    for message in trace.messages {
        guard message.role == "user" || message.role == "assistant" else { continue }
        for part in message.parts {
            guard case .object(let fields) = part,
                  case .string(let kind) = fields["kind"],
                  case .string(let toolCallId) = fields["toolCallId"],
                  !toolCallId.isEmpty
            else { continue }
            switch kind {
            case "tool_use":
                guard case .string(let tool) = fields["tool"], !tool.isEmpty else { continue }
                if pending[toolCallId] == nil {
                    pending[toolCallId] = (tool, fields["args"])
                    order.append(toolCallId)
                }
            case "tool_result":
                if results[toolCallId] == nil, let result = fields["result"] {
                    results[toolCallId] = result
                }
            default:
                continue
            }
        }
    }
    return order.compactMap { toolCallId in
        guard let use = pending[toolCallId], !agentTraceSilentTools.contains(use.tool) else { return nil }
        var record: [String: JSONValue] = ["tool": .string(use.tool)]
        if let args = use.args { record["args"] = args }
        if let result = results[toolCallId] { record["result"] = result }
        let paired: JSONValue = .object(record)
        return AgentTraceToolCall(tool: use.tool, record: paired, rawPart: paired)
    }
}

/// "Attempt N · provider / model", plus the terminal stop reason when the
/// gateway recorded one — the portal's attempt summary line verbatim.
func agentTraceAttemptTitle(_ trace: PrivacyAgentTrace) -> String {
    var title = "Attempt \(trace.attempt) · \(trace.provider) / \(trace.model)"
    if let reason = trace.terminalStopReason, !reason.isEmpty {
        title += " · \(reason)"
    }
    return title
}

/// The bounded-view note for attempts the projection omitted — the portal's
/// wording verbatim.
func agentTraceOmittedAttemptsNote(_ count: Int) -> String {
    count == 1
        ? "1 additional stored attempt could not be shown in this bounded view."
        : "\(count) additional stored attempts could not be shown in this bounded view."
}

/// The per-attempt incompleteness note — the portal's wording verbatim. Nil
/// when the attempt is complete.
func agentTraceTruncatedNote(_ trace: PrivacyAgentTrace) -> String? {
    guard trace.truncated else { return nil }
    if let omitted = trace.omittedParts, omitted > 0 {
        return omitted == 1
            ? "1 observable transcript part was omitted from this stored transcript."
            : "\(omitted) observable transcript parts were omitted from this stored transcript."
    }
    return "This stored transcript is incomplete; some activity could not be shown."
}
