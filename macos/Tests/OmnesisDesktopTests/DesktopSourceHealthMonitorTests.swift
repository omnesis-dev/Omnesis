// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import DesktopCore
import Foundation
@testable import OmnesisDesktop
import XCTest

private final class SourceHealthFixtureProtocol: URLProtocol, @unchecked Sendable {
    private static let lock = NSLock()
    private static var pending: [SourceHealthFixtureProtocol] = []

    static func take() -> SourceHealthFixtureProtocol? {
        lock.withLock { pending.isEmpty ? nil : pending.removeFirst() }
    }

    override class func canInit(with request: URLRequest) -> Bool {
        true
    }

    override class func canonicalRequest(for request: URLRequest) -> URLRequest {
        request
    }

    override func startLoading() {
        guard request.url?.host == "localhost", request.url?.path == "/admin/sync/status",
              request.value(forHTTPHeaderField: "Authorization") == "Bearer fixture-token" else {
            client?.urlProtocol(self, didFailWithError: URLError(.badURL))
            return
        }
        Self.lock.withLock { Self.pending.append(self) }
    }

    override func stopLoading() {
        Self.lock.withLock { Self.pending.removeAll { $0 === self } }
    }

    func reply(state: String, status: Int = 200) {
        client?.urlProtocol(self, didReceive: HTTPURLResponse(
            url: request.url!, statusCode: status, httpVersion: "HTTP/1.1",
            headerFields: ["Content-Type": "application/json"]
        )!, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data(#"{"items":[{"sourceId":"invented:example","state":"\#(state)"}]}"#.utf8))
        client?.urlProtocolDidFinishLoading(self)
    }
}

@MainActor
final class DesktopSourceHealthMonitorTests: XCTestCase {
    private func api() throws -> DesktopAPI {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [SourceHealthFixtureProtocol.self]
        let session = URLSession(configuration: configuration)
        addTeardownBlock { session.invalidateAndCancel() }
        let connection = try JSONDecoder().decode(
            DesktopConnection.self, from: Data(#"{"url":"http://localhost","token":"fixture-token"}"#.utf8)
        )
        return try DesktopAPI(connection: connection, sessionOverride: session)
    }

    private func request() async throws -> SourceHealthFixtureProtocol {
        let deadline = ContinuousClock.now + .seconds(2)
        while ContinuousClock.now < deadline {
            if let request = SourceHealthFixtureProtocol.take() { return request }
            try await Task.sleep(for: .milliseconds(10))
        }
        throw URLError(.timedOut)
    }

    private func waitUntil(_ condition: () -> Bool) async throws {
        let deadline = ContinuousClock.now + .seconds(2)
        while !condition(), ContinuousClock.now < deadline {
            try await Task.sleep(for: .milliseconds(10))
        }
        XCTAssertTrue(condition())
    }

    func testFailedRefreshNeverPresentsRetainedSuccessAsCurrent() async throws {
        let monitor = DesktopSourceHealthMonitor()
        let api = try api()
        let observation = Task { await monitor.observe(api: api, refreshInterval: .milliseconds(20)) }
        defer { observation.cancel() }
        try await request().reply(state: "synced")
        try await waitUntil { monitor.loaded }
        XCTAssertNil(monitor.failure)
        try await request().reply(state: "error", status: 503)
        try await waitUntil { monitor.failure != nil }
        XCTAssertEqual(monitor.statuses["invented:example"]?.state, "synced")
        XCTAssertNotNil(monitor.failure, "Retained status must be hidden by the current-status guard after a failed refresh")
        observation.cancel()
        await observation.value
    }

    func testReplacedConnectionCannotPublishItsLateHealthReport() async throws {
        let monitor = DesktopSourceHealthMonitor()
        let oldAPI = try api()
        let oldObservation = Task { await monitor.observe(api: oldAPI, refreshInterval: .seconds(60)) }
        defer { oldObservation.cancel() }
        let oldRequest = try await request()
        let newAPI = try api()
        let newObservation = Task { await monitor.observe(api: newAPI, refreshInterval: .seconds(60)) }
        defer { newObservation.cancel() }
        try await request().reply(state: "needs-auth")
        try await waitUntil { monitor.loaded }
        oldRequest.reply(state: "synced")
        await oldObservation.value
        XCTAssertEqual(monitor.statuses["invented:example"]?.state, "needs-auth")
        XCTAssertNil(monitor.failure)
        newObservation.cancel()
        await newObservation.value
    }
}
