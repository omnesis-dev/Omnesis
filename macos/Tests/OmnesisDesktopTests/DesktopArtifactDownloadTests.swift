// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import DesktopCore
import Foundation
@testable import OmnesisDesktop
import XCTest

private final class ArtifactFixtureProtocol: URLProtocol, @unchecked Sendable {
    static var status = 200
    static var bytes = Data(repeating: 0, count: 2048)
    static var failAfterBytes = false
    override class func canInit(with request: URLRequest) -> Bool {
        true
    }

    override class func canonicalRequest(for request: URLRequest) -> URLRequest {
        request
    }

    override func startLoading() {
        guard request.url?.host == "localhost", request.url?.path.hasSuffix("/download") == true,
              request.value(forHTTPHeaderField: "Authorization") == "Bearer fixture-token" else {
            client?.urlProtocol(self, didFailWithError: URLError(.badURL))
            return
        }
        let response = HTTPURLResponse(
            url: request.url!,
            statusCode: Self.status,
            httpVersion: "HTTP/1.1",
            headerFields: ["Content-Type": "application/x-tar"]
        )!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Self.bytes)
        if Self.failAfterBytes { client?.urlProtocol(self, didFailWithError: URLError(.networkConnectionLost)) }
        else { client?.urlProtocolDidFinishLoading(self) }
    }

    override func stopLoading() {}
}

final class DesktopArtifactDownloadTests: XCTestCase {
    private func fixture() throws -> (DesktopAPI, DesktopArtifact, URL) {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("omnesis-artifact-save-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        addTeardownBlock { try? FileManager.default.removeItem(at: root) }
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [ArtifactFixtureProtocol.self]
        let connection = try JSONDecoder().decode(
            DesktopConnection.self,
            from: Data(#"{"url":"https://localhost:17601","token":"fixture-token"}"#.utf8)
        )
        let api = try DesktopAPI(connection: connection, sessionOverride: URLSession(configuration: configuration))
        let json = #"{"id":"\#(String(repeating: "a", count: 64))","kind":"backup","createdAt":"2030-01-01T00:00:00.000Z","bytes":1024,"encrypted":true,"protection":"encrypted-payloads"}"#
        let artifact = try JSONDecoder().decode(DesktopArtifact.self, from: Data(json.utf8))
        ArtifactFixtureProtocol.status = 200
        ArtifactFixtureProtocol.bytes = Data(repeating: 0, count: 2048)
        ArtifactFixtureProtocol.failAfterBytes = false
        return (api, artifact, root.appendingPathComponent("saved.tar"))
    }

    func testAuthenticatedDownloadSavesActualCompleteBytes() async throws {
        let (api, artifact, destination) = try fixture()
        try await DesktopArtifactDownloader().save(artifact, api: api, destination: destination) { _ in }
        XCTAssertEqual(try Data(contentsOf: destination), ArtifactFixtureProtocol.bytes)
    }

    func testRefusedAndInterruptedDownloadsNeverLeaveSavedCopy() async throws {
        for failedStream in [false, true] {
            let (api, artifact, destination) = try fixture()
            ArtifactFixtureProtocol.status = failedStream ? 200 : 403
            ArtifactFixtureProtocol.failAfterBytes = failedStream
            do {
                try await DesktopArtifactDownloader().save(artifact, api: api, destination: destination) { _ in }
                XCTFail("Failed downloads must refuse success")
            } catch {}
            XCTAssertFalse(FileManager.default.fileExists(atPath: destination.path))
        }
    }

    func testCancelledDownloadDoesNotLeaveDestination() async throws {
        let (api, artifact, destination) = try fixture()
        let task = Task {
            withUnsafeCurrentTask { $0?.cancel() }
            try await DesktopArtifactDownloader().save(artifact, api: api, destination: destination) { _ in }
        }
        do { try await task.value
            XCTFail("Cancelled operation must refuse success")
        } catch {}
        XCTAssertFalse(FileManager.default.fileExists(atPath: destination.path))
    }

    func testDownloadDelegateRefusesRedirectWithoutForwardingCredential() throws {
        let (api, _, _) = try fixture()
        let task = try api.session.dataTask(with: XCTUnwrap(URL(string: "https://localhost:17601/admin/artifacts")))
        let redirect = try URLRequest(url: XCTUnwrap(URL(string: "https://example.org/other")))
        let response = try XCTUnwrap(try HTTPURLResponse(
            url: XCTUnwrap(task.originalRequest?.url),
            statusCode: 302,
            httpVersion: "HTTP/1.1",
            headerFields: [:]
        ))
        ArtifactRedirectRefusal().urlSession(api.session, task: task, willPerformHTTPRedirection: response, newRequest: redirect) { next in
            XCTAssertNil(next)
        }
        task.cancel()
    }

    func testSaveDoesNotOverwriteExistingFile() async throws {
        let (api, artifact, destination) = try fixture()
        try Data("keep existing".utf8).write(to: destination)
        do {
            try await DesktopArtifactDownloader().save(artifact, api: api, destination: destination) { _ in }
            XCTFail("Existing destination must be refused")
        } catch {}
        XCTAssertEqual(try String(contentsOf: destination, encoding: .utf8), "keep existing")
    }
}
