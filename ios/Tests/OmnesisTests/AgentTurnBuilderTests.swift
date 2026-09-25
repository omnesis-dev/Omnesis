// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

@testable import Omnesis
import XCTest

/// Covers the canonical history → portal-shape conversion done by
/// `AgentTurnBuilder.turns`. The interesting edge cases are around how
/// `user` messages interact with the assistant turn currently being
/// folded: a user message with only tool_result parts must fold into
/// the assistant; one with only text starts a fresh turn; one carrying
/// BOTH (tool_results followed by a text part — the model's intermediate
/// outputs immediately preceding the next user prompt) must fold the
/// tool_results into the assistant turn AND then start a new user turn
/// with the text. The earlier implementation only `break`ed the inner
/// switch on the text branch, which dropped the tool_results that
/// shared the same user message.
@available(iOS 17.0, *)
final class AgentTurnBuilderTests: XCTestCase {
    private func sql(_ query: String) -> JSONAny {
        JSONAny(value: ["sql": query] as [String: Any])
    }

    private func toolErr(_ code: String, _ msg: String) -> AgentToolResult {
        .error(code: code, message: msg)
    }

    /// A user message that contains BOTH a tool_result part AND a text
    /// part: the tool_result must land on the preceding assistant turn,
    /// and the text must seed a fresh `.user(...)` turn after it.
    func testUserMessageWithBothToolResultAndTextFoldsAndStartsNewTurn() {
        // Uses `triggers_list` (non-ephemeral) so the folded tool part
        // survives the rebuild — the ephemeral tools (search / fetch /
        // run_sql / trace_connections) are intentionally dropped on resume;
        // see testEphemeralToolUsesDroppedFromHistory.
        let messages: [ChatMessage] = [
            .user(parts: [.text("how has my HR been?")]),
            .assistant(parts: [
                .text("Let me check."),
                .toolUse(
                    toolCallId: "tu_1",
                    tool: "triggers_list",
                    args: JSONAny(value: ["enabledOnly": true] as [String: Any])
                ),
            ]),
            .user(parts: [
                .toolResult(toolCallId: "tu_1", result: toolErr("oops", "boom")),
                .text("nevermind, also what about resting HR?"),
            ]),
        ]

        let turns = AgentTurnBuilder.turns(from: messages)

        XCTAssertEqual(turns.count, 3, "expected user → assistant(with tool_result) → user")

        // First turn: the initial user prompt.
        guard case .user(_, let firstText) = turns[0] else {
            return XCTFail("turn[0] should be .user, got \(turns[0])")
        }
        XCTAssertEqual(firstText, "how has my HR been?")

        // Second turn: the assistant with the tool call AND the
        // folded-in tool result (this is the bug the fix targets).
        guard case .assistant(let assistant) = turns[1] else {
            return XCTFail("turn[1] should be .assistant, got \(turns[1])")
        }
        XCTAssertEqual(assistant.parts.count, 2, "should have text + tool parts")
        guard case .tool(let call) = assistant.parts.last else {
            return XCTFail("last part should be .tool")
        }
        XCTAssertEqual(call.toolCallId, "tu_1")
        XCTAssertNotNil(call.result, "tool_result must be folded into the assistant turn")
        if case .error(let code, _) = call.result {
            XCTAssertEqual(code, "oops")
        } else {
            XCTFail("expected error result, got \(String(describing: call.result))")
        }

        // Third turn: a fresh user turn from the trailing text part.
        guard case .user(_, let thirdText) = turns[2] else {
            return XCTFail("turn[2] should be .user, got \(turns[2])")
        }
        XCTAssertEqual(thirdText, "nevermind, also what about resting HR?")
    }

    /// A user message with only a tool_result (no text) folds into the
    /// assistant turn and does NOT start a new user turn.
    func testUserMessageWithOnlyToolResultFoldsInPlace() {
        let messages: [ChatMessage] = [
            .user(parts: [.text("find the contract")]),
            .assistant(parts: [
                .toolUse(
                    toolCallId: "tu_list",
                    tool: "triggers_list",
                    args: JSONAny(value: ["enabledOnly": true] as [String: Any])
                ),
            ]),
            .user(parts: [
                .toolResult(toolCallId: "tu_list", result: toolErr("not_found", "no docs")),
            ]),
            .assistant(parts: [.text("Nothing matched.")]),
        ]

        let turns = AgentTurnBuilder.turns(from: messages)

        XCTAssertEqual(turns.count, 2, "expected user → assistant")
        guard case .assistant(let assistant) = turns[1] else {
            return XCTFail("turn[1] should be .assistant")
        }
        XCTAssertEqual(assistant.parts.count, 2, "tool call + trailing text")
        guard case .tool(let call) = assistant.parts.first else {
            return XCTFail("first part should be the tool call")
        }
        XCTAssertNotNil(call.result)
        guard case .text(let trailing) = assistant.parts.last else {
            return XCTFail("trailing part should be the assistant's text")
        }
        XCTAssertEqual(trailing, "Nothing matched.")
    }

    /// A user message with only text (no tool_result) starts a fresh
    /// user turn and does not touch the prior assistant.
    func testUserMessageWithOnlyTextStartsFreshTurn() {
        let messages: [ChatMessage] = [
            .user(parts: [.text("first")]),
            .assistant(parts: [.text("ack")]),
            .user(parts: [.text("second")]),
            .assistant(parts: [.text("ack 2")]),
        ]

        let turns = AgentTurnBuilder.turns(from: messages)

        XCTAssertEqual(turns.count, 4)
        guard case .user(_, let firstText) = turns[0],
              case .assistant(let firstAssistant) = turns[1],
              case .user(_, let secondText) = turns[2],
              case .assistant(let secondAssistant) = turns[3]
        else {
            return XCTFail("unexpected turn shape: \(turns)")
        }
        XCTAssertEqual(firstText, "first")
        XCTAssertEqual(secondText, "second")
        XCTAssertEqual(firstAssistant.parts.count, 1)
        XCTAssertEqual(secondAssistant.parts.count, 1)
    }

    /// A `tool_use` part reconstructed from persisted history must land
    /// in the "finalized" state — `argsKnown == true` with a populated
    /// `argsSummary`. The args were fully known at persist time, so a
    /// resumed conversation must not render the pending-args label that
    /// the live `input_start` stub uses while the model is still
    /// streaming the JSON.
    func testResumedToolUseHasKnownArgsAndSummary() {
        // `triggers_list` is non-ephemeral, so its tool_use survives the
        // resume rebuild. Asserts the resumed-args-known / summary-populated
        // contract for any tool that lands in the rebuilt transcript; the
        // per-tool summary formatting is covered by
        // testSummarizeArgsEventTrailFormat.
        let messages: [ChatMessage] = [
            .user(parts: [.text("which triggers are on?")]),
            .assistant(parts: [
                .toolUse(
                    toolCallId: "tu_list",
                    tool: "triggers_list",
                    args: JSONAny(value: ["enabledOnly": true] as [String: Any])
                ),
            ]),
            .user(parts: [
                .toolResult(toolCallId: "tu_list", result: toolErr("ok", "done")),
            ]),
        ]

        let turns = AgentTurnBuilder.turns(from: messages)

        XCTAssertEqual(turns.count, 2)
        guard case .assistant(let assistant) = turns[1] else {
            return XCTFail("turn[1] should be .assistant, got \(turns[1])")
        }
        guard case .tool(let call) = assistant.parts.first else {
            return XCTFail("first part should be the resumed tool call")
        }
        XCTAssertTrue(call.argsKnown, "resumed tool_use must not appear pending")
        XCTAssertFalse(call.argsSummary.isEmpty, "argsSummary must be populated on resume")
    }

    /// `plan` is a panel-only tool — its tool_use / tool_result pairs
    /// must NOT show up in the rebuilt transcript when a saved
    /// conversation is reloaded. The TODO panel is intentionally
    /// transient: only live `plan.updated` snapshots drive it.
    func testPlanToolUseDroppedFromHistory() {
        let messages: [ChatMessage] = [
            .user(parts: [.text("birthday gifts for Claire")]),
            .assistant(parts: [
                .toolUse(
                    toolCallId: "tu_plan",
                    tool: "plan",
                    args: JSONAny(value: ["add": ["A", "B"]] as [String: Any])
                ),
                .text("Working on a plan."),
            ]),
            .user(parts: [
                .toolResult(toolCallId: "tu_plan", result: toolErr("ok", "")),
            ]),
            .assistant(parts: [.text("Here's what I found.")]),
        ]

        let turns = AgentTurnBuilder.turns(from: messages)

        XCTAssertEqual(turns.count, 2, "expected user → single folded assistant turn")
        guard case .assistant(let assistant) = turns[1] else {
            return XCTFail("turn[1] should be .assistant, got \(turns[1])")
        }
        // Only the two text parts should remain — the plan tool_use
        // (and therefore its folded tool_result slot) is dropped.
        XCTAssertEqual(assistant.parts.count, 2)
        for part in assistant.parts {
            if case .tool = part {
                XCTFail("plan tool calls must be dropped from rebuilt history")
            }
        }
    }

    /// Multiple successive tool calls in one assistant turn each get
    /// their result folded in from a subsequent user message.
    func testMultipleToolCallsFoldedFromOneUserMessage() {
        let messages: [ChatMessage] = [
            .user(parts: [.text("dig in")]),
            .assistant(parts: [
                .toolUse(
                    toolCallId: "tu_a",
                    tool: "triggers_list",
                    args: JSONAny(value: ["enabledOnly": true] as [String: Any])
                ),
                .toolUse(
                    toolCallId: "tu_b",
                    tool: "trigger_get",
                    args: JSONAny(value: ["triggerId": "tr-b"] as [String: Any])
                ),
            ]),
            .user(parts: [
                .toolResult(toolCallId: "tu_a", result: toolErr("a", "msg_a")),
                .toolResult(toolCallId: "tu_b", result: toolErr("b", "msg_b")),
            ]),
        ]

        let turns = AgentTurnBuilder.turns(from: messages)

        XCTAssertEqual(turns.count, 2)
        guard case .assistant(let assistant) = turns[1] else {
            return XCTFail("turn[1] should be .assistant")
        }
        XCTAssertEqual(assistant.parts.count, 2)
        for part in assistant.parts {
            guard case .tool(let call) = part else { return XCTFail("expected tool part") }
            XCTAssertNotNil(call.result, "every tool call should have its result folded in")
        }
    }

    /// Thinking parts are a transient live-stream indicator (like the
    /// ephemeral tool cards) — they must never reappear when a past
    /// conversation is reopened. The builder drops them on rebuild.
    func testThinkingPartsDroppedFromHistory() {
        let messages: [ChatMessage] = [
            .user(parts: [.text("who handled the Q4 audit?")]),
            .assistant(parts: [
                .thinking("Let me search the engagement letter, then check the invoice dates."),
                .text("Studio Northstar handled it."),
            ]),
        ]

        let turns = AgentTurnBuilder.turns(from: messages)

        XCTAssertEqual(turns.count, 2, "expected user → assistant")
        guard case .assistant(let assistant) = turns[1] else {
            return XCTFail("turn[1] should be .assistant, got \(turns[1])")
        }
        for part in assistant.parts {
            if case .thinking = part {
                return XCTFail("thinking parts must be dropped from rebuilt history")
            }
        }
        XCTAssertTrue(
            assistant.parts.contains { part in
                if case .text(let s) = part { return s == "Studio Northstar handled it." }
                return false
            },
            "the answer text must survive the rebuild"
        )
    }

    /// Ephemeral tools — `search_documents`, `fetch_document`,
    /// `run_sql` — are intentionally dropped when rebuilding the
    /// transcript from history. Their rolling-slot animations would
    /// otherwise replay on every resume, making old conversations
    /// look like the agent is re-doing the work. The canonical
    /// server-side history (the ConversationStore JSON record) is
    /// untouched; only the iOS-side UI reconstruction filters them.
    func testEphemeralToolUsesDroppedFromHistory() {
        let messages: [ChatMessage] = [
            .user(parts: [.text("birthday gifts for Claire")]),
            .assistant(parts: [
                .text("On it."),
                .toolUse(
                    toolCallId: "tu_search",
                    tool: "search_documents",
                    args: JSONAny(value: ["query": "Claire gifts"] as [String: Any])
                ),
                .toolUse(
                    toolCallId: "tu_fetch",
                    tool: "fetch_document",
                    args: JSONAny(value: ["documentId": "doc-1"] as [String: Any])
                ),
                .toolUse(
                    toolCallId: "tu_sql",
                    tool: "run_sql",
                    args: sql("SELECT 1")
                ),
                .toolUse(
                    toolCallId: "tu_spawn",
                    tool: "spawn_subagent",
                    args: JSONAny(value: ["task": "Compare two periods"])
                ),
                .toolUse(
                    toolCallId: "tu_join",
                    tool: "join_subagents",
                    args: JSONAny(value: ["subagentIds": ["sub-1"]])
                ),
            ]),
            .user(parts: [
                .toolResult(toolCallId: "tu_search", result: toolErr("ok", "")),
                .toolResult(toolCallId: "tu_fetch", result: toolErr("ok", "")),
                .toolResult(toolCallId: "tu_sql", result: toolErr("ok", "")),
                .toolResult(toolCallId: "tu_spawn", result: toolErr("ok", "")),
                .toolResult(toolCallId: "tu_join", result: toolErr("ok", "")),
            ]),
            .assistant(parts: [.text("Here's what I found.")]),
        ]

        let turns = AgentTurnBuilder.turns(from: messages)

        XCTAssertEqual(turns.count, 2, "expected user → single folded assistant turn")
        guard case .assistant(let assistant) = turns[1] else {
            return XCTFail("turn[1] should be .assistant, got \(turns[1])")
        }
        // Ephemeral retrieval/launch tools and invisible join orchestration
        // are gone — only the two
        // text parts ("On it." and "Here's what I found.") remain.
        XCTAssertEqual(assistant.parts.count, 2)
        for part in assistant.parts {
            if case .tool = part {
                XCTFail("ephemeral tool calls must be dropped from rebuilt history")
            }
        }
    }

    // MARK: - Forward-compat

    /// A transcript carrying a tool_result `kind` this build doesn't
    /// know about (the canonical case: a gateway shipped a new tool
    /// after the iOS app was last updated) must still load. The
    /// unknown result lands on its tool call as `.unknown(kind, raw)`
    /// so the AgentToolResultView can decide what to show.
    func testUnknownToolResultKindFoldsAsUnknown() throws {
        // Construct the JSON directly — the iOS enum doesn't expose
        // the unknown kind we want to simulate, but the decoder has
        // to accept it.
        let raw = Data(#"""
        {
          "id": "c-1",
          "callerId": "caller",
          "model": "m",
          "backend": "b",
          "createdAt": "t",
          "updatedAt": "t",
          "title": "t",
          "messages": [
            {"role":"user","parts":[{"kind":"text","text":"q"}]},
            {"role":"assistant","parts":[
              {"kind":"tool_use","toolCallId":"tu_1","tool":"future_tool","args":{}}
            ]},
            {"role":"user","parts":[
              {"kind":"tool_result","toolCallId":"tu_1","result":{"kind":"future.kind","extra":"hi"}}
            ]}
          ]
        }
        """#.utf8)
        let record = try JSONDecoder().decode(ConversationRecord.self, from: raw)
        let turns = AgentTurnBuilder.turns(from: record.messages)
        XCTAssertEqual(turns.count, 2)
        guard case .assistant(let assistant) = turns[1] else {
            return XCTFail("turn[1] should be .assistant")
        }
        guard case .tool(let call) = assistant.parts.first else {
            return XCTFail("expected one tool part")
        }
        XCTAssertEqual(call.tool, "future_tool")
        guard case .unknown(let kind, _) = call.result else {
            return XCTFail("expected .unknown tool result, got \(String(describing: call.result))")
        }
        XCTAssertEqual(kind, "future.kind")
    }

    /// A whole transcript that includes a future assistant part kind
    /// (`{"kind":"image","src":"..."}` say) must still decode and walk.
    /// The unknown part lands as an `AgentPart.unknown` placeholder.
    func testUnknownAssistantPartKindSurfacesAsPlaceholder() throws {
        let raw = Data(#"""
        {
          "id":"c-2","callerId":"c","model":"m","backend":"b",
          "createdAt":"t","updatedAt":"t","title":"t",
          "messages":[
            {"role":"user","parts":[{"kind":"text","text":"hi"}]},
            {"role":"assistant","parts":[
              {"kind":"text","text":"sure"},
              {"kind":"image","src":"https://example/x.png"}
            ]}
          ]
        }
        """#.utf8)
        let record = try JSONDecoder().decode(ConversationRecord.self, from: raw)
        let turns = AgentTurnBuilder.turns(from: record.messages)
        guard case .assistant(let assistant) = turns[1] else {
            return XCTFail("turn[1] should be .assistant")
        }
        let unknowns = assistant.parts.filter {
            if case .unknown = $0 { true } else { false }
        }
        XCTAssertEqual(unknowns.count, 1, "image part should fold as one .unknown")
        if case .unknown(_, let kind) = unknowns.first {
            XCTAssertEqual(kind, "image")
        }
    }

    /// A whole-message role this build doesn't know surfaces as a
    /// synthetic assistant turn with a single .unknown part — so the
    /// surrounding transcript stays loadable instead of throwing.
    func testUnknownChatMessageRoleSurfacesAsSyntheticTurn() throws {
        let raw = Data(#"""
        {
          "id":"c-3","callerId":"c","model":"m","backend":"b",
          "createdAt":"t","updatedAt":"t","title":"t",
          "messages":[
            {"role":"user","parts":[{"kind":"text","text":"hi"}]},
            {"role":"system","note":"something new"},
            {"role":"assistant","parts":[{"kind":"text","text":"ok"}]}
          ]
        }
        """#.utf8)
        let record = try JSONDecoder().decode(ConversationRecord.self, from: raw)
        XCTAssertEqual(record.messages.count, 3)
        let turns = AgentTurnBuilder.turns(from: record.messages)
        XCTAssertEqual(turns.count, 3, "user → unknown role bubble → assistant")
        guard case .assistant(let placeholder) = turns[1] else {
            return XCTFail("turn[1] should be the synthetic assistant bubble for the unknown role")
        }
        XCTAssertEqual(placeholder.parts.count, 1)
        if case .unknown(_, let kind) = placeholder.parts.first {
            XCTAssertEqual(kind, "system")
        } else {
            XCTFail("expected .unknown part for the unknown role")
        }
    }

    // MARK: - summarizeArgs

    /// `trace_connections` is dropped from rebuilt transcripts (it's
    /// ephemeral), but its summary is still rendered on the live in-flight
    /// card, so the `summarizeArgs` formatting stays under test here
    /// directly: the first seed truncated to 8 chars plus the depth.
    func testSummarizeArgsTraceConnectionsFormat() {
        let summary = AgentTurnBuilder.summarizeArgs(
            tool: "trace_connections",
            args: JSONAny(value: [
                "seedIds": ["doc-abcdef12"],
                "depth": 2,
            ] as [String: Any])
        )
        XCTAssertEqual(summary, "doc-abcd depth=2")
    }

    /// Guard: the fold/resume tests above rely on `triggers_list` and
    /// `trigger_get` surviving the rebuild. If either is ever reclassified
    /// into `agentEphemeralTools` those tests would silently start dropping
    /// the tool — fail loudly here instead, pointing at the cause.
    func testFoldTestsToolStaysNonEphemeral() {
        XCTAssertFalse(
            agentEphemeralTools.contains("triggers_list"),
            "fold/resume tests assume triggers_list is non-ephemeral"
        )
        XCTAssertFalse(
            agentEphemeralTools.contains("trigger_get"),
            "fold/resume tests assume trigger_get is non-ephemeral"
        )
    }

    // MARK: - Deep Research report_artifact rebuild on resume

    /// The persisted `report_artifact` assistant part decodes from the literal
    /// wire string the gateway writes — the structured facts plus the merged
    /// citation set. A strict/non-tolerant decode here would discard the part
    /// (or throw), so the reloaded conversation would silently lose its card.
    func testReportArtifactPartDecodesFromWire() throws {
        let json = #"""
        {"role":"assistant","parts":[
          {"kind":"text","text":"## Findings\nThe charge was a hotel booking."},
          {"kind":"report_artifact",
           "stoppedReason":"answer_complete",
           "plan":[{"specialist":"history-sweep","task":"Find the charge"}],
           "treeUsage":{"inputTokens":7200,"outputTokens":2100},
           "verification":{"quotesChecked":3,"quotesVerified":3},
           "citations":[{"documentId":"d1","sourceType":"enable-banking-accounts","sourceId":"enable-banking-accounts:self","title":"Tokyo Riverside Hotel"}]}
        ]}
        """#
        let message = try JSONDecoder().decode(ChatMessage.self, from: Data(json.utf8))
        guard case .assistant(let parts) = message else {
            return XCTFail("expected .assistant, got \(message)")
        }
        guard case .reportArtifact(let artifact) = parts.last else {
            return XCTFail("expected trailing .reportArtifact, got \(String(describing: parts.last))")
        }
        XCTAssertEqual(artifact.stoppedReason, "answer_complete")
        XCTAssertEqual(artifact.plan.map(\.specialist), ["history-sweep"])
        XCTAssertEqual(artifact.treeUsage?.total, 9300)
        XCTAssertEqual(artifact.verification.quotesChecked, 3)
        XCTAssertEqual(artifact.verification.quotesVerified, 3)
        XCTAssertEqual(artifact.citations.map(\.documentId), ["d1"])
    }

    /// `turns(from:)` retains structured summary metadata on the named turn;
    /// the persisted part itself is not emitted as a render slot.
    func testTurnsRebuildReportArtifactFromPersistedPart() {
        let messages: [ChatMessage] = [
            .user(parts: [.text("what was that bank charge?")]),
            .assistant(parts: [
                .text("It was a hotel booking."),
                .reportArtifact(AgentReportArtifactPart(
                    stoppedReason: "answer_complete",
                    plan: [AgentDeepResearchPlanItem(specialist: "history-sweep", task: "Find the charge")],
                    treeUsage: AgentUsage(inputTokens: 7000, outputTokens: 2000),
                    verification: AgentDeepResearchVerification(quotesChecked: 2, quotesVerified: 2),
                    citations: [
                        AgentDocRef(
                            documentId: "d1",
                            sourceType: "enable-banking-accounts",
                            sourceId: "enable-banking-accounts:self",
                            title: "Tokyo Riverside Hotel"
                        ),
                    ]
                )),
            ]),
        ]

        let turns = AgentTurnBuilder.turns(from: messages)
        guard case .assistant(let assistant) = turns.last else {
            return XCTFail("expected trailing assistant turn, got \(String(describing: turns.last))")
        }
        XCTAssertEqual(assistant.reportArtifact?.stoppedReason, "answer_complete")
        XCTAssertEqual(assistant.reportArtifact?.verification.quotesVerified, 2)
        XCTAssertEqual(assistant.reportArtifact?.treeUsage?.total, 9000)
        XCTAssertTrue(
            assistant.parts.allSatisfy { if case .text = $0 { true } else { false } },
            "report_artifact is rebuilt onto the turn, not emitted as a part"
        )
    }

    /// A deep-research run cites via the merged artifact set, NOT via `annotate`
    /// pairs — so `reportArtifactCitations(from:)` seeds the resumed citation
    /// drawer, deduped by documentId.
    func testReportArtifactCitationsSeedFromPersistedPart() {
        let messages: [ChatMessage] = [
            .user(parts: [.text("q")]),
            .assistant(parts: [
                .text("answer"),
                .reportArtifact(AgentReportArtifactPart(
                    stoppedReason: "answer_complete",
                    plan: [],
                    treeUsage: nil,
                    verification: AgentDeepResearchVerification(quotesChecked: 0, quotesVerified: 0),
                    citations: [
                        AgentDocRef(documentId: "d1", sourceType: "gmail", sourceId: "gmail:me", title: "Deck"),
                        AgentDocRef(documentId: "d2", sourceType: "whatsapp", sourceId: "whatsapp:me", title: "Thread"),
                        // Duplicate documentId — must collapse.
                        AgentDocRef(documentId: "d1", sourceType: "gmail", sourceId: "gmail:me", title: "Deck"),
                    ]
                )),
            ]),
        ]

        // No `annotate` pairs in this transcript → the plain citation walk finds none.
        XCTAssertTrue(AgentTurnBuilder.citations(from: messages).isEmpty)
        // The artifact citations seed the set, deduped.
        let seeds = AgentTurnBuilder.reportArtifactCitations(from: messages)
        XCTAssertEqual(seeds.map(\.documentId), ["d1", "d2"])
        XCTAssertEqual(seeds.first?.title, "Deck")
    }
}
