// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

@testable import Omnesis
import XCTest

final class AccessScopePickerPagesTests: XCTestCase {
    private actor Session: URLSessionLike {
        var cursors: [String?] = []
        func data(for request: URLRequest) async throws -> (Data, URLResponse) {
            let cursor = URLComponents(url: request.url!, resolvingAgainstBaseURL: false)?.queryItems?.first { $0.name == "cursor" }?.value
            cursors.append(cursor)
            let range = cursor == nil ? 0 ..< 50 : 50 ..< 65
            let value = ScopeOptions(
                sourceId: "google-drive:files@example.org",
                field: "extra.folderIds",
                items: range.map { index in
                    .init(
                        ref: .tree(field: "extra.folderIds", id: "folder-\(index)"),
                        label: "Example folder \(index)",
                        count: index + 1
                    )
                },
                nextCursor: cursor == nil ? "second" : nil
            )
            return try (
                JSONEncoder().encode(value),
                HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!
            )
        }
    }

    func testLoadMoreAndReopenRehydrateBothRealSizedPagesWithoutLosingCursorOrItems() async throws {
        let session = Session()
        let client = try AccessClient(
            baseURL: XCTUnwrap(URL(string: "https://gateway.example.org")),
            token: "fictional-owner",
            session: session
        )
        let request = ScopePickerRequest(sourceId: "google-drive:files@example.org", field: "extra.folderIds", query: "", parentId: nil)
        let first = try await loadScopePickerPages(client: client, request: request, previous: nil, cursor: nil, restoreCount: 0)
        XCTAssertEqual(first.items.count, 50)
        XCTAssertEqual(first.nextCursor, "second")
        let loaded = try await loadScopePickerPages(
            client: client,
            request: request,
            previous: first,
            cursor: first.nextCursor,
            restoreCount: 0
        )
        XCTAssertEqual(loaded.items.count, 65)
        XCTAssertNil(loaded.nextCursor)
        XCTAssertEqual(loaded.items[57].label, "Example folder 57")
        let reopened = try await loadScopePickerPages(
            client: client,
            request: request,
            previous: loaded,
            cursor: nil,
            restoreCount: loaded.items.count
        )
        XCTAssertEqual(reopened, loaded)
        let cursors = await session.cursors
        XCTAssertEqual(cursors, [nil, "second", nil, "second"])
    }

    func testAnotherAccountPageIsRejectedWithoutChangingLoadedNavigationSnapshot() throws {
        let previous = ScopeOptions(sourceId: "first", field: "extra.folderIds", items: [])
        let wrong = ScopeOptions(sourceId: "another", field: "extra.folderIds", items: [])
        XCTAssertThrowsError(try appendScopeOptions(wrong, to: previous))
        XCTAssertThrowsError(try appendScopeOptions(ScopeOptions(sourceId: "first", field: "extra.labelIds", items: []), to: previous))
        XCTAssertEqual(previous.sourceId, "first")
    }
}
