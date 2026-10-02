// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

@testable import Omnesis
import XCTest

final class SearchGraphCompatibilityTests: XCTestCase {
    private final class Session: URLSessionLike, @unchecked Sendable {
        var requests: [URLRequest] = []
        var readiness = "{}"
        var readinessStatus = 200
        var response = #"{"results":[],"timing":{"totalMs":9}}"#
        var readinessError: Swift.Error?

        func data(for request: URLRequest) async throws -> (Data, URLResponse) {
            requests.append(request)
            let probe = request.url?.path == "/search/readiness"
            if probe, let readinessError { throw readinessError }
            let body = probe ? readiness : response
            let status = probe ? readinessStatus : 200
            return (Data(body.utf8), HTTPURLResponse(
                url: request.url!,
                statusCode: status,
                httpVersion: nil,
                headerFields: nil
            )!)
        }
    }

    private func client(_ session: Session) -> SearchClient {
        .init(baseURL: URL(string: "https://example.com")!, token: "fixture-token", session: session)
    }

    private func body(_ session: Session) throws -> [String: Any] {
        try XCTUnwrap(JSONSerialization.jsonObject(with: XCTUnwrap(session.requests.last?.httpBody)) as? [String: Any])
    }

    func testDefaultSearchKeepsLegacyRequestWithoutCapabilityProbe() async throws {
        let session = Session()
        _ = try await client(session).search(text: "permit")
        XCTAssertEqual(session.requests.map { $0.url!.path }, ["/search"])
        XCTAssertNil(try body(session)["includeGraphContext"])
    }

    func testMissingDisabledAndOlderReadinessKeepLegacyRequest() async throws {
        for (readiness, status) in [("{}", 200), (#"{"graphContextAvailable":false}"#, 200), ("{}", 404), ("{}", 403)] {
            let session = Session()
            session.readiness = readiness
            session.readinessStatus = status
            let response = try await client(session).search(text: "permit", graphContext: true)
            XCTAssertNil(try body(session)["includeGraphContext"])
            XCTAssertEqual(response.timing?.totalMs, 9)
        }
    }

    func testCapabilityEnablesAdditiveSearchWhilePreservingSearchMetadata() async throws {
        let session = Session()
        session.readiness = #"{"graphContextAvailable":true,"futureFlag":1}"#
        _ = try await client(session).search(text: "permit", limit: 30, graphContext: true)
        XCTAssertEqual(try body(session)["includeGraphContext"] as? Bool, true)
        XCTAssertEqual(try body(session)["text"] as? String, "permit")
        XCTAssertEqual(try body(session)["limit"] as? Int, 30)
        XCTAssertEqual(try body(session)["verbose"] as? Bool, true)
    }

    func testOptionalReadinessFailureDoesNotPreventOrdinarySearch() async throws {
        let session = Session()
        session.readinessError = URLError(.timedOut)
        _ = try await client(session).search(text: "permit", graphContext: true)
        XCTAssertNil(try body(session)["includeGraphContext"])
    }

    func testCancelledReadinessDoesNotLaunchOrdinarySearch() async throws {
        let session = Session()
        session.readinessError = CancellationError()
        do {
            _ = try await client(session).search(text: "permit", graphContext: true)
            XCTFail("Cancelled search must propagate cancellation")
        } catch is CancellationError {} catch { XCTFail("Unexpected error: \(error)") }
        XCTAssertEqual(session.requests.count, 1)
    }

    private func probes(_ session: Session) -> Int {
        session.requests.filter { $0.url?.path == "/search/readiness" }.count
    }

    func testCapabilityIsAskedOncePerClientUntilInvalidated() async throws {
        let session = Session()
        session.readiness = #"{"graphContextAvailable":true}"#
        let client = client(session)
        _ = try await client.search(text: "permit", graphContext: true)
        _ = try await client.search(text: "budget", graphContext: true)
        XCTAssertEqual(probes(session), 1)
        XCTAssertEqual(try body(session)["includeGraphContext"] as? Bool, true)

        session.readiness = #"{"graphContextAvailable":false}"#
        client.invalidateSearchCapabilities()
        _ = try await client.search(text: "permit", graphContext: true)
        XCTAssertEqual(probes(session), 2)
        XCTAssertNil(try body(session)["includeGraphContext"])
    }

    func testOlderGatewayRefusalIsKeptButTransientFailureIsAskedAgain() async throws {
        let older = Session()
        older.readinessStatus = 404
        let olderClient = client(older)
        _ = try await olderClient.search(text: "permit", graphContext: true)
        _ = try await olderClient.search(text: "permit", graphContext: true)
        XCTAssertEqual(probes(older), 1)

        let flaky = Session()
        flaky.readinessError = URLError(.timedOut)
        let flakyClient = client(flaky)
        _ = try await flakyClient.search(text: "permit", graphContext: true)
        flaky.readinessError = nil
        flaky.readiness = #"{"graphContextAvailable":true}"#
        _ = try await flakyClient.search(text: "permit", graphContext: true)
        XCTAssertEqual(probes(flaky), 2)
        XCTAssertEqual(try body(flaky)["includeGraphContext"] as? Bool, true)

        let failing = Session()
        failing.readinessStatus = 503
        let failingClient = client(failing)
        _ = try await failingClient.search(text: "permit", graphContext: true)
        _ = try await failingClient.search(text: "permit", graphContext: true)
        XCTAssertEqual(probes(failing), 2)
    }

    func testInvalidationDuringAProbeDiscardsItsAnswer() {
        let capability = SearchGraphCapability()
        let (_, generation) = capability.read()
        capability.invalidate()
        capability.store(true, generation: generation)
        XCTAssertNil(capability.read().value)
    }

    func testMalformedProvenanceDropsOnlyThatHitsEvidence() throws {
        let hit = { (id: String, provenance: String) in
            #"{"documentId":""# + id + #"","sourceId":"files:example","documentType":"file","title":"Permit.pdf","#
                + #""sourceCreatedAt":"2026-01-01","chunkText":"Permit","score":0.9,"provenance":"# + provenance + "}"
        }
        let json = #"{"results":["#
            + hit("bad-type", #""not an object""#) + ","
            + hit("bad-copy", #"{"copies":[{"title":"No id"}]}"#) + ","
            + hit("sparse", #"{"copies":[{"documentId":"copy","title":"Copy"}]}"#)
            + "]}"
        let response = try JSONDecoder().decode(SearchResponse.self, from: Data(json.utf8))
        XCTAssertEqual(response.results.map(\.documentId), ["bad-type", "bad-copy", "sparse"])
        XCTAssertNil(response.results[0].provenance)
        XCTAssertNil(response.results[1].provenance)
        let sparse = try XCTUnwrap(response.results[2].provenance)
        XCTAssertEqual(sparse.copies.map(\.documentId), ["copy"])
        XCTAssertEqual(sparse.copies.first?.sourceId, "")
        XCTAssertEqual(sparse.paths, [])
        XCTAssertEqual(sparse.stopReasons, [])
        XCTAssertNil(sparse.modelContext)
    }

    func testOldAndFutureSearchPayloadsRemainReadable() throws {
        let base = #"{"documentId":"root","sourceId":"files:example","documentType":"file","title":"Permit.pdf","#
            + #""sourceCreatedAt":"2026-01-01","chunkText":"Permit","score":0.9"#
        let decoder = JSONDecoder()
        let old = try decoder.decode(SearchResultItem.self, from: Data((base + "}").utf8))
        XCTAssertNil(old.provenance)
        let additive = base + #", "provenance":{"summary":"ignored","copies":[],"paths":[],"stopReasons":[],"#
            + #""truncated":false,"futureField":true},"futureField":{"new":1}}"#
        let new = try decoder.decode(SearchResultItem.self, from: Data(additive.utf8))
        XCTAssertEqual(new.documentId, old.documentId)
        XCTAssertEqual(new.chunkText, old.chunkText)
        XCTAssertNotNil(new.provenance)
    }
}
