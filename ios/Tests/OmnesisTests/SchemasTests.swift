// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

@testable import Omnesis
import XCTest

final class SchemasTests: XCTestCase {
    func testEveryCategoryHasASchema() {
        for category in HealthCategory.allCases {
            let schema = HealthSchemas.schema(for: category)
            XCTAssertEqual(schema.tableName, category.tableName)
            XCTAssertFalse(schema.columns.isEmpty, "\(category) has no columns")
        }
    }

    func testTallTablesSharePrimaryKeyAndCoreColumns() {
        for category in [HealthCategory.body, .activity, .vitals, .nutrition, .environment] {
            let schema = HealthSchemas.schema(for: category)
            XCTAssertEqual(schema.primaryKey, ["id"])
            let columnNames = Set(schema.columns.map(\.name))
            XCTAssertTrue(columnNames.contains("id"))
            XCTAssertTrue(columnNames.contains("account_id"))
            XCTAssertTrue(columnNames.contains("metric"))
            XCTAssertTrue(columnNames.contains("value"))
            XCTAssertTrue(columnNames.contains("start_time"))
            XCTAssertTrue(columnNames.contains("end_time"))
        }
    }

    func testTallMetricDomainsComeFromTheTypeCatalog() throws {
        let metricColumn = try XCTUnwrap(
            HealthSchemas.vitals.columns.first { $0.name == "metric_slug" }
        )
        let values = try XCTUnwrap(metricColumn.allowedValues)
        XCTAssertTrue(values.contains("heart_rate"))
        XCTAssertTrue(values.contains("respiratory_rate"))
        XCTAssertEqual(values, values.sorted())
        XCTAssertEqual(values.count, Set(values).count)
        XCTAssertEqual(metricColumn.categoricalRole, "series")
        XCTAssertTrue(try XCTUnwrap(metricColumn.valueAliases?["resting_hr"]).contains("resting heart rate"))
        XCTAssertEqual(try Set(XCTUnwrap(metricColumn.valueAliases).keys), Set(values))
        XCTAssertEqual(metricColumn.valueAliases?["hrv"], [
            "heart rate variability", "heart rate variability sdnn", "hrv",
        ])
        XCTAssertEqual(metricColumn.valueAliases?["bp_systolic"], [
            "blood pressure systolic", "bp systolic", "systolic blood pressure",
        ])
        let nutritionMetric = try XCTUnwrap(
            HealthSchemas.nutrition.columns.first { $0.name == "metric_slug" }
        )
        XCTAssertEqual(nutritionMetric.valueAliases?["vitamin_a"], [
            "dietary vitamin a", "vitamin a",
        ])
        let activityMetric = try XCTUnwrap(
            HealthSchemas.activity.columns.first { $0.name == "metric_slug" }
        )
        XCTAssertTrue(try XCTUnwrap(activityMetric.valueAliases?["distance_cycle"]).contains("cycling distance"))
        XCTAssertTrue(try XCTUnwrap(activityMetric.valueAliases?["distance_swim"]).contains("swimming distance"))
        XCTAssertTrue(
            try XCTUnwrap(activityMetric.valueAliases?["distance_walk_run"])
                .contains("walking and running distance")
        )
    }

    func testSleepSchemaHasClosedStageVocabulary() throws {
        let schema = HealthSchemas.sleep
        let stage = try XCTUnwrap(schema.columns.first { $0.name == "stage" })
        XCTAssertEqual(stage.allowedValues, [
            "inBed", "asleepUnspecified", "asleepCore", "asleepDeep", "asleepREM", "awake",
        ])
        XCTAssertEqual(stage.categoricalRole, "selector")
        XCTAssertTrue(try XCTUnwrap(stage.valueAliases?["asleepDeep"]).contains("deep sleep"))
    }

    func testWorkoutsSchemaHasCanonicalWorkoutVocabulary() throws {
        let schema = HealthSchemas.workouts
        let workoutType = try XCTUnwrap(schema.columns.first { $0.name == "workout_type" })
        XCTAssertTrue(try XCTUnwrap(workoutType.canonicalValues).contains("running"))
        XCTAssertEqual(workoutType.categoricalRole, "selector")
        XCTAssertTrue(try XCTUnwrap(workoutType.valueAliases?["running"]).contains("run"))
        XCTAssertTrue(schema.columns.contains(where: { $0.name == "duration_seconds" }))
    }

    func testMoodSchemaIncludesForwardCompatibleUnknownKind() throws {
        let kind = try XCTUnwrap(HealthSchemas.mood.columns.first { $0.name == "kind" })
        XCTAssertEqual(kind.allowedValues, ["momentaryEmotion", "dailyMood", "unknown"])
        XCTAssertEqual(kind.categoricalRole, "selector")
    }

    func testAllSchemasAreCodable() throws {
        // Every schema round-trips through Codable — guards against
        // bad column-type values that wouldn't serialize correctly
        // when sent to the gateway's /analytics/ingest.
        for schema in HealthSchemas.all {
            let data = try JSONEncoder().encode(schema)
            let decoded = try JSONDecoder().decode(AnalyticsTableSchema.self, from: data)
            XCTAssertEqual(decoded, schema)
        }
    }

    func testCategoricalMetadataStaysWithinGatewayProtocolBounds() {
        for schema in HealthSchemas.all {
            for column in schema.columns {
                for values in [column.allowedValues, column.canonicalValues].compactMap({ $0 }) {
                    XCTAssertTrue((1 ... 128).contains(values.count), "\(schema.tableName).\(column.name)")
                    XCTAssertEqual(values.count, Set(values).count)
                    XCTAssertTrue(values.allSatisfy { (1 ... 120).contains($0.count) })
                }
                guard let aliases = column.valueAliases else { continue }
                XCTAssertTrue((1 ... 128).contains(aliases.count), "\(schema.tableName).\(column.name)")
                let vocabulary = Set((column.allowedValues ?? []) + (column.canonicalValues ?? []))
                XCTAssertTrue(aliases.keys.allSatisfy { vocabulary.contains($0) })
                for phrases in aliases.values {
                    XCTAssertTrue((1 ... 8).contains(phrases.count))
                    XCTAssertEqual(phrases.count, Set(phrases).count)
                    XCTAssertTrue(phrases.allSatisfy { (1 ... 120).contains($0.count) })
                }
            }
        }
    }

    // MARK: - record-citation contract (#757)

    func testEverySchemaDeclaresSemanticTimeAndRecord() throws {
        // The gateway requires a semanticTimeColumn (or explicit null) and a
        // record display spec whose columns all exist. Every Apple Health table
        // is event-stamped by start_time and citation-eligible.
        for schema in HealthSchemas.all {
            XCTAssertEqual(schema.semanticTimeColumn, "start_time", "\(schema.tableName) semantic time")
            let record = try XCTUnwrap(schema.record, "\(schema.tableName) must declare a record spec")
            XCTAssertFalse(record.titleColumns.isEmpty, "\(schema.tableName) titleColumns empty")
            XCTAssertFalse(record.keyColumns.isEmpty, "\(schema.tableName) keyColumns empty")
            let columns = Set(schema.columns.map(\.name))
            for col in record.titleColumns + record.keyColumns {
                XCTAssertTrue(columns.contains(col), "\(schema.tableName) record references missing column '\(col)'")
            }
        }
    }

    func testRecordSpecSerializesToCamelCaseKeys() throws {
        // The gateway reads record.titleColumns / keyColumns / titleTemplate and
        // semanticTimeColumn verbatim from the ingest schema payload.
        let data = try JSONEncoder().encode(HealthSchemas.body)
        let json = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        XCTAssertEqual(json["semanticTimeColumn"] as? String, "start_time")
        let record = try XCTUnwrap(json["record"] as? [String: Any])
        XCTAssertEqual(record["titleColumns"] as? [String], ["metric_slug"])
        XCTAssertEqual(record["keyColumns"] as? [String], ["metric_slug", "value", "unit", "start_time"])
        // No template on the tall tables — the key stays omitted.
        XCTAssertNil(record["titleTemplate"])
    }

    // MARK: - boundDocument (#640)

    func testEpisodicTablesDeclareBoundDocument() {
        for schema in [HealthSchemas.workouts, HealthSchemas.mindful, HealthSchemas.mood] {
            let bound = schema.boundDocument
            XCTAssertNotNil(bound, "\(schema.tableName) should declare boundDocument")
            XCTAssertEqual(bound?.externalIdColumns, ["id"], "\(schema.tableName) binds on the row id")
        }
    }

    func testTallSampleTablesHaveNoBoundDocument() {
        for category in [HealthCategory.body, .activity, .vitals, .sleep, .nutrition, .environment] {
            let schema = HealthSchemas.schema(for: category)
            XCTAssertNil(schema.boundDocument, "\(category) is aggregate-only — no bound document")
        }
    }

    func testBoundDocumentSerializesToCamelCaseKey() throws {
        // The gateway's analytics catalog codec reads `boundDocument` →
        // `externalIdColumns` verbatim; the iOS schema must ship exactly
        // those keys inside the /analytics/ingest schema payload.
        let data = try JSONEncoder().encode(HealthSchemas.workouts)
        let json = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        let bound = try XCTUnwrap(json["boundDocument"] as? [String: Any])
        XCTAssertEqual(bound["externalIdColumns"] as? [String], ["id"])
        // Optional fields stay omitted when nil.
        XCTAssertNil(bound["externalIdPrefix"])
        XCTAssertNil(bound["externalIdSeparator"])
        XCTAssertNil(bound["sourceKeyColumns"])
    }

    func testTallTableSchemaOmitsBoundDocumentKey() throws {
        // A schema with no binding must NOT emit a `boundDocument: null`
        // key — the catalog codec treats absence and null differently.
        let data = try JSONEncoder().encode(HealthSchemas.body)
        let json = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        XCTAssertNil(json["boundDocument"], "tall tables must omit the key entirely")
    }
}
