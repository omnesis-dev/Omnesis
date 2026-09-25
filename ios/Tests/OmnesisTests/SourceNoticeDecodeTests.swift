// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

@testable import Omnesis
import XCTest

/// `notices` on `/admin/sync/status` beyond the shared wire fixture (which
/// `SourceStateWireTests` decodes): device attribution, a malformed entry,
/// the fallback for a gateway that predates notices, and adopting fresh
/// notices onto a newer status.
final class SourceNoticeDecodeTests: XCTestCase {
    private func decode(_ json: String) throws -> SourceSyncStatus {
        try JSONDecoder().decode(SourceSyncStatus.self, from: Data(json.utf8))
    }

    private let multiMember = """
    {
      "sourceId": "notes:shared",
      "state": "synced",
      "members": [
        {
          "sourceId": "notes:shared",
          "deviceId": "dev-studio",
          "state": "synced",
          "notices": [
            {
              "kind": "coverage-partial",
              "severity": "info",
              "title": "Some folders are not reachable",
              "detail": "Two folders are outside what this device may read."
            }
          ]
        },
        {
          "sourceId": "notes:shared",
          "deviceId": "dev-travel",
          "state": "synced",
          "errorMessage": "ignored when notices are present",
          "notices": [
            {
              "kind": "sync-issue",
              "severity": "warning",
              "title": "One folder could not be read",
              "steps": ["Open the folder's permissions.", "Allow read access."],
              "since": "2030-01-02T03:04:05.000Z"
            },
            {
              "kind": "replica-dispute",
              "severity": "info",
              "title": "This device still has 3 items another device deleted"
            }
          ]
        }
      ]
    }
    """

    func testSingleDeviceStatusBelongsToItsOwnOrTheFallbackDevice() throws {
        let own = try decode("""
        {"sourceId":"a:b","deviceId":"dev-1","state":"stale",
         "notices":[{"kind":"stale","severity":"warning","title":"No new data"}]}
        """)
        XCTAssertEqual(own.noticesByDevice(fallbackDeviceId: "dev-host").map(\.deviceId), ["dev-1"])

        let unnamed = try decode("""
        {"sourceId":"a:b","state":"stale",
         "notices":[{"kind":"stale","severity":"warning","title":"No new data"}]}
        """)
        let groups = unnamed.noticesByDevice(fallbackDeviceId: "dev-host")
        XCTAssertEqual(groups.map(\.deviceId), ["dev-host"])
        XCTAssertEqual(groups.first?.notices.first?.title, "No new data")
    }

    func testAMalformedNoticeIsSkippedWithoutLosingTheStatus() throws {
        let status = try decode("""
        {"sourceId":"a:b","state":"synced","notices":[
          {"kind":"sync-issue","severity":"warning"},
          {"severity":"info","title":"No kind"},
          {"kind":"coverage-unknown","severity":"info","title":"Coverage unknown"}
        ]}
        """)
        XCTAssertEqual(status.state, "synced")
        XCTAssertEqual(status.displayNotices.map(\.kind), ["coverage-unknown"])
    }

    func testAnEmptyListFromTheGatewayMeansNothingToSayEvenBesideAnErrorMessage() throws {
        let status = try decode("""
        {"sourceId":"a:b","state":"error","errorMessage":"stale text","notices":[]}
        """)
        XCTAssertEqual(status.displayNotices, [])
    }

    // MARK: - A status without notices: derived from its state

    func testAnOlderGatewaysFailureReadsAsTheLastSyncFailed() throws {
        let status = try decode("""
        {"sourceId":"a:b","state":"error","errorMessage":"Token rejected by the provider"}
        """)
        XCTAssertNil(status.notices)
        XCTAssertEqual(status.displayNotices, [
            SourceNotice(
                kind: "error",
                severity: .error,
                title: "The last sync failed",
                detail: "Token rejected by the provider"
            ),
        ])
    }

    func testAnOlderGatewaysLapsedSignInReadsAsNeedsSignIn() throws {
        let status = try decode("""
        {"sourceId":"a:b","state":"needs-auth","errorMessage":"needs reauth: Reconnect from the portal."}
        """)
        XCTAssertEqual(status.displayNotices, [
            SourceNotice(
                kind: "needs-auth",
                severity: .error,
                title: "Needs sign-in",
                detail: "Reconnect from the portal."
            ),
        ])
    }

    func testAnOlderGatewaysRateLimitIsANote() throws {
        let status = try decode("""
        {"sourceId":"a:b","state":"rate-limited","errorMessage":"rate-limited: retrying in 5 minutes"}
        """)
        XCTAssertEqual(status.displayNotices, [
            SourceNotice(
                kind: "rate-limited",
                severity: .info,
                title: "Paused by the provider's rate limit",
                detail: "retrying in 5 minutes"
            ),
        ])
    }

    func testAnOlderGatewaysStalledFeedCarriesItsHint() throws {
        let status = try decode("""
        {"sourceId":"a:b","state":"stale","staleHint":"Open the app that feeds this source."}
        """)
        XCTAssertEqual(status.displayNotices, [
            SourceNotice(
                kind: "stale",
                severity: .warning,
                title: "No new data is arriving",
                detail: "Open the app that feeds this source."
            ),
        ])
        let withoutHint = try decode(#"{"sourceId":"a:b","state":"stale"}"#)
        XCTAssertEqual(withoutHint.displayNotices, [])
    }

    func testAnOlderGatewaysExpiringConnectionNamesTheDate() throws {
        let status = try decode("""
        {"sourceId":"a:b","state":"auth-expiring","consentExpiresAt":"2030-03-14T12:00:00Z"}
        """)
        let notice = try XCTUnwrap(status.displayNotices.first)
        XCTAssertEqual(notice.kind, "auth-expiring")
        XCTAssertEqual(notice.severity, .warning)
        XCTAssertTrue(notice.title.hasPrefix("Connection expires on "), notice.title)
        XCTAssertTrue(notice.title.contains("2030"), notice.title)
        let withoutDate = try decode(#"{"sourceId":"a:b","state":"auth-expiring"}"#)
        XCTAssertEqual(withoutDate.displayNotices, [])
    }

    func testAHealthyStatusWithoutNoticesHasNothingToSay() throws {
        XCTAssertEqual(try decode(#"{"sourceId":"a:b","state":"synced"}"#).displayNotices, [])
        XCTAssertEqual(try decode(#"{"sourceId":"a:b","state":"syncing"}"#).displayNotices, [])
    }

    // MARK: - Carrying and adopting

    private func status(
        _ deviceId: String?,
        state: String = "synced",
        errorMessage: String? = nil,
        members: [SourceSyncStatus]? = nil,
        notices: [SourceNotice]? = nil
    )
        -> SourceSyncStatus {
        SourceSyncStatus(
            sourceId: "notes:shared",
            deviceId: deviceId,
            members: members,
            state: state,
            unitName: nil,
            progress: nil,
            startedAt: nil,
            lastSyncAt: nil,
            errorMessage: errorMessage,
            erroredAt: nil,
            lastUpdated: nil,
            notices: notices
        )
    }

    private let note = SourceNotice(
        kind: "coverage-partial",
        severity: .info,
        title: "Some history is not here"
    )

    func testNoticesAreCarriedOnlyWhileTheStateAndFailureHold() {
        let held = status("dev-1", state: "error", errorMessage: "Disk unreadable", notices: [note])
        XCTAssertEqual(
            SourceSyncStatus.carriedNotices(from: held, state: "error", errorMessage: "Disk unreadable"),
            [note]
        )
        XCTAssertNil(SourceSyncStatus.carriedNotices(from: held, state: "synced", errorMessage: nil))
        XCTAssertNil(SourceSyncStatus.carriedNotices(from: held, state: "error", errorMessage: "Disk full"))
        XCTAssertNil(SourceSyncStatus.carriedNotices(from: nil, state: "error", errorMessage: nil))
    }

    func testAdoptingKeepsTheNewerStateAndMatchesMembersByDevice() throws {
        let current = status(
            nil,
            state: "syncing",
            members: [
                status("dev-studio", state: "syncing", notices: []),
                status("dev-gone", state: "error", notices: [note]),
            ]
        )
        let adopted = try current.adoptingNotices(from: decode(multiMember))
        XCTAssertEqual(adopted.state, "syncing")
        XCTAssertEqual(adopted.status(forDeviceId: "dev-studio")?.state, "syncing")
        XCTAssertEqual(adopted.status(forDeviceId: "dev-studio")?.displayNotices.map(\.kind), ["coverage-partial"])
        // A member the fresh read does not list has nothing to say.
        XCTAssertEqual(adopted.status(forDeviceId: "dev-gone")?.notices, [])
        XCTAssertEqual(adopted.status(forDeviceId: "dev-gone")?.state, "error")
    }

    func testAdoptingTakesTheReadsMembersWhenNoneAreHeld() throws {
        let current = status("dev-studio", state: "synced", notices: [note])
        let adopted = try current.adoptingNotices(from: decode(multiMember))
        XCTAssertEqual(adopted.members?.map(\.deviceId), ["dev-studio", "dev-travel"])
        XCTAssertEqual(adopted.status(forDeviceId: "dev-travel")?.displayNotices.count, 2)
    }

    func testAdoptingIntoTheCacheLeavesUnheldSourcesToTheFullRefresh() {
        let fresh = [
            status(nil, notices: [note]),
            SourceSyncStatus(
                sourceId: "other:one",
                deviceId: nil,
                state: "synced",
                unitName: nil,
                progress: nil,
                startedAt: nil,
                lastSyncAt: nil,
                errorMessage: nil,
                erroredAt: nil,
                lastUpdated: nil,
                notices: [note]
            ),
        ]
        let cache = ["notes:shared": status(nil, state: "error", notices: [])]
        let adopted = SourceSyncStatus.adoptingNotices(from: fresh, into: cache)
        XCTAssertEqual(Array(adopted.keys), ["notes:shared"])
        XCTAssertEqual(adopted["notes:shared"]?.notices, [note])
        XCTAssertEqual(adopted["notes:shared"]?.state, "error")
    }

    // MARK: - Presentation helpers

    func testNoticesSortMostSevereFirstKeepingTheGatewaysOrderWithin() {
        let first = SourceNotice(kind: "a", severity: .info, title: "first note")
        let warning = SourceNotice(kind: "b", severity: .warning, title: "warning")
        let second = SourceNotice(kind: "c", severity: .info, title: "second note")
        let problem = SourceNotice(kind: "d", severity: .error, title: "problem")
        XCTAssertEqual(
            sortedBySeverity([first, warning, second, problem]).map(\.title),
            ["problem", "warning", "first note", "second note"]
        )
    }

    func testIconLabelsCountAndNameTheDevice() {
        XCTAssertEqual(
            sourceNoticeGroupLabel(severity: .warning, count: 2, deviceName: "studio-desk"),
            "2 warnings for studio-desk"
        )
        XCTAssertEqual(sourceNoticeGroupLabel(severity: .error, count: 1, deviceName: nil), "1 problem")
        XCTAssertEqual(sourceNoticeGroupLabel(severity: .info, count: 3, deviceName: ""), "3 notes")
    }

    func testTheSummaryLabelNamesTheWorstWhenSeveritiesMix() {
        let mixed = [
            note,
            SourceNotice(kind: "error", severity: .error, title: "failed"),
            note,
        ]
        XCTAssertEqual(
            sourceNoticeSummaryLabel(mixed, deviceNames: ["studio-desk"]),
            "3 notices, including 1 problem, for studio-desk"
        )
        XCTAssertEqual(sourceNoticeSummaryLabel([note, note], deviceNames: []), "2 notes")
        XCTAssertEqual(sourceNoticeSummaryLabel([], deviceNames: ["studio-desk"]), "")
    }

    func testSinceTextReadsBothTimestampFormsAndIgnoresGarbage() {
        XCTAssertEqual(noticeSinceText("2030-01-02T03:04:05.000Z")?.hasPrefix("Since "), true)
        XCTAssertEqual(noticeSinceText("2030-01-02T03:04:05Z")?.hasPrefix("Since "), true)
        XCTAssertNil(noticeSinceText("yesterday"))
        XCTAssertNil(noticeSinceText(nil))
        XCTAssertNotNil(parseISODate("2030-01-02T03:04:05Z"))
    }
}
