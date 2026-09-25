// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

@testable import Omnesis
import XCTest

/// The Direct audit wording: session labels and the payload text behind each
/// card's raw-JSON affordance. There are no outcome chips — only failures
/// speak, through the shared error card.
final class PrivacyDirectPresentationTests: XCTestCase {
    private func session(explicitKey: String?, principalName: String? = nil) -> DirectAuditSessionSummary {
        DirectAuditSessionSummary(
            id: "direct_1",
            ownerId: "owner_1",
            principalId: "principal_1",
            principalName: principalName,
            credentialId: "credential_1",
            grantId: "grant_1",
            explicitKey: explicitKey,
            heuristicKey: "principal_1|credential_1",
            createdAt: 1000,
            lastEventAt: 2000,
            eventCount: 3
        )
    }

    func testSessionLabelNamesConversationAndWorkflow() {
        XCTAssertEqual(directAuditSessionLabel(session(explicitKey: "conversation:conv_1")), "Conversation conv_1")
        XCTAssertEqual(directAuditSessionLabel(session(explicitKey: "workflow:weekly-digest")), "Workflow weekly-digest")
    }

    func testSessionLabelWithoutExplicitKeyIsGroupedByActivity() {
        XCTAssertEqual(directAuditSessionLabel(session(explicitKey: nil)), "Grouped by activity")
        XCTAssertTrue(directAuditSessionIsHeuristic(session(explicitKey: nil)))
        XCTAssertFalse(directAuditSessionIsHeuristic(session(explicitKey: "conversation:conv_1")))
    }

    func testSessionLabelWithUnknownKindShowsKeyVerbatim() {
        XCTAssertEqual(directAuditSessionLabel(session(explicitKey: "handoff:abc")), "handoff:abc")
        XCTAssertEqual(directAuditSessionLabel(session(explicitKey: "bare-key")), "bare-key")
        XCTAssertEqual(directAuditSessionLabel(session(explicitKey: ":leading")), ":leading")
    }

    func testAgentNameFallsBackToExternalAgent() {
        XCTAssertEqual(directAuditAgentName(session(explicitKey: nil, principalName: "Atlas")), "Atlas")
        XCTAssertEqual(directAuditAgentName(session(explicitKey: nil, principalName: nil)), "External agent")
        XCTAssertEqual(directAuditAgentName(session(explicitKey: nil, principalName: "  ")), "External agent")
    }

    func testCallCountLabelSingularAndPlural() {
        XCTAssertEqual(directAuditCallCountLabel(1), "1 call")
        XCTAssertEqual(directAuditCallCountLabel(12), "12 calls")
    }

    func testUnknownOutcomeTokenDecodesToUnknown() throws {
        let event = try JSONDecoder().decode(
            DirectAuditEventSummary.self,
            from: Data(
                """
                {"sequence":1,"id":"event_1","sessionId":"direct_1","tool":"search_many",
                "outcome":"minted_by_a_newer_gateway","requestId":"request_1",
                "display":{"title":"search_many"},"payloadTruncated":false,
                "payloadBytes":10,"originalPayloadBytes":10,"createdAt":1000}
                """.utf8
            )
        )
        XCTAssertEqual(event.outcome, .unknown)
    }

    func testRecordWithoutResultReadsAsNoResult() {
        XCTAssertFalse(directRecordHasResult(.object(["tool": .string("fetch_many")])))
        XCTAssertFalse(directRecordHasResult(.object([
            "tool": .string("fetch_many"),
            "result": .null,
        ])))
        XCTAssertTrue(directRecordHasResult(.object([
            "tool": .string("search_many"),
            "result": .object(["kind": .string("search.batch"), "items": .array([])]),
        ])))
        XCTAssertFalse(directRecordHasResult(.string("search_many")))
    }

    func testPayloadTextRendersFullSortedPrettyJSON() {
        let text = directAuditPayloadText(.object(["b": .int(2), "a": .string("x")]))
        XCTAssertTrue(text.contains("\"a\" : \"x\"") || text.contains("\"a\": \"x\""))
        guard let aRange = text.range(of: "\"a\""), let bRange = text.range(of: "\"b\"") else {
            XCTFail("expected keys a and b in \(text)")
            return
        }
        XCTAssertTrue(aRange.lowerBound < bRange.lowerBound)
    }

    func testTruncatedSentinelIsDetected() {
        let sentinel = JSONValue.object([
            "truncated": .bool(true),
            "reason": .string("tool_payload_limit"),
            "originalBytes": .int(200_192),
            "sha256": .string("digest"),
        ])
        XCTAssertTrue(directAuditPayloadIsTruncatedSentinel(sentinel))
        let record = JSONValue.object(["tool": .string("search_many")])
        XCTAssertFalse(directAuditPayloadIsTruncatedSentinel(record))
        XCTAssertFalse(directAuditPayloadIsTruncatedSentinel(.string("search_many")))
    }

    // MARK: - Day groups

    private func transcriptEvent(id: String, createdAt: Int64) -> DirectAuditEventSummary {
        DirectAuditEventSummary(
            sequence: 1,
            id: id,
            sessionId: "direct_1",
            tool: "search_many",
            outcome: .ok,
            requestId: "request_1",
            display: DirectAuditEventDisplay(title: ""),
            payloadTruncated: false,
            payloadBytes: 0,
            originalPayloadBytes: 0,
            createdAt: createdAt
        )
    }

    func testTranscriptDaysGroupByLocalDayWithoutReordering() {
        let calendar = Calendar.current
        let today = calendar.startOfDay(for: Date())
        func at(dayOffset: Int, hour: Int) -> Int64 {
            let day = calendar.date(byAdding: .day, value: dayOffset, to: today)!
            let moment = calendar.date(bySettingHour: hour, minute: 0, second: 0, of: day)!
            return Int64(moment.timeIntervalSince1970 * 1000)
        }
        let events = [
            transcriptEvent(id: "a", createdAt: at(dayOffset: -1, hour: 10)),
            transcriptEvent(id: "b", createdAt: at(dayOffset: -1, hour: 11)),
            transcriptEvent(id: "c", createdAt: at(dayOffset: 0, hour: 9)),
        ]
        let days = directTranscriptDays(events, now: at(dayOffset: 0, hour: 12))
        XCTAssertEqual(days.count, 2)
        XCTAssertEqual(days[0].events.map(\.id), ["a", "b"])
        XCTAssertEqual(days[1].events.map(\.id), ["c"])
        XCTAssertEqual(days[0].heading, "Yesterday")
        XCTAssertEqual(days[1].heading, "Today")
    }

    func testTranscriptDaysWithoutTimeShareOneUnknownGroup() {
        let events = [
            transcriptEvent(id: "a", createdAt: 0),
            transcriptEvent(id: "b", createdAt: -1),
        ]
        let days = directTranscriptDays(events, now: 1_786_000_000_000)
        XCTAssertEqual(days.count, 1)
        XCTAssertEqual(days[0].heading, "Date unknown")
    }
}
