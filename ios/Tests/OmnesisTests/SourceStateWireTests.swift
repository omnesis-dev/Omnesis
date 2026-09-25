// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

@testable import Omnesis
import XCTest

/// This decoder against the same bytes TypeScript writes.
///
/// The fixtures under `wire-fixtures/` are generated from the contract's own
/// definitions and checked in, precisely so this suite does not restate them.
/// Restating them is the failure mode: a decoder tested against its own idea
/// of the wire passes forever while the wire moves.
final class SourceStateWireTests: XCTestCase {
    func testSourceIdentitySplitsOnlyTheFirstColon() {
        let cases: [(id: String, type: String, account: String)] = [
            ("notes:local", "notes", "local"),
            ("notes:tenant:archive:42", "notes", "tenant:archive:42"),
            ("notes::archive:", "notes", ":archive:"),
            ("notes", "notes", ""),
            ("notes:", "notes", ""),
            ("", "", ""),
            (":account", ":account", ""),
            ("::account", "::account", ""),
            ("notes:資料:🗂️", "notes", "資料:🗂️"),
            ("notes:\u{0301}archive", "notes", "\u{0301}archive"),
        ]
        for value in cases {
            XCTAssertEqual(sourceTypeOf(value.id), value.type, value.id)
            XCTAssertEqual(sourceAccountOf(value.id), value.account, value.id)
        }
    }

    /// Read a fixture from the copy that ships beside this test.
    ///
    /// The corpus is generated into `ios/Tests/OmnesisTests/wire-fixtures/`
    /// rather than read from the repository root: the native dispatcher
    /// rsyncs `ios/` alone, so anything above it does not exist on the build
    /// host at all.
    private func fixture(_ name: String) throws -> Data {
        let file = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .appendingPathComponent("wire-fixtures")
            .appendingPathComponent("\(name).json")
        return try XCTUnwrap(
            FileManager.default.contents(atPath: file.path),
            "missing \(file.path) — run `npm run wire-fixtures`"
        )
    }

    private func object(_ name: String) throws -> [String: Any] {
        try XCTUnwrap(JSONSerialization.jsonObject(with: fixture(name)) as? [String: Any])
    }

    func testEnvelopeAtCurrentVersionDecodesWithItsStateIntact() throws {
        let envelope = try JSONDecoder().decode(
            StateEnvelope.self, from: fixture("state-envelope-current")
        )
        XCTAssertEqual(envelope.envelope, 1)
        XCTAssertEqual(envelope.version, 2)
        XCTAssertEqual(envelope.sourceId, "things:local")
        XCTAssertEqual(envelope.state["offset"], .int(12))
    }

    func testAllAuthChallengesSurviveTheNativeEventDecoder() throws {
        for kind in ["fields", "redirect", "qr", "code", "wait", "widget"] {
            let event = try eventFixture("auth-challenge-\(kind)", type: "auth.progress")
            XCTAssertEqual(event.type, "auth.progress")
            XCTAssertEqual(event.payload["flowId"], .string("fixture-flow"))
            XCTAssertEqual(event.payload["id"], .string("question-\(kind)"))
            XCTAssertEqual(event.payload["challenge"]?["kind"], .string(kind))
            XCTAssertEqual(event.payload["expectsAnswer"], .bool(["fields", "code", "widget"].contains(kind)))
            // Native auth is hosted elsewhere; this transport must retain the
            // complete challenge rather than discard fields it does not render.
            let original = try JSONDecoder().decode(JSONValue.self, from: fixture("auth-challenge-\(kind)"))
            XCTAssertEqual(event.payload, original)
        }
        let fields = try eventFixture("auth-challenge-fields", type: "auth.progress")
        XCTAssertEqual(fields.payload["challenge"]?["fields"]?.arrayValue?.first?["type"], .string("secret"))
        let widget = try eventFixture("auth-challenge-widget", type: "auth.progress")
        XCTAssertEqual(widget.payload["challenge"]?["payload"]?["token"], .string("fictional-widget-token"))
    }

    func testAuthCompletionPreservesColonBearingAccountsAndExtras() throws {
        let event = try eventFixture("auth-complete-extras", type: "auth.complete")
        XCTAssertEqual(event.type, "auth.complete")
        XCTAssertEqual(event.payload["ok"], .bool(true))
        XCTAssertEqual(event.payload["accountId"], .string("workspace:demo"))
        XCTAssertEqual(event.payload["accountIds"], .array([.string("workspace:demo")]))
        XCTAssertEqual(event.payload["accountStates"]?["workspace:demo"]?["status"], .string("connected"))
        XCTAssertEqual(event.payload["notices"]?.arrayValue?.first?["title"], .string("History is partial"))
        XCTAssertEqual(event.payload["remedy"], .string("Review the connection permissions."))
        XCTAssertEqual(event.payload["retryAfterMs"], .int(60000))
    }

    func testPartialWarningDoesNotBreakSupportedStatusFields() throws {
        let status = try JSONDecoder().decode(SourceSyncStatus.self, from: fixture("sync-status-partial-warning"))
        XCTAssertEqual(status.sourceId, "fixture:workspace:demo")
        XCTAssertEqual(status.state, "completed")
        XCTAssertEqual(status.progress?.phase, "incremental")
        XCTAssertEqual(status.progress?.processed, 40)
        XCTAssertNil(status.errorMessage)
        // The status UI does not yet decode coverage/issues. The shared WS
        // decoder still retains them for consumers that support the fields.
        let event = try eventFixture("sync-status-partial-warning", type: "sync.status")
        XCTAssertEqual(event.payload["coverage"], .string("unknown"))
        XCTAssertEqual(event.payload["issues"]?.arrayValue?.first?["code"], .string("snapshot-withheld"))
    }

    func testNoticesDecodePerMemberWithUnknownValuesKept() throws {
        let status = try JSONDecoder().decode(SourceSyncStatus.self, from: fixture("sync-status-notices-members"))
        // The aggregate of a multi-device source carries none; each member its own.
        XCTAssertNil(status.notices)
        XCTAssertEqual(status.members?.count, 2)

        let deviceA = try XCTUnwrap(status.status(forDeviceId: "fixture-device-a"))
        XCTAssertEqual(deviceA.displayNotices.map(\.kind), ["coverage-partial"])
        XCTAssertEqual(deviceA.displayNotices.first?.severity, .info)
        XCTAssertEqual(deviceA.displayNotices.first?.detail, "Earlier history was not supplied.")

        let deviceB = try XCTUnwrap(status.status(forDeviceId: "fixture-device-b"))
        XCTAssertEqual(deviceB.displayNotices.map(\.kind), ["error", "replica-dispute", "fixture-future-kind"])
        let failure = try XCTUnwrap(deviceB.displayNotices.first)
        XCTAssertEqual(failure.severity, .error)
        XCTAssertEqual(failure.title, "The last sync failed")
        XCTAssertEqual(failure.detail, "Connection refused")
        XCTAssertEqual(failure.steps, ["Check the network connection.", "Sync again."])
        XCTAssertEqual(failure.since, "2030-01-01T00:00:00.000Z")
        // A severity this build has never seen is shown as a warning.
        XCTAssertEqual(deviceB.displayNotices.last?.severity, .warning)
        XCTAssertEqual(deviceB.displayNotices.last?.title, "A notice from a newer gateway")

        let byDevice = status.noticesByDevice(fallbackDeviceId: nil)
        XCTAssertEqual(byDevice.map(\.deviceId), ["fixture-device-a", "fixture-device-b"])
        XCTAssertEqual(status.allDisplayNotices.map(\.severity).max(), .error)
    }

    func testAccountFamilyMetadataLeavesTheNativeCursorReadable() throws {
        let state = try JSONDecoder().decode(SyncStateResponse.self, from: fixture("source-account-family"))
        XCTAssertEqual(state.cursor, [:])
        XCTAssertNil(state.lastSyncedAt)
        let value = try JSONDecoder().decode(JSONValue.self, from: fixture("source-account-family"))
        XCTAssertEqual(value["account"]?["id"], .string("workspace:demo"))
        XCTAssertEqual(value["account"]?["tenant"]?["id"], .string("tenant:demo"))
        XCTAssertEqual(value["family"]?["label"], .string("Fixture source"))
    }

    func testPartitionedDocumentRetainsNativeSupportedFields() throws {
        let body = try object("documents-partition-claims")
        let documents = try XCTUnwrap(body["documents"] as? [[String: Any]])
        let documentData = try JSONSerialization.data(withJSONObject: XCTUnwrap(documents.first))
        let document = try JSONDecoder().decode(DocumentInput.self, from: documentData)
        XCTAssertEqual(document.sourceId, "fixture:workspace:demo")
        XCTAssertEqual(document.externalId, "note-1")
        XCTAssertEqual(document.content, "Fictional content")
        XCTAssertEqual(document.sourceUpdatedAt, "2030-01-01T00:00:00.000Z")
        // Partition claims are not emitted by native sources; unknown fields
        // remain safe to read, without pretending the native DTO supports them.
        let value = try JSONDecoder().decode(JSONValue.self, from: fixture("documents-partition-claims"))
        XCTAssertEqual(value["presentClaims"]?.arrayValue?.last?["ids"], .array([]))
    }

    func testTupleKeysKeepTheirScalarTypesThroughTheSharedJSONDecoder() throws {
        // AnalyticsIngestRequest is outbound-only. Exercise the production
        // JSONValue codec used for its records, not an invented request decoder.
        let value = try JSONDecoder().decode(JSONValue.self, from: fixture("analytics-tuple-keys"))
        let key = try XCTUnwrap(value["deletedKeys"]?.arrayValue?.first)
        XCTAssertEqual(key["group_id"], .string("group:one"))
        XCTAssertEqual(key["sequence"], .int(2))
        XCTAssertEqual(key["active"], .bool(false))
        XCTAssertEqual(value["presentKeys"], .array([]))
    }

    private func eventFixture(_ name: String, type: String) throws -> WsEventFrame {
        let frame: [String: Any] = try ["type": type, "payload": object(name)]
        return try JSONDecoder().decode(WsEventFrame.self, from: JSONSerialization.data(withJSONObject: frame))
    }

    func testMinorVersionIsReadWithoutDisturbingTheState() throws {
        // A decoder that did not know `m` would either fail or drop the
        // envelope, and it must do neither: a minor bump is by definition one
        // an older reader is meant to tolerate.
        let envelope = try JSONDecoder().decode(
            StateEnvelope.self, from: fixture("state-envelope-with-minor")
        )
        XCTAssertEqual(envelope.minorVersion, 3)
        XCTAssertEqual(envelope.state["offset"], .int(12))
    }

    func testEnvelopeFromNewerBuildIsLegibleEnoughToBeRefused() throws {
        // The point is not that this build understands the state — it cannot —
        // but that it can read the version and know to leave the value alone.
        // Discarding it would overwrite a bookmark the newer build still uses.
        let envelope = try JSONDecoder().decode(
            StateEnvelope.self, from: fixture("state-envelope-from-newer-build")
        )
        XCTAssertEqual(envelope.version, 99)
    }

    func testPreEnvelopeCursorIsNotAnEnvelope() throws {
        // Legacy values carry no `e`, and telling them apart is what stops one
        // being migrated twice or read as corrupt.
        let raw = try object("state-legacy-raw")
        XCTAssertNil(raw["e"])
        XCTAssertNotNil(raw["offset"])
    }

    func testEveryFailureScopeOnTheWireHasANameHere() throws {
        XCTAssertEqual(try scope(of: "failure-item"), .item)
        XCTAssertEqual(try scope(of: "failure-connection"), .connection)
        XCTAssertEqual(try scope(of: "failure-rate-limit-app-quota"), .source)
    }

    func testAnUnfamiliarScopeReadsAsTheWidest() throws {
        // A scope a later release adds must not decode as the narrowest thing
        // this build happens to know — stepping over an unfamiliar failure is
        // how a walk stores a fraction of a corpus and reports success.
        let decoded = try JSONDecoder().decode(FailureScope.self, from: Data("\"tenant\"".utf8))
        XCTAssertEqual(decoded, .connection)
    }

    func testApplicationQuotaIsDistinguishableFromAnAccountOne() throws {
        // Backing off one account against an application-wide limit spends the
        // same budget from another direction, so this must survive the wire.
        let body = try object("failure-rate-limit-app-quota")
        let quota = try XCTUnwrap(body["quota"] as? [String: Any])
        XCTAssertEqual(quota["kind"] as? String, QuotaKind.app.rawValue)
    }

    func testLimitNamingNoBudgetSaysSoByOmission() throws {
        let body = try object("failure-rate-limit-unattributed")
        XCTAssertNil(body["quota"], "an absent quota must stay absent, not become a default")
    }

    func testUnknownCoverageIsItsOwnAnswerAndAbsentIsAFourth() throws {
        XCTAssertEqual(try coverage(of: "coverage-complete"), .complete)
        XCTAssertEqual(try coverage(of: "coverage-partial"), .partial)
        XCTAssertEqual(try coverage(of: "coverage-unknown"), .unknown)
        // Absent is neither `unknown` nor `complete`: the question does not
        // apply to that source, and a client shows nothing rather than a
        // warning.
        XCTAssertNil(try object("coverage-absent")["coverage"])
    }

    private func scope(of name: String) throws -> FailureScope {
        let raw = try XCTUnwrap(object(name)["scope"] as? String)
        return try JSONDecoder().decode(FailureScope.self, from: Data("\"\(raw)\"".utf8))
    }

    private func coverage(of name: String) throws -> HistoryCoverage {
        let raw = try XCTUnwrap(object(name)["coverage"] as? String)
        return try JSONDecoder().decode(HistoryCoverage.self, from: Data("\"\(raw)\"".utf8))
    }
}
