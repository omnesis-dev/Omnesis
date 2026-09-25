// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

@testable import Omnesis
import XCTest

/// The offline buffer drops its oldest batches to stay inside its size limit,
/// and the gateway's cursor for the source has already moved past them. These
/// cover the one thing that keeps that gap from being silent: the cycle that
/// dropped anything publishes a `partial` coverage claim, and a cycle that
/// dropped nothing publishes no coverage at all.
final class CollectorCoverageClaimTests: XCTestCase {
    private var directory: URL!

    override func setUp() {
        super.setUp()
        directory = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("omnesis-coverage-\(UUID().uuidString)")
    }

    override func tearDown() {
        try? FileManager.default.removeItem(at: directory)
        super.tearDown()
    }

    // MARK: - Fixtures

    /// Replays canned pages, then reports `hasMore == false` for good.
    private actor PagingSource: OmnesisSource {
        nonisolated let id = "mock:coverage"
        nonisolated let displayName = "Mock"
        nonisolated let analyticsSchemas: [AnalyticsTableSchema] = []
        private let pages: [SyncResult]
        private var index = 0

        init(pages: [SyncResult]) {
            self.pages = pages
        }

        func sync(cursor: SyncCursor?) async throws -> SyncResult {
            guard index < pages.count else {
                return SyncResult(
                    records: [], tableName: "coverage_rows",
                    cursor: cursor ?? [:], hasMore: false
                )
            }
            let page = pages[index]
            index += 1
            return page
        }
    }

    /// Answers the two calls a cycle makes: no persisted cursor to resume
    /// from, and an ingest the gateway accepts.
    private struct MockSession: URLSessionLike {
        func data(for request: URLRequest) async throws -> (Data, URLResponse) {
            let url = request.url!
            let notFound = url.path.hasPrefix("/sync-state/") && request.httpMethod == "GET"
            let http = HTTPURLResponse(
                url: url,
                statusCode: notFound ? 404 : 200,
                httpVersion: "HTTP/1.1",
                headerFields: ["Content-Type": "application/json"]
            )!
            let body = notFound ? "" : "{\"ingested\":0}"
            return (Data(body.utf8), http)
        }
    }

    private actor LifecycleRecorder {
        private(set) var events: [CollectorCore.Lifecycle] = []
        func record(_ event: CollectorCore.Lifecycle) {
            events.append(event)
        }

        /// The coverage claim the cycle's completion carried, if it completed.
        var completedCoverage: CollectorCore.CoverageClaim?? {
            for case .completed(_, _, _, _, let claim) in events {
                return .some(claim)
            }
            return nil
        }
    }

    /// A page fat enough that a handful of them overrun a small buffer cap.
    private func page(rowCount: Int, cursorPage: Int, hasMore: Bool) -> SyncResult {
        let records: [[String: JSONValue]] = (0 ..< rowCount).map { row in
            [
                "id": .string("row-\(cursorPage)-\(row)"),
                "note": .string(String(repeating: "x", count: 128)),
            ]
        }
        return SyncResult(
            records: records,
            tableName: "coverage_rows",
            cursor: ["page": .int(Int64(cursorPage))],
            hasMore: hasMore
        )
    }

    private func runCycle(
        pages: [SyncResult],
        bufferConfig: OfflineBuffer.Config
    ) async throws
        -> LifecycleRecorder {
        let gateway = try GatewayClient(
            baseURL: XCTUnwrap(URL(string: "http://gateway.example.com:7600")),
            token: "omn_test",
            session: MockSession()
        )
        let buffer = OfflineBuffer(directory: directory, config: bufferConfig)
        let recorder = LifecycleRecorder()
        let core = CollectorCore(
            gateway: gateway,
            buffer: buffer,
            cursorStore: CursorStore(gateway: gateway),
            uploader: Uploader(gateway: gateway, buffer: buffer),
            sources: [PagingSource(pages: pages)],
            onLifecycle: { await recorder.record($0) }
        )
        _ = await core.syncAll()
        return recorder
    }

    // MARK: - Tests

    func testCycleThatDroppedBufferedPagesReportsPartialCoverage() async throws {
        let pages = (0 ..< 8).map { page(rowCount: 8, cursorPage: $0, hasMore: $0 < 7) }
        let recorder = try await runCycle(
            pages: pages,
            bufferConfig: OfflineBuffer.Config(maxSizeBytes: 4096, warningSizeBytes: 2048)
        )

        let coverage = await recorder.completedCoverage
        guard let claim = try XCTUnwrap(coverage) else {
            return XCTFail("A cycle that dropped buffered pages must claim coverage")
        }
        XCTAssertEqual(claim.coverage, .partial)
        XCTAssertFalse(claim.detail.isEmpty)
    }

    func testCycleThatKeptEveryPageReportsNoCoverageAtAll() async throws {
        let pages = (0 ..< 3).map { page(rowCount: 2, cursorPage: $0, hasMore: $0 < 2) }
        let recorder = try await runCycle(
            pages: pages,
            bufferConfig: OfflineBuffer.Config(maxSizeBytes: 4_000_000, warningSizeBytes: 2_000_000)
        )

        let coverage = await recorder.completedCoverage
        let claim = try XCTUnwrap(coverage, "The cycle must have completed")
        XCTAssertNil(
            claim,
            "A healthy cycle claims nothing: `complete` would be a promise, and any line is a warning"
        )
    }

    func testCoverageDetailIsOperatorReadableAndLeaksNothing() async throws {
        let pages = (0 ..< 8).map { page(rowCount: 8, cursorPage: $0, hasMore: $0 < 7) }
        let recorder = try await runCycle(
            pages: pages,
            bufferConfig: OfflineBuffer.Config(maxSizeBytes: 4096, warningSizeBytes: 2048)
        )
        let coverage = await recorder.completedCoverage
        let detail = try XCTUnwrap(XCTUnwrap(coverage)).detail

        // Says what happened and what to do about it, in words an operator owns.
        XCTAssertTrue(detail.contains("some history is missing"), detail)
        XCTAssertTrue(detail.lowercased().contains("re-sync"), detail)
        // Never the machinery: no file path, no source or device identifier,
        // and none of the internal vocabulary for what the buffer did.
        XCTAssertFalse(detail.contains("/"), detail)
        XCTAssertFalse(detail.contains(directory.path), detail)
        XCTAssertFalse(detail.contains("mock:coverage"), detail)
        XCTAssertFalse(detail.lowercased().contains("evict"), detail)
        XCTAssertFalse(detail.lowercased().contains("batch"), detail)
        XCTAssertFalse(detail.lowercased().contains("buffer"), detail)
    }

    // MARK: - What reaches the gateway

    func testPartialCoverageRidesTheSyncStatusProgressObject() throws {
        let event = CollectorCore.Lifecycle.completed(
            sourceId: "mock:coverage",
            displayName: "Mock",
            records: 12,
            completedAt: Date(),
            coverage: CollectorCore.CoverageClaim(coverage: .partial, detail: "Some history is missing.")
        )

        let payload = try XCTUnwrap(syncStatusProgressPayload(for: event, processed: 12))
        XCTAssertEqual(payload["processed"], .int(12))
        XCTAssertEqual(payload["coverage"], .string("partial"))
        XCTAssertEqual(payload["detail"], .string("Some history is missing."))
    }

    func testAClaimlessCompletionSendsNoCoverageKeys() throws {
        let event = CollectorCore.Lifecycle.completed(
            sourceId: "mock:coverage",
            displayName: "Mock",
            records: 12,
            completedAt: Date(),
            coverage: nil
        )

        let payload = try XCTUnwrap(syncStatusProgressPayload(for: event, processed: 12))
        XCTAssertEqual(payload["processed"], .int(12))
        XCTAssertNil(payload["coverage"])
        XCTAssertNil(payload["detail"])
    }

    func testAnEventWithNothingToReportSendsNoProgressObject() {
        let event = CollectorCore.Lifecycle.error(
            sourceId: "mock:coverage",
            displayName: "Mock",
            message: "upstream refused the page"
        )
        XCTAssertNil(syncStatusProgressPayload(for: event, processed: nil))
    }
}
