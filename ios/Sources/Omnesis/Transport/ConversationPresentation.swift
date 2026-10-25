// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation

extension AgentToolResult {
    var conversationClarification: ConversationClarification? {
        guard case .unknown(let kind, let raw) = self, kind == "structured",
              let object = raw.value as? [String: Any],
              object["resultType"] as? String == "conversation.clarification",
              let data = object["data"], JSONSerialization.isValidJSONObject(data),
              let encoded = try? JSONSerialization.data(withJSONObject: data),
              let question = try? JSONDecoder().decode(ConversationClarification.self, from: encoded),
              !question.id.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
              !question.question.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
              (2 ... 6).contains(question.choices.count),
              question.choices.allSatisfy({ !$0.label.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }) else { return nil }
        return question
    }

    var containsConversationFailure: Bool {
        switch self {
        case .error(let code, _): !["turn_aborted", "canceled"].contains(code)
        case .searchBatch(let items), .documentBatch(let items), .annotateBatch(let items):
            items.contains(where: \.containsConversationFailure)
        default: false
        }
    }
}

/// Presentation only: the canonical transcript remains intact for history and
/// clients that do not render clarification controls.
@available(iOS 17.0, *)
func conversationPresentedParts(
    _ parts: [AgentPart], controls: ConversationControls?, activityDismissed: Bool = false, dismissedToolCallIds: Set<String> = []
)
    -> [AgentPart] {
    var questionPresented = false
    return parts.map { part in
        guard case .tool(var call) = part,
              activityDismissed || dismissedToolCallIds.contains(call.toolCallId),
              agentBatchTools.contains(call.tool) else { return part }
        call.children = agentBatchChildCalls(for: call).enumerated().compactMap { index, child in
            guard child.result?.containsConversationFailure == true else { return nil }
            let childIndex = call.children.isEmpty ? index : call.children[index].index
            return AgentToolChild(index: childIndex, tool: child.tool, argsSummary: child.argsSummary, result: child.result)
        }
        return .tool(call)
    }
    .filter { part in
        switch part {
        case .tool(let call):
            if controls != nil, call.tool == "ask_clarification", let question = call.result?.conversationClarification {
                if question.id == controls?.pendingClarification?.id { questionPresented = true }
                return false
            }
            let transient = agentEphemeralTools.contains(call.tool) || ["annotate", "annotate_many"].contains(call.tool)
            if activityDismissed || dismissedToolCallIds.contains(call.toolCallId), transient,
               call.result?.containsConversationFailure != true,
               !call.children.contains(where: { $0.result?.containsConversationFailure == true }) {
                return false
            }
            return true
        case .subagent(let card):
            let failed = card.status == "failed" && !["turn_aborted", "canceled"].contains(card.failureCode ?? "")
            return !activityDismissed || failed || card.status == "budget_exhausted"
        case .text: return !questionPresented
        case .thinking: return !activityDismissed
        default: return true
        }
    }
}

/// Late activity from an interrupted assistant message stays dismissed even
/// after the next queued user message starts a new turn.
struct ConversationActivityDismissal {
    private(set) var messageIds: Set<String> = []
    private(set) var toolCallIds: Set<String> = []
    private var awaitingUserMessage = false

    mutating func begin(messageIds: [String], toolCallIds: [String] = []) {
        self.toolCallIds.formUnion(toolCallIds)
        self.messageIds.formUnion(messageIds)
        awaitingUserMessage = true
    }

    func dismissesSpawn(parentToolCallId: String?) -> Bool {
        awaitingUserMessage || parentToolCallId.map(toolCallIds.contains) == true
    }

    func contains(_ event: AgentEvent) -> Bool {
        switch event {
        case .textDelta(_, let id, _), .thinkingDelta(_, let id, _),
             .toolInputStart(_, let id, _, _), .toolStart(_, let id, _, _, _, _),
             .toolResult(_, let id, _, _, _), .toolChildStart(_, let id, _, _, _, _),
             .toolChildResult(_, let id, _, _, _): messageIds.contains(id)
        default: false
        }
    }

    mutating func requestFailed() {
        awaitingUserMessage = false
    }

    mutating func observe(_ event: AgentEvent) {
        switch event {
        case .userMessage: awaitingUserMessage = false
        case .messageStart(_, let id) where awaitingUserMessage: messageIds.insert(id)
        case .toolInputStart(_, let messageId, let callId, _),
             .toolStart(_, let messageId, let callId, _, _, _),
             .toolResult(_, let messageId, let callId, _, _),
             .toolChildStart(_, let messageId, let callId, _, _, _),
             .toolChildResult(_, let messageId, let callId, _, _):
            if toolCallIds.contains(callId) { messageIds.insert(messageId) }
            if messageIds.contains(messageId) { toolCallIds.insert(callId) }
        default: break
        }
    }
}
