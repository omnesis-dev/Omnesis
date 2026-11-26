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
    static var readableRequest = false
    override class func canInit(with request: URLRequest) -> Bool {
        true
    }

    override class func canonicalRequest(for request: URLRequest) -> URLRequest {
        request
    }

    override func startLoading() {
        let path = Self.readableRequest ? "/readable-download" : "/download"
        guard request.url?.host == "localhost", request.url?.path.hasSuffix(path) == true,
              request.value(forHTTPHeaderField: "Authorization") == "Bearer fixture-token" else {
            client?.urlProtocol(self, didFailWithError: URLError(.badURL))
            return
        }
        if Self.readableRequest {
            guard request.httpMethod == "POST", request.value(forHTTPHeaderField: "Content-Type") == "application/json",
                  let body = Self.requestBody(request),
                  (try? JSONSerialization.jsonObject(with: body)) as? [String: Bool] == ["acknowledgeUnencryptedCopy": true] else {
                client?.urlProtocol(self, didFailWithError: URLError(.badURL))
                return
            }
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

    private static func requestBody(_ request: URLRequest) -> Data? {
        if let body = request.httpBody { return body }
        guard let stream = request.httpBodyStream else { return nil }
        stream.open()
        defer { stream.close() }
        var data = Data()
        var buffer = [UInt8](repeating: 0, count: 256)
        while data.count <= 1024 {
            let read = stream.read(&buffer, maxLength: buffer.count)
            if read == 0 { return data }
            guard read > 0 else { return nil }
            data.append(contentsOf: buffer.prefix(read))
        }
        return nil
    }
}

final class DesktopArtifactDownloadTests: XCTestCase {
    func testReadableExportSendsExplicitConsentAndNeverAcceptsBackupDecryption() async throws {
        let (api, backup, destination) = try fixture()
        do {
            try await DesktopArtifactDownloader().save(backup, api: api, destination: destination, readableExport: true) { _ in }
            XCTFail("Backup contents must never enter readable export mode")
        } catch {}
        XCTAssertFalse(FileManager.default.fileExists(atPath: destination.path))
        let export = try JSONDecoder().decode(DesktopArtifact.self, from: Data(
            #"{"id":"\#(String(repeating: "a", count: 64))","kind":"export","createdAt":"2030-01-01T00:00:00.000Z","bytes":1024,"encrypted":true,"protection":"encrypted-payloads"}"#
                .utf8
        ))
        ArtifactFixtureProtocol.readableRequest = true
        try await DesktopArtifactDownloader().save(export, api: api, destination: destination, readableExport: true) { _ in }
        XCTAssertEqual(try Data(contentsOf: destination), ArtifactFixtureProtocol.bytes)
    }

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
        ArtifactFixtureProtocol.readableRequest = false
        return (api, artifact, root.appendingPathComponent("saved.tar"))
    }

    func testAuthenticatedDownloadSavesActualCompleteBytes() async throws {
        let (api, artifact, destination) = try fixture()
        try await DesktopArtifactDownloader().save(artifact, api: api, destination: destination) { _ in }
        XCTAssertEqual(try Data(contentsOf: destination), ArtifactFixtureProtocol.bytes)
    }

    func testCleanUnknownLengthTruncationDoesNotSaveAValidLookingTarPrefix() async throws {
        let (api, artifact, destination) = try fixture()
        let root = destination.deletingLastPathComponent()
        try Data(repeating: 65, count: 1300).write(to: root.appendingPathComponent("fixture.txt"))
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/tar")
        process.arguments = ["-cf", root.appendingPathComponent("fixture.tar").path, "-C", root.path, "fixture.txt"]
        process.standardInput = FileHandle.nullDevice
        process.standardOutput = FileHandle.nullDevice
        process.standardError = FileHandle.nullDevice
        try process.run()
        process.waitUntilExit()
        XCTAssertEqual(process.terminationStatus, 0)
        let complete = try Data(contentsOf: root.appendingPathComponent("fixture.tar"))
        ArtifactFixtureProtocol.bytes = Data(complete.prefix(1024))
        do {
            try await DesktopArtifactDownloader().save(artifact, api: api, destination: destination) { _ in }
            XCTFail("A clean unknown-length EOF before TAR completion must not save a copy")
        } catch {}
        XCTAssertFalse(FileManager.default.fileExists(atPath: destination.path))
        ArtifactFixtureProtocol.bytes = complete
        try await DesktopArtifactDownloader().save(artifact, api: api, destination: destination) { _ in }
        XCTAssertEqual(try Data(contentsOf: destination), complete)
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
