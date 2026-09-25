// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

@testable import Omnesis
import XCTest

/// The projection spec is a wire contract: the gateway reads these exact keys
/// off every `/analytics/ingest` page. A rename here is invisible to the Swift
/// compiler and only shows up as silently unprojected rows, so the encoded
/// JSON — not the Swift property names — is what these tests pin.
final class AnalyticsProjectionSpecTests: XCTestCase {
    private func encoded(_ spec: AnalyticsTemporalProjectionSpec) throws -> [String: Any] {
        let data = try JSONEncoder().encode(spec)
        return try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
    }

    func testFullSpecEncodesTheCanonicalKeySet() throws {
        let spec = AnalyticsTemporalProjectionSpec(
            slot: "booking",
            end: "ends_at",
            label: "title",
            kind: .constant(.appointment),
            modality: .constant(.scheduled),
            status: .constant(.active),
            allDay: "is_all_day",
            eligibility: "is_projectable",
            timeZone: "time_zone",
            sourceUpdatedAt: "updated_at",
            correlationKeys: ["ical_uid"]
        )

        let json = try encoded(spec)
        XCTAssertEqual(Set(json.keys), [
            "slot", "start", "end", "label", "kind", "modality", "status",
            "allDay", "eligibility", "timeZone", "sourceUpdatedAt", "correlationKeys",
        ])
        XCTAssertEqual(json["slot"] as? String, "booking")
        XCTAssertEqual(json["start"] as? String, "$semanticTime")
        XCTAssertEqual(json["end"] as? String, "ends_at")
        XCTAssertEqual(json["label"] as? String, "title")
        XCTAssertEqual(json["allDay"] as? String, "is_all_day")
        XCTAssertEqual(json["eligibility"] as? String, "is_projectable")
        XCTAssertEqual(json["timeZone"] as? String, "time_zone")
        XCTAssertEqual(json["sourceUpdatedAt"] as? String, "updated_at")
        XCTAssertEqual(json["correlationKeys"] as? [String], ["ical_uid"])
    }

    func testMinimalSpecOmitsEveryUnsetKey() throws {
        let json = try encoded(AnalyticsTemporalProjectionSpec(
            slot: "reminder",
            kind: .constant(.reminder),
            modality: .constant(.asserted)
        ))
        XCTAssertEqual(Set(json.keys), ["slot", "start", "kind", "modality"])
    }

    func testConstantFieldsEncodeAsBareVocabularyStrings() throws {
        let json = try encoded(AnalyticsTemporalProjectionSpec(
            slot: "expiry",
            kind: .constant(.expiry),
            modality: .constant(.inferred),
            status: .constant(.completed)
        ))
        XCTAssertEqual(json["kind"] as? String, "expiry")
        XCTAssertEqual(json["modality"] as? String, "inferred")
        XCTAssertEqual(json["status"] as? String, "completed")
    }

    func testMappedFieldEncodesFromMapDefault() throws {
        let json = try encoded(AnalyticsTemporalProjectionSpec(
            slot: "task",
            kind: .constant(.deadline),
            modality: .constant(.asserted),
            status: .mapped(
                from: "state",
                map: ["done": .completed, "dropped": .cancelled],
                default: .active
            )
        ))
        let status = try XCTUnwrap(json["status"] as? [String: Any])
        XCTAssertEqual(Set(status.keys), ["from", "map", "default"])
        XCTAssertEqual(status["from"] as? String, "state")
        XCTAssertEqual(status["default"] as? String, "active")
        XCTAssertEqual(status["map"] as? [String: String], ["done": "completed", "dropped": "cancelled"])
    }

    func testBothFieldFormsRoundTrip() throws {
        let specs = [
            AnalyticsTemporalProjectionSpec(
                slot: "visit",
                end: "departure_time",
                label: "place_name",
                kind: .constant(.visit),
                modality: .constant(.observed),
                status: .constant(.completed)
            ),
            AnalyticsTemporalProjectionSpec(
                slot: "session",
                kind: .mapped(from: "row_kind", map: ["meeting": .appointment], default: .event),
                modality: .constant(.scheduled),
                status: .mapped(from: "state", map: ["done": .completed], default: .active)
            ),
        ]
        for spec in specs {
            let data = try JSONEncoder().encode(spec)
            let decoded = try JSONDecoder().decode(AnalyticsTemporalProjectionSpec.self, from: data)
            XCTAssertEqual(decoded, spec)
        }
    }

    func testDecodingRejectsAValueOutsideTheVocabulary() throws {
        let payload = Data(#"{"slot":"x","start":"$semanticTime","kind":"calendar_event","modality":"observed"}"#.utf8)
        XCTAssertThrowsError(
            try JSONDecoder().decode(AnalyticsTemporalProjectionSpec.self, from: payload)
        )
    }

    func testKindVocabularyCarriesNoRetiredSpelling() {
        // A kind describes the nature of a fact, never its origin: the phone
        // sends `appointment`, not the retired provenance-named spelling.
        XCTAssertNil(TemporalProjectionKind(rawValue: "calendar_event"))
        XCTAssertNil(TemporalProjectionKind(rawValue: "episodic"))
        XCTAssertEqual(TemporalProjectionKind.appointment.rawValue, "appointment")
        XCTAssertEqual(TemporalProjectionKind.episode.rawValue, "episode")
    }
}
