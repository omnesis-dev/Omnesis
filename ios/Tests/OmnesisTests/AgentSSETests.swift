// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

@testable import Omnesis
import XCTest

/// SSE frame parser + `AgentEvent` Codable union tests.
///
/// Two layers exercised together:
///   - `SSEFrameParser` consumes raw bytes and emits one payload string
///     per blank-line frame boundary. Multi-line `data:` lines must be
///     joined with `\n` (SSE spec) — without that, JSON.parse fails for
///     pretty-printed payloads the gateway might emit.
///   - `AgentEvent`'s `Decodable` impl decodes a `{type, payload}`
///     envelope and dispatches to one of the typed payload structs.
///     Unknown `type` lands in `.unknown` (forward-compat); a known
///     type missing required fields surfaces a decoding error.
@available(iOS 17.0, *)
final class AgentSSETests: XCTestCase {
    // MARK: - SSEFrameParser

    func testSingleDataLine() {
        let raw = Data("data: {\"a\":1}\n\n".utf8)
        let frames = SSEFrameParser.parse(raw)
        XCTAssertEqual(frames, ["{\"a\":1}"])
    }

    /// SSE spec: multiple `data:` lines per frame join with `\n`. The
    /// gateway is free to pretty-print, so any pretty-printed payload
    /// (one key per line) would arrive across multiple `data:` lines.
    func testMultiLineDataLinesJoinWithNewline() {
        let lines: [String] = [
            "data: {",
            "data:   \"type\": \"agent.text.delta\",",
            "data:   \"payload\": {\"sessionId\":\"s1\",\"messageId\":\"m1\",\"delta\":\"hi\"}",
            "data: }",
            "",
            "",
        ]
        let raw = Data(lines.joined(separator: "\n").utf8)
        let frames = SSEFrameParser.parse(raw)
        XCTAssertEqual(frames.count, 1)
        XCTAssertTrue(frames[0].contains("\n"), "data lines must be joined with newlines")
        let parsed = try? JSONSerialization.jsonObject(with: Data(frames[0].utf8))
        let payload = parsed as? [String: Any]
        XCTAssertNotNil(payload, "joined payload must parse as JSON")
        let type = payload?["type"] as? String
        XCTAssertEqual(type, "agent.text.delta")
    }

    func testCommentLinesIgnored() {
        let raw = Data(": keepalive heartbeat\ndata: {\"x\":1}\n\n".utf8)
        XCTAssertEqual(SSEFrameParser.parse(raw), ["{\"x\":1}"])
    }

    func testCRLFTrimmed() {
        let raw = Data("data: {\"x\":2}\r\n\r\n".utf8)
        XCTAssertEqual(SSEFrameParser.parse(raw), ["{\"x\":2}"])
    }

    func testBlankLineWithoutDataYieldsNoFrame() {
        let raw = Data("\n\n".utf8)
        XCTAssertTrue(SSEFrameParser.parse(raw).isEmpty)
    }

    // MARK: - AgentEvent decoding

    private func decode(_ json: String) throws -> AgentEvent {
        try JSONDecoder().decode(AgentEvent.self, from: Data(json.utf8))
    }

    func testDecodesMessageStart() throws {
        let event = try decode(#"""
        {"type":"agent.message.start","payload":{"sessionId":"s1","messageId":"m1","role":"assistant"}}
        """#)
        guard case .messageStart(let s, let m) = event else {
            return XCTFail("expected .messageStart, got \(event)")
        }
        XCTAssertEqual(s, "s1")
        XCTAssertEqual(m, "m1")
    }

    func testDecodesTextDelta() throws {
        let event = try decode(#"""
        {"type":"agent.text.delta","payload":{"sessionId":"s1","messageId":"m1","delta":"hello"}}
        """#)
        guard case .textDelta(_, _, let delta) = event else {
            return XCTFail("expected .textDelta")
        }
        XCTAssertEqual(delta, "hello")
    }

    func testDecodesToolInputStart() throws {
        let event = try decode(#"""
        {"type":"agent.tool.input_start","payload":{"sessionId":"s","messageId":"m","toolCallId":"tu_1","tool":"run_sql"}}
        """#)
        guard case .toolInputStart(_, _, let id, let tool) = event else {
            return XCTFail("expected .toolInputStart")
        }
        XCTAssertEqual(id, "tu_1")
        XCTAssertEqual(tool, "run_sql")
    }

    func testDecodesToolStartWithArgsSummary() throws {
        let event = try decode(#"""
        {"type":"agent.tool.start","payload":{"sessionId":"s","messageId":"m","toolCallId":"tu_1","tool":"run_sql","args":{"sql":"SELECT 1"},"argsSummary":"SELECT 1"}}
        """#)
        guard case .toolStart(_, _, _, _, let args, let summary) = event else {
            return XCTFail("expected .toolStart")
        }
        XCTAssertEqual(summary, "SELECT 1")
        // Round-trip the args through JSONAny.
        XCTAssertTrue(args.jsonString.contains("SELECT 1"))
    }

    func testDecodesToolResult() throws {
        let event = try decode(#"""
        {"type":"agent.tool.result","payload":{"sessionId":"s","messageId":"m","toolCallId":"tu_1","result":{"kind":"error","code":"oops","message":"boom"},"durationMs":42}}
        """#)
        guard case .toolResult(_, _, _, let result, let dur) = event else {
            return XCTFail("expected .toolResult")
        }
        XCTAssertEqual(dur, 42)
        guard case .error(let code, _) = result else {
            return XCTFail("expected error result")
        }
        XCTAssertEqual(code, "oops")
    }

    func testDecodesMessageEndWithoutStopReasonDefaults() throws {
        // The payload schema mandates `stopReason`, but a tolerant
        // decode default keeps an older gateway from breaking the UI.
        let event = try decode(#"""
        {"type":"agent.message.end","payload":{"sessionId":"s","messageId":"m"}}
        """#)
        guard case .messageEnd(_, _, let reason, _) = event else {
            return XCTFail("expected .messageEnd")
        }
        XCTAssertEqual(reason, "end_turn")
    }

    func testDecodesAuthoritativeContextWindowFailure() throws {
        let event = try decode(#"""
        {
          "type":"agent.message.end",
          "payload":{
            "sessionId":"s",
            "messageId":"m",
            "stopReason":"error",
            "failure":{
              "code":"context_window_exceeded",
              "message":"This conversation no longer fits in the selected model's context window. Start a new conversation to continue.",
              "retryable":false,
              "backend":"openai-compatible",
              "model":"fictional-model"
            },
            "context":{
              "inputTokens":130000,
              "maxInputTokens":128000,
              "measurement":"provider_reported",
              "limitSource":"provider",
              "requestIteration":1
            }
          }
        }
        """#)

        guard case .contextWindowExceeded(_, _, let reason, let failure, let context) = event else {
            return XCTFail("expected .contextWindowExceeded")
        }
        XCTAssertEqual(reason, "error")
        XCTAssertEqual(failure.code, "context_window_exceeded")
        XCTAssertEqual(context?.inputTokens, 130_000)
        XCTAssertEqual(context?.maxInputTokens, 128_000)
        XCTAssertNil(context?.contextWindowTokens)
    }

    func testDecodesAuthoritativeOutputTruncation() throws {
        let event = try decode(#"""
        {
          "type":"agent.message.end",
          "payload":{
            "sessionId":"s",
            "messageId":"m",
            "stopReason":"max_tokens",
            "failure":{
              "code":"output_truncated",
              "message":"The model reached its output limit before completing this response.",
              "retryable":false,
              "backend":"openai-compatible",
              "model":"fictional-model"
            }
          }
        }
        """#)

        guard case .outputTruncated(_, _, let reason, let failure) = event else {
            return XCTFail("expected .outputTruncated")
        }
        XCTAssertEqual(reason, "max_tokens")
        XCTAssertEqual(failure.code, "output_truncated")
    }

    /// Forward-compat: an unknown `type` decodes into `.unknown(type:)`
    /// instead of failing — a future gateway can add new event types
    /// without breaking older iOS builds.
    func testUnknownEventTypeProducesUnknownCase() throws {
        let event = try decode(#"""
        {"type":"agent.future.event","payload":{"foo":"bar"}}
        """#)
        guard case .unknown(let type) = event else {
            return XCTFail("expected .unknown, got \(event)")
        }
        XCTAssertEqual(type, "agent.future.event")
    }

    // MARK: - Sub-agent events (#748)

    /// `agent.subagent.spawned` decodes into `.subagentSpawned` with the
    /// specialist + task + optional parent tool-call id.
    func testDecodesSubagentSpawned() throws {
        let event = try decode(#"""
        {"type":"agent.subagent.spawned","payload":{"sessionId":"s1","subagentId":"s1.sub.a","specialist":"history-sweep","task":"Find Q4 budget docs","parentToolCallId":"tu_spawn"}}
        """#)
        guard case .subagentSpawned(let session, let id, let spec, let task, _, let parent) = event else {
            return XCTFail("expected .subagentSpawned, got \(event)")
        }
        XCTAssertEqual(session, "s1")
        XCTAssertEqual(id, "s1.sub.a")
        XCTAssertEqual(spec, "history-sweep")
        XCTAssertEqual(task, "Find Q4 budget docs")
        XCTAssertEqual(parent, "tu_spawn")
    }

    /// `agent.subagent.event` decodes the WRAPPED child event one level of
    /// recursion into a full `AgentEvent` (here a child `text.delta`).
    func testDecodesSubagentEventWrappingChildEvent() throws {
        let event = try decode(#"""
        {"type":"agent.subagent.event","payload":{"sessionId":"s1","subagentId":"s1.sub.a","specialist":"history-sweep","event":{"type":"agent.text.delta","payload":{"sessionId":"s1.sub.a","messageId":"cm1","delta":"sweeping"}}}}
        """#)
        guard case .subagentEvent(_, let id, _, let child) = event else {
            return XCTFail("expected .subagentEvent, got \(event)")
        }
        XCTAssertEqual(id, "s1.sub.a")
        guard case .textDelta(let cs, _, let delta) = child else {
            return XCTFail("expected wrapped .textDelta, got \(child)")
        }
        // The wrapped event keeps the CHILD's session id, not the parent's.
        XCTAssertEqual(cs, "s1.sub.a")
        XCTAssertEqual(delta, "sweeping")
    }

    func testDecodesChildMessageEndUsageForLiveResearcherTokens() throws {
        let event = try decode(#"""
        {
          "type":"agent.subagent.event",
          "payload":{
            "sessionId":"s1",
            "subagentId":"s1.sub.a",
            "specialist":"history-sweep",
            "event":{
              "type":"agent.message.end",
              "payload":{
                "sessionId":"s1.sub.a",
                "messageId":"cm1",
                "stopReason":"tool_use",
                "usage":{
                  "inputTokens":800,
                  "outputTokens":200
                }
              }
            }
          }
        }
        """#)
        guard case .subagentEvent(_, _, _, let child) = event,
              case .messageEnd(_, _, _, let usage) = child else {
            return XCTFail("expected child message end")
        }
        XCTAssertEqual(usage?.total, 1000)
    }

    /// Graceful degrade: a wrapped child event whose `type` this build
    /// doesn't recognise still decodes — the outer `.subagentEvent` carries
    /// a `.unknown` inner event rather than throwing (the iOS analogue of
    /// Android's `AgentPart.Unknown`).
    func testDecodesSubagentEventWithUnknownWrappedChildDegrades() throws {
        let event = try decode(#"""
        {"type":"agent.subagent.event","payload":{"sessionId":"s1","subagentId":"s1.sub.a","specialist":"history-sweep","event":{"type":"agent.future.kind","payload":{"foo":"bar"}}}}
        """#)
        guard case .subagentEvent(_, _, _, let child) = event else {
            return XCTFail("expected .subagentEvent, got \(event)")
        }
        guard case .unknown(let t) = child else {
            return XCTFail("expected wrapped .unknown, got \(child)")
        }
        XCTAssertEqual(t, "agent.future.kind")
    }

    /// `agent.subagent.result` decodes terminal status + summary + the
    /// per-child `usage` and whole-tree `treeUsage` totals.
    func testDecodesSubagentResult() throws {
        let event = try decode(#"""
        {"type":"agent.subagent.result","payload":{
          "sessionId":"s1","subagentId":"s1.sub.a","specialist":"source-digest","status":"complete",
          "summary":"Events overspent 18%.",
          "citations":[{"documentId":"d1","sourceType":"gmail","sourceId":"gmail:me"}],
          "usage":{"inputTokens":1200,"outputTokens":340},
          "treeUsage":{"inputTokens":4000,"outputTokens":900}
        }}
        """#)
        guard case .subagentResult(_, let id, let spec, let status, let summary, let cites, let usage, let tree, _) = event else {
            return XCTFail("expected .subagentResult, got \(event)")
        }
        XCTAssertEqual(id, "s1.sub.a")
        XCTAssertEqual(spec, "source-digest")
        XCTAssertEqual(status, "complete")
        XCTAssertEqual(summary, "Events overspent 18%.")
        XCTAssertEqual(cites.count, 1)
        XCTAssertEqual(usage?.total, 1540)
        XCTAssertEqual(tree?.total, 4900)
    }

    /// A `subagent.result` from a backend that reports no token counts
    /// decodes with `nil` usage (so the reducer keeps its running tally).
    func testDecodesSubagentResultWithoutUsage() throws {
        let event = try decode(#"""
        {"type":"agent.subagent.result","payload":{"sessionId":"s1","subagentId":"s1.sub.a","specialist":"source-digest","status":"failed","summary":"no results","citations":[],"failure":{"code":"http_api_error","message":"HTTP model request failed.","retryable":true,"backend":"http","model":"fictional-model"}}}
        """#)
        guard case .subagentResult(_, _, _, let status, _, let cites, let usage, let tree, let failure) = event else {
            return XCTFail("expected .subagentResult")
        }
        XCTAssertEqual(status, "failed")
        XCTAssertTrue(cites.isEmpty)
        XCTAssertNil(usage)
        XCTAssertNil(tree)
        XCTAssertEqual(failure?.code, "http_api_error")
    }

    // MARK: - Deep Research summary (#748)

    /// `agent.deep_research.summary` decodes into `.deepResearchSummary` with
    /// the honest `stoppedReason`, the planner decomposition, the whole-tree
    /// token total, and the REAL quote-verification tally.
    func testDecodesDeepResearchSummary() throws {
        let event = try decode(#"""
        {"type":"agent.deep_research.summary","payload":{"sessionId":"s1","messageId":"m1","stoppedReason":"answer_complete","plan":[{"specialist":"history-sweep","task":"Find Q4 docs"},{"specialist":"source-digest","task":"Summarise"}],"treeUsage":{"inputTokens":9200,"outputTokens":2400},"verification":{"quotesChecked":3,"quotesVerified":3}}}
        """#)
        guard case .deepResearchSummary(let s, let m, let reason, let plan, let tree, let verification) = event else {
            return XCTFail("expected .deepResearchSummary, got \(event)")
        }
        XCTAssertEqual(s, "s1")
        XCTAssertEqual(m, "m1")
        XCTAssertEqual(reason, "answer_complete")
        XCTAssertEqual(plan.count, 2)
        XCTAssertEqual(plan.first?.specialist, "history-sweep")
        XCTAssertEqual(plan.first?.task, "Find Q4 docs")
        XCTAssertEqual(tree?.total, 11600)
        XCTAssertEqual(verification, AgentDeepResearchVerification(quotesChecked: 3, quotesVerified: 3))
    }

    /// A run that quoted nothing decodes a `0/0` tally and tolerates a missing
    /// `plan` / `treeUsage` (older / minimal payloads) — the badge then reads
    /// "No quotes to verify" rather than a misleading green tick.
    func testDecodesDeepResearchSummaryWithNoQuotesAndMinimalPayload() throws {
        let event = try decode(#"""
        {"type":"agent.deep_research.summary","payload":{"sessionId":"s1","messageId":"m1","stoppedReason":"no_results","verification":{"quotesChecked":0,"quotesVerified":0}}}
        """#)
        guard case .deepResearchSummary(_, _, let reason, let plan, let tree, let verification) = event else {
            return XCTFail("expected .deepResearchSummary, got \(event)")
        }
        XCTAssertEqual(reason, "no_results")
        XCTAssertTrue(plan.isEmpty, "absent plan decodes to empty, not a throw")
        XCTAssertNil(tree)
        XCTAssertEqual(verification.quotesChecked, 0)
        XCTAssertEqual(verification.quotesVerified, 0)
    }

    /// Forward-compat: a `stoppedReason` this build doesn't recognise still
    /// decodes because the wire reason is an open string on iOS.
    func testDecodesDeepResearchSummaryWithUnknownStoppedReason() throws {
        let event = try decode(#"""
        {"type":"agent.deep_research.summary","payload":{"sessionId":"s1","messageId":"m1","stoppedReason":"some_future_reason","verification":{"quotesChecked":1,"quotesVerified":1}}}
        """#)
        guard case .deepResearchSummary(_, _, let reason, _, _, _) = event else {
            return XCTFail("expected .deepResearchSummary, got \(event)")
        }
        XCTAssertEqual(reason, "some_future_reason")
    }

    func testDecodesPlanUpdatedResult() throws {
        // Mirrors the wire shape emitted by the gateway's `plan` tool —
        // the first snapshot of the birthday-gifts demo fixture, with
        // one in-progress row and two pending rows.
        let event = try decode(#"""
        {"type":"agent.tool.result","payload":{"sessionId":"s","messageId":"m","toolCallId":"tc_plan","durationMs":3,"result":{"kind":"plan.updated","items":[{"id":"p1","label":"Search Claire's messages","status":"in_progress"},{"id":"p2","label":"Check purchase history for duplicates","status":"pending"},{"id":"p3","label":"Summarize candidates","status":"pending"}]}}}
        """#)
        guard case .toolResult(_, _, _, let result, _) = event else {
            return XCTFail("expected .toolResult")
        }
        guard case .planUpdated(let items) = result else {
            return XCTFail("expected .planUpdated, got \(result)")
        }
        XCTAssertEqual(items.count, 3)
        XCTAssertEqual(items[0].id, "p1")
        XCTAssertEqual(items[0].status, .inProgress)
        XCTAssertEqual(items[1].status, .pending)
        XCTAssertEqual(items[2].status, .pending)
    }

    /// #757: an `event_trail.built` result carrying a record-only event
    /// (no `doc`) and a deduped doc+record event decodes natively into
    /// `AgentTrailEvent`s. Exercises the optional `doc`, the `record`
    /// payload, and the heterogeneous key-field `value` coercion
    /// (string / number / bool / null → display string).
    func testDecodesEventTrailWithRecordCitation() throws {
        let event = try decode(#"""
        {"type":"agent.tool.result","payload":{
          "sessionId":"s","messageId":"m","toolCallId":"tc_trail","durationMs":12,
          "result":{"kind":"event_trail.built","seeds":["d-ride"],"truncated":false,"events":[
          {"eventId":"rec:fitness_workouts/abc","at":"2026-04-20T07:12:00Z","kind":"record",
           "attachments":[],"people":[],"related":[],"record":{
             "recordKey":"rec:fitness_workouts/abc","table":"fitness_workouts","tableDisplayName":"Workouts",
             "title":"Morning run","keyFields":[{"label":"Distance","value":"5.2 km"},
               {"label":"Calories","value":412},{"label":"PR","value":true},{"label":"Notes","value":null}],
             "semanticTime":"2026-04-20T07:12:00Z","sourceId":"demo-fitness:athlete",
             "sourceType":"demo-fitness","boundDocumentId":null}},
          {"eventId":"d-ride","at":"2026-04-21T18:40:00Z","kind":"document",
           "attachments":[],"people":[],"related":[],"doc":{
             "documentId":"d-ride","title":"Evening ride","sourceId":"demo-fitness:athlete",
             "documentType":"activity"},"record":{"recordKey":"rec:fitness_workouts/def",
             "table":"fitness_workouts","tableDisplayName":"Workouts","title":"Evening ride",
             "keyFields":[{"label":"Distance","value":"24.8 km"}],
             "semanticTime":"2026-04-21T18:40:00Z","sourceId":"demo-fitness:athlete",
             "sourceType":"demo-fitness","boundDocumentId":"d-ride"}}
        ]}}}
        """#)
        guard case .toolResult(_, _, _, let result, _) = event else {
            return XCTFail("expected .toolResult")
        }
        guard case .eventTrailBuilt(_, let events, _, _) = result else {
            return XCTFail("expected .eventTrailBuilt, got \(result)")
        }
        XCTAssertEqual(events.count, 2)

        // Record-only event: no doc, carries the record + coerced fields.
        let recordOnly = events[0]
        XCTAssertNil(recordOnly.doc)
        XCTAssertEqual(recordOnly.eventSourceId, "demo-fitness:athlete")
        XCTAssertEqual(recordOnly.entityId, "rec:fitness_workouts/abc")
        let rec = try XCTUnwrap(recordOnly.record)
        XCTAssertEqual(rec.title, "Morning run")
        XCTAssertNil(rec.boundDocumentId)
        XCTAssertEqual(rec.keyFields.map(\.label), ["Distance", "Calories", "PR", "Notes"])
        XCTAssertEqual(rec.keyFields.map(\.value), ["5.2 km", "412", "true", nil])

        // Deduped doc+record event: both present, keyed by the doc id.
        let docRecord = events[1]
        XCTAssertEqual(docRecord.doc?.documentId, "d-ride")
        XCTAssertEqual(docRecord.entityId, "d-ride")
        XCTAssertEqual(docRecord.record?.boundDocumentId, "d-ride")
        XCTAssertEqual(docRecord.record?.keyFields.first?.value, "24.8 km")
    }

    /// #757: a `cite_record.recorded` tool result decodes into
    /// `.citeRecordRecorded`, lifting the result object straight into an
    /// `AgentTrailRecord`. The extra `primaryKeyColumns` / `snapshot`
    /// keys are ignored, and the heterogeneous key-field `value` shapes
    /// (string / number / bool / null) coerce to display strings.
    func testDecodesCiteRecordRecorded() throws {
        let event = try decode(#"""
        {"type":"agent.tool.result","payload":{"sessionId":"s","messageId":"m","toolCallId":"tc_cite","durationMs":4,"result":{
          "kind":"cite_record.recorded",
          "table":"demo_fitness.workouts",
          "recordKey":"demo_fitness.workouts/abc",
          "primaryKeyColumns":[{"name":"id","value":"abc","castType":"VARCHAR"}],
          "title":"Morning run",
          "keyFields":[{"label":"Distance","value":"5.2 km"},{"label":"Calories","value":412},{"label":"PR","value":true},{"label":"Notes","value":null}],
          "semanticTime":"2026-04-20T07:12:00Z",
          "snapshot":{"distance_km":5.2},
          "sourceId":"demo-fitness:athlete",
          "sourceType":"demo-fitness",
          "tableDisplayName":"Workouts",
          "boundDocumentId":null
        }}}
        """#)
        guard case .toolResult(_, _, _, let result, _) = event else {
            return XCTFail("expected .toolResult")
        }
        guard case .citeRecordRecorded(let record) = result else {
            return XCTFail("expected .citeRecordRecorded, got \(result)")
        }
        XCTAssertEqual(record.recordKey, "demo_fitness.workouts/abc")
        XCTAssertEqual(record.table, "demo_fitness.workouts")
        XCTAssertEqual(record.tableDisplayName, "Workouts")
        XCTAssertEqual(record.title, "Morning run")
        XCTAssertEqual(record.semanticTime, "2026-04-20T07:12:00Z")
        XCTAssertEqual(record.sourceId, "demo-fitness:athlete")
        XCTAssertEqual(record.sourceType, "demo-fitness")
        XCTAssertNil(record.boundDocumentId)
        XCTAssertEqual(record.keyFields.map(\.label), ["Distance", "Calories", "PR", "Notes"])
        XCTAssertEqual(record.keyFields.map(\.value), ["5.2 km", "412", "true", nil])
    }

    /// Unknown tool result `kind`s decode into `.unknown` (preserving
    /// the raw payload) rather than throwing, so a transcript with a
    /// future tool kind still loads on an older client. Round-trips
    /// losslessly so the iOS app can re-send / re-encode without
    /// dropping data.
    func testForwardCompatUnknownToolResultKindDecodesAndRoundTrips() throws {
        let raw = Data(#"""
        {"kind":"future.kind","arbitrary":"value","nested":{"n":1}}
        """#.utf8)
        let decoded = try JSONDecoder().decode(AgentToolResult.self, from: raw)
        guard case .unknown(let kind, let payload) = decoded else {
            return XCTFail("expected .unknown, got \(decoded)")
        }
        XCTAssertEqual(kind, "future.kind")
        // Round-trip: re-encode and decode again to confirm the raw
        // payload is preserved end-to-end.
        let reEncoded = try JSONEncoder().encode(decoded)
        let reDecoded = try JSONDecoder().decode(AgentToolResult.self, from: reEncoded)
        XCTAssertEqual(reDecoded, decoded)
        // Spot-check that the raw payload kept the unknown fields.
        XCTAssertTrue(payload.jsonString.contains("\"arbitrary\""))
    }

    /// The specific bug from the field: an iOS build that predates
    /// `trigger.upserted` should not fail when a stored transcript
    /// references it. The decoder must land it on `.unknown` so the
    /// surrounding conversation still loads.
    func testForwardCompatUnknownKindDoesNotThrow() {
        let raw = Data(#"""
        {"kind":"trigger.something_new","triggerId":"t1","name":"n"}
        """#.utf8)
        XCTAssertNoThrow(try JSONDecoder().decode(AgentToolResult.self, from: raw))
    }

    func testRoundTripsPlanUpdatedResult() throws {
        // Encode → decode round-trip exercises the symmetric Codable
        // impl on AgentToolResult.planUpdated so both directions stay
        // in sync. (Encoding only happens in tests / debug, but the
        // discipline of keeping it lossless matches the rest of the
        // wire types.)
        let original: AgentToolResult = .planUpdated(items: [
            AgentPlanItem(id: "p1", label: "Step one", status: .done),
            AgentPlanItem(id: "p2", label: "Step two", status: .inProgress),
            AgentPlanItem(id: "p3", label: "Step three", status: .pending),
        ])
        let encoded = try JSONEncoder().encode(original)
        let decoded = try JSONDecoder().decode(AgentToolResult.self, from: encoded)
        XCTAssertEqual(decoded, original)
    }

    /// Missing required field on a known type surfaces a clear
    /// decoding error rather than a silent fallback to `.unknown`.
    func testMissingRequiredFieldOnKnownTypeThrows() {
        // agent.text.delta requires `delta`; omit it.
        let raw = Data(#"""
        {"type":"agent.text.delta","payload":{"sessionId":"s","messageId":"m"}}
        """#.utf8)
        XCTAssertThrowsError(try JSONDecoder().decode(AgentEvent.self, from: raw)) { error in
            // Any DecodingError counts — we just want to see that it
            // didn't silently drop into a default-value path.
            XCTAssertTrue(error is DecodingError, "expected DecodingError, got \(error)")
        }
    }

    // MARK: - SSE `id:` plumbing (resume support)

    /// The parser surfaces the `id:` field alongside each frame's data so
    /// the supervisor can record a `Last-Event-ID` resume point.
    func testParseFramesExtractsId() {
        let raw = Data("id: 7\ndata: {\"x\":1}\n\n".utf8)
        let frames = SSEFrameParser.parseFrames(raw)
        XCTAssertEqual(frames.count, 1)
        XCTAssertEqual(frames[0].id, "7")
        XCTAssertEqual(frames[0].data, "{\"x\":1}")
    }

    /// SSE spec: the last seen `id:` persists across frames until changed,
    /// so a frame with no `id:` of its own inherits the previous one.
    func testIdPersistsAcrossFramesPerSpec() {
        let raw = Data("id: 3\ndata: {\"a\":1}\n\ndata: {\"b\":2}\n\n".utf8)
        let frames = SSEFrameParser.parseFrames(raw)
        XCTAssertEqual(frames.count, 2)
        XCTAssertEqual(frames[0].id, "3")
        XCTAssertEqual(frames[1].id, "3")
    }

    /// A heartbeat comment carries no data and no id; the following
    /// id+data frame is unaffected.
    func testHeartbeatBetweenFramesIgnored() {
        let raw = Data(": hb\n\nid: 5\ndata: {\"x\":1}\n\n".utf8)
        let frames = SSEFrameParser.parseFrames(raw)
        XCTAssertEqual(frames.count, 1)
        XCTAssertEqual(frames[0].id, "5")
        XCTAssertEqual(frames[0].data, "{\"x\":1}")
    }

    /// A frame with no preceding `id:` line surfaces a nil id — that's how
    /// the gateway's `agent.resync` control frame arrives on a fresh
    /// reconnect (it leads the stream, so no id has been seen yet).
    func testFrameWithoutIdHasNilId() {
        let raw = Data("data: {\"x\":1}\n\n".utf8)
        let frames = SSEFrameParser.parseFrames(raw)
        XCTAssertEqual(frames.count, 1)
        XCTAssertNil(frames[0].id)
    }

    /// The `agent.resync` control event decodes to `.resync` (no session).
    func testDecodesResyncEvent() throws {
        let event = try decode(#"{"type":"agent.resync","payload":{}}"#)
        guard case .resync = event else {
            return XCTFail("expected .resync, got \(event)")
        }
        XCTAssertEqual(event.sessionId, "")
    }

    // MARK: - ActivityClock (SSE idle watchdog)

    func testActivityClockTouchResetsIdle() async throws {
        let clock = ActivityClock()
        try await Task.sleep(nanoseconds: 60_000_000) // 60ms
        XCTAssertGreaterThan(clock.secondsSinceLast(), 0.03)
        clock.touch()
        XCTAssertLessThan(clock.secondsSinceLast(), 0.03)
    }

    // MARK: - AgentClient.events() end-to-end over a stubbed URLSession

    /// Drives the real `events()` byte loop against an in-process SSE
    /// stub: the `Last-Event-ID` request header is sent, and each frame's
    /// `id:` surfaces on the yielded `AgentStreamItem`.
    func testEventsStreamSendsLastEventIdAndSurfacesIds() async throws {
        StubSSEProtocol.reset()
        StubSSEProtocol.body = Data([
            "id: 8",
            "data: {\"type\":\"agent.text.delta\",\"payload\":{\"sessionId\":\"s1\",\"messageId\":\"m1\",\"delta\":\"hi\"}}",
            "",
            "id: 9",
            "data: {\"type\":\"agent.message.end\",\"payload\":{\"sessionId\":\"s1\",\"messageId\":\"m1\",\"stopReason\":\"end_turn\"}}",
            "",
            "",
        ].joined(separator: "\n").utf8)

        let client = makeStubClient()
        var items: [AgentStreamItem] = []
        for try await item in client.events(lastEventId: "7") {
            items.append(item)
        }

        XCTAssertEqual(StubSSEProtocol.lastEventIdHeader, "7")
        XCTAssertEqual(items.count, 2)
        XCTAssertEqual(items[0].id, "8")
        guard case .textDelta(_, _, let delta) = items[0].event else {
            return XCTFail("expected .textDelta, got \(items[0].event)")
        }
        XCTAssertEqual(delta, "hi")
        XCTAssertEqual(items[1].id, "9")
        guard case .messageEnd = items[1].event else {
            return XCTFail("expected .messageEnd, got \(items[1].event)")
        }
    }

    /// A lead `agent.resync` frame (the gateway's gap signal) decodes to
    /// `.resync` with a nil id, so the supervisor reconciles without
    /// advancing its resume point.
    func testEventsStreamDecodesLeadingResync() async throws {
        StubSSEProtocol.reset()
        StubSSEProtocol.body = Data("data: {\"type\":\"agent.resync\",\"payload\":{}}\n\n".utf8)
        let client = makeStubClient()
        var items: [AgentStreamItem] = []
        for try await item in client.events(lastEventId: "100") {
            items.append(item)
        }
        XCTAssertEqual(items.count, 1)
        XCTAssertNil(items[0].id)
        guard case .resync = items[0].event else {
            return XCTFail("expected .resync, got \(items[0].event)")
        }
    }

    private func makeStubClient() -> AgentClient {
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [StubSSEProtocol.self]
        let session = URLSession(configuration: config)
        return AgentClient(
            baseURL: URL(string: "https://stub.local")!,
            token: "test-token",
            session: session
        )
    }
}

/// In-process `URLProtocol` that serves a fixed SSE body and records the
/// `Last-Event-ID` request header, so `AgentClient.events()` can be driven
/// end-to-end without a live gateway.
final class StubSSEProtocol: URLProtocol {
    nonisolated(unsafe) static var body = Data()
    nonisolated(unsafe) static var lastEventIdHeader: String?
    private static let lock = NSLock()

    static func reset() {
        lock.lock()
        lastEventIdHeader = nil
        body = Data()
        lock.unlock()
    }

    // URLProtocol's overrides must be class funcs (they override class
    // methods), so `static` isn't possible here.
    // swiftlint:disable:next static_over_final_class
    override class func canInit(with _: URLRequest) -> Bool {
        true
    }

    // swiftlint:disable:next static_over_final_class
    override class func canonicalRequest(for request: URLRequest) -> URLRequest {
        request
    }

    override func startLoading() {
        Self.lock.lock()
        Self.lastEventIdHeader = request.value(forHTTPHeaderField: "Last-Event-ID")
        let payload = Self.body
        Self.lock.unlock()
        let response = HTTPURLResponse(
            url: request.url!,
            statusCode: 200,
            httpVersion: "HTTP/1.1",
            headerFields: ["Content-Type": "text/event-stream"]
        )!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: payload)
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}
}
