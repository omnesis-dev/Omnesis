// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

@testable import Omnesis
import XCTest

/// The waiting access requests the home banner reads. A foreground and a
/// closing review sheet can both ask at once, and whichever asked last is
/// the one the banner believes, however the answers are ordered.
@available(iOS 17.0, *)
@MainActor
final class AdminCoordinatorPendingAccessTests: XCTestCase {
    /// Holds every overview read until the test answers it, in the order
    /// the reads arrived.
    private final class HeldSession: URLSessionLike, @unchecked Sendable {
        private let lock = NSLock()
        private var held: [CheckedContinuation<String, Never>] = []

        var arrived: Int {
            lock.withLock { held.count }
        }

        func data(for request: URLRequest) async throws -> (Data, URLResponse) {
            let body = await withCheckedContinuation { continuation in
                lock.withLock { held.append(continuation) }
            }
            let response = HTTPURLResponse(
                url: request.url!,
                statusCode: 200,
                httpVersion: "HTTP/1.1",
                headerFields: ["Content-Type": "application/json"]
            )!
            return (Data(body.utf8), response)
        }

        /// Answer the read that arrived at `index` with `body`.
        func answer(_ index: Int, with body: String) {
            lock.withLock { held[index] }.resume(returning: body)
        }
    }

    private func waitFor(
        timeout: TimeInterval = 2.0,
        _ predicate: @escaping () -> Bool
    ) async
        -> Bool {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            if predicate() { return true }
            try? await Task.sleep(nanoseconds: 20_000_000)
        }
        return predicate()
    }

    private func makeCoordinator(session: HeldSession) -> AdminCoordinator {
        let coord = AdminCoordinator()
        coord.injectAccessClientForTesting(
            AccessClient(baseURL: URL(string: "https://stub.local")!, token: "t", session: session)
        )
        return coord
    }

    /// An overview listing one waiting request per id, and nothing else.
    private func overview(listing ids: [String]) -> String {
        let requests = ids.map {
            #"{"id":"\#($0)","clientName":"Client \#($0)","createdAt":1800000000000,"expiresAt":1800000600000}"#
        }
        return #"{"principals":[],"sources":[],"policyFamilies":[],"pendingRequests":["#
            + requests.joined(separator: ",") + "]}"
    }

    /// Start a read and wait until it has reached the gateway, so the test
    /// knows which held answer is which.
    private func startRead(
        _ coord: AdminCoordinator,
        session: HeldSession,
        expecting arrived: Int
    ) async
        -> Task<Void, Never> {
        let read = Task { await coord.refreshPendingAccessRequests() }
        let reached = await waitFor { session.arrived == arrived }
        XCTAssertTrue(reached, "read \(arrived) must reach the gateway")
        return read
    }

    /// Reads that do not overlap each land in turn, and a read that fails
    /// empties the list rather than keeping what an earlier one saw.
    func testReadsInTurnEachLandAndAFailureEmptiesTheList() async {
        let session = HeldSession()
        let coord = makeCoordinator(session: session)

        let first = await startRead(coord, session: session, expecting: 1)
        session.answer(0, with: overview(listing: ["request-newest"]))
        await first.value
        XCTAssertEqual(coord.pendingAccessRequests.map(\.id), ["request-newest"])

        let second = await startRead(coord, session: session, expecting: 2)
        session.answer(1, with: "not an overview")
        await second.value
        XCTAssertEqual(coord.pendingAccessRequests, [])
    }

    /// A foreground read still in flight when a review sheet closes and asks
    /// again: the later read lands, and the earlier one's slower answer is
    /// discarded rather than replacing it.
    func testTheLatestReadWinsWhateverOrderTheAnswersArrive() async {
        let session = HeldSession()
        let coord = makeCoordinator(session: session)

        let foreground = await startRead(coord, session: session, expecting: 1)
        let sheetClosed = await startRead(coord, session: session, expecting: 2)

        session.answer(1, with: overview(listing: ["request-newest"]))
        await sheetClosed.value
        XCTAssertEqual(coord.pendingAccessRequests.map(\.id), ["request-newest"])

        session.answer(0, with: overview(listing: []))
        await foreground.value
        XCTAssertEqual(
            coord.pendingAccessRequests.map(\.id),
            ["request-newest"],
            "the earlier read's answer must not replace the later one's"
        )
    }

    /// Unpairing while a read is in flight: the answer arrives for a gateway
    /// the app is no longer paired with, and must not fill the banner.
    func testAReadInFlightWhenTheAdminStopsIsDiscarded() async {
        let session = HeldSession()
        let coord = makeCoordinator(session: session)

        let read = await startRead(coord, session: session, expecting: 1)
        coord.stopAdmin()
        session.answer(0, with: overview(listing: ["request-newest"]))
        await read.value
        XCTAssertEqual(coord.pendingAccessRequests, [])
    }
}
