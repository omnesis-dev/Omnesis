// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import DesktopCore
import Foundation
@testable import OmnesisDesktop
import XCTest

@MainActor
final class DesktopScopedDescriptorTests: XCTestCase {
    func testSelectedCollectorMetadataPreservesUnknownVersusNoRequirementsAndFullSchema() async throws {
        let fixture = try ScopedDescriptorFixture { request in
            let device = try URLComponents(url: XCTUnwrap(request.url), resolvingAgainstBaseURL: false)?
                .queryItems?.first(where: { $0.name == "deviceId" })?.value
            XCTAssertEqual(request.url?.path, "/admin/sources/descriptors")
            let descriptor = device == "legacy" ? Self.legacy : Self.current
            return try #"{"deviceId":"\#(XCTUnwrap(device))","items":[\#(descriptor)]}"#
        }
        defer { fixture.close() }
        let current = try await fixture.api.descriptor(id: "invented", deviceId: "current")
        XCTAssertEqual(current.permissionRequirements?.count, 0)
        XCTAssertEqual(current.params?.map(\.name), ["selectedPath"])
        XCTAssertEqual(current.authType, "selected-auth")
        XCTAssertNil(current.devices, "A full collector response must not acquire the fleet's host list")
        let legacy = try await fixture.api.descriptor(id: "invented", deviceId: "legacy")
        XCTAssertNil(legacy.permissionRequirements)
        XCTAssertEqual(legacy.params?.map(\.name), ["legacyPath"])
        XCTAssertEqual(legacy.authType, "legacy-auth")
    }

    func testMismatchedDuplicateMissingAndLegacyUnboundRepliesNeverFallback() async throws {
        for reply in [
            #"{"deviceId":"other","items":[\#(Self.current)]}"#,
            #"{"deviceId":"current","items":[\#(Self.current),\#(Self.current)]}"#,
            #"{"deviceId":"current","items":[]}"#,
            #"{"items":[\#(Self.current)]}"#,
        ] {
            let fixture = try ScopedDescriptorFixture { request in
                XCTAssertEqual(request.url?.path, "/admin/sources/descriptors")
                return reply
            }
            do {
                _ = try await fixture.api.descriptor(id: "invented", deviceId: "current")
                XCTFail("An unbound descriptor reply must be refused")
            } catch {}
            fixture.close()
        }
    }

    func testSettingsUseTheChosenMembersEntireDescriptorForFieldsAndValidation() async throws {
        var validations: [String] = []
        var patched = false
        let fixture = try settingsFixture { request in
            if request.url?.path == "/admin/sources/validate-param" {
                let body = try Self.body(request)
                try validations.append(XCTUnwrap(body["paramName"] as? String))
                XCTAssertEqual(body["deviceId"] as? String, "current")
                return #"{"valid":true}"#
            }
            if request.httpMethod == "PATCH" {
                let body = try Self.body(request)
                XCTAssertEqual(body["expectedRevision"] as? String, Self.revision)
                let overlay = try XCTUnwrap(body["configOverride"] as? [String: Any])
                let params = try XCTUnwrap(overlay["params"] as? [String: String])
                XCTAssertEqual(params["selectedPath"], "/example/changed")
                XCTAssertNil(params["legacyPath"])
                patched = true
                return "{}"
            }
            return nil
        }
        defer { fixture.close() }
        let flow = try settingsFlow(fixture)
        await flow.load()
        XCTAssertNil(flow.error)
        XCTAssertTrue(flow.canEditSelectedHost)
        XCTAssertEqual(flow.localParams.map(\.name), ["selectedPath"])
        XCTAssertEqual(flow.localValues["selectedPath"], "/example/current")
        XCTAssertNil(flow.selectedDescriptor?.devices)
        flow.localValues["selectedPath"] = "/example/changed"
        await flow.saveLocal()
        XCTAssertTrue(patched)
        XCTAssertEqual(validations, ["selectedPath"])
        XCTAssertNil(flow.error)
    }

    func testFailedScopedRefreshRetainsDraftButDisablesEditingAndNeverUsesFleetMetadata() async throws {
        var unavailable = false
        let fixture = try settingsFixture { request in
            if request.url?.path == "/admin/sources/descriptors", unavailable { throw URLError(.cannotConnectToHost) }
            XCTAssertNotEqual(request.url?.path, "/admin/source-descriptors")
            XCTAssertNotEqual(request.httpMethod, "PATCH")
            return nil
        }
        defer { fixture.close() }
        let flow = try settingsFlow(fixture)
        await flow.load()
        flow.localValues["selectedPath"] = "/example/unsaved"
        unavailable = true
        await flow.load()
        XCTAssertNotNil(flow.error)
        XCTAssertEqual(flow.localValues["selectedPath"], "/example/unsaved")
        XCTAssertFalse(flow.canEditSelectedHost)
        await flow.saveLocal()
        XCTAssertFalse(flow.removalRequested)
        XCTAssertNotNil(flow.snapshot, "Global review and removal must remain available")
    }

    func testFailedDeviceSwitchDoesNotRelabelAnotherMembersDraft() async throws {
        let fixture = try settingsFixture { request in
            if request.url?.path == "/admin/sources/descriptors", request.url?.query?.contains("legacy") == true {
                throw URLError(.networkConnectionLost)
            }
            return nil
        }
        defer { fixture.close() }
        let flow = try settingsFlow(fixture)
        await flow.load()
        flow.localValues["selectedPath"] = "/example/draft"
        await flow.selectDevice("legacy")
        XCTAssertEqual(flow.selectedDeviceId, "current")
        XCTAssertEqual(flow.localValues["selectedPath"], "/example/draft")
        XCTAssertNotNil(flow.error)
        XCTAssertFalse(flow.canEditSelectedHost)
    }

    func testChoosingAnotherMemberUsesItsSchemaWithoutInheritingExplicitNone() async throws {
        let fixture = try settingsFixture { _ in nil }
        defer { fixture.close() }
        let flow = try settingsFlow(fixture)
        await flow.load()
        await flow.selectDevice("legacy")
        XCTAssertNil(flow.error)
        XCTAssertTrue(flow.canEditSelectedHost)
        XCTAssertEqual(flow.selectedDeviceId, "legacy")
        XCTAssertEqual(flow.localParams.map(\.name), ["legacyPath"])
        XCTAssertEqual(flow.localValues, ["legacyPath": "/example/legacy"])
        XCTAssertNil(flow.selectedDescriptor?.permissionRequirements)
        XCTAssertEqual(flow.selectedDescriptor?.authType, "legacy-auth")
    }

    func testSchemaChangeBeforeSavePreservesDraftAndRefusesValidationAndMutation() async throws {
        var changed = false
        let fixture = try settingsFixture { request in
            XCTAssertEqual(request.httpMethod, "GET", "A changed schema cannot validate or save a stale form")
            if changed, request.url?.path == "/admin/sources/descriptors" {
                return #"{"deviceId":"current","items":[\#(Self.legacy)]}"#
            }
            return nil
        }
        defer { fixture.close() }
        let flow = try settingsFlow(fixture)
        await flow.load()
        flow.localValues["selectedPath"] = "/example/unsaved"
        changed = true
        await flow.saveLocal()
        XCTAssertNotNil(flow.error)
        XCTAssertEqual(flow.localValues["selectedPath"], "/example/unsaved")
        XCTAssertFalse(flow.canEditSelectedHost)
    }

    func testCancellationDuringScopedLoadCannotPublishEditableSettings() async throws {
        let entered = expectation(description: "selected metadata requested")
        let release = DispatchSemaphore(value: 0)
        let fixture = try settingsFixture { request in
            if request.url?.path == "/admin/sources/descriptors" {
                entered.fulfill()
                guard release.wait(timeout: .now() + 5) == .success else { throw URLError(.timedOut) }
            }
            return nil
        }
        defer { release.signal()
            fixture.close()
        }
        let flow = try settingsFlow(fixture)
        let loading = Task { await flow.load() }
        await fulfillment(of: [entered], timeout: 3)
        flow.cancelPresentation()
        release.signal()
        await loading.value
        XCTAssertNil(flow.selectedDescriptor)
        XCTAssertFalse(flow.canEditSelectedHost)
        XCTAssertTrue(flow.localValues.isEmpty)
    }

    func testMemberRemovedDuringMetadataLoadCannotEnableEditing() async throws {
        var checks = 0
        let fixture = try settingsFixture { request in
            if request.url?.path == "/admin/sources" {
                checks += 1
                if checks > 1 { return #"{"items":[\#(Self.source.replacingOccurrences(of: #"["current","legacy"]"#, with: "[]"))]}"# }
            }
            return nil
        }
        defer { fixture.close() }
        let flow = try settingsFlow(fixture)
        await flow.load()
        XCTAssertNotNil(flow.error)
        XCTAssertNil(flow.selectedDescriptor)
        XCTAssertFalse(flow.canEditSelectedHost)
    }

    private static let revision = String(repeating: "a", count: 64)
    private static let source = #"{"id":"fixture-source","type":"invented","accountId":"fictional-account","enabled":false,"deviceId":"current","members":["current","legacy"],"config":{"params":{"selectedPath":"/example/current","legacyPath":"/example/legacy"}}}"#
    private static let current = #"{"id":"invented","name":"Fictional source","description":"Fixture","hasAuthFlow":true,"hasDiscover":false,"authType":"selected-auth","permissionRequirements":[],"params":[{"name":"selectedPath","label":"Selected folder","type":"path","scope":"member"}]}"#
    private static let legacy = #"{"id":"invented","name":"Fictional source","description":"Fixture","hasAuthFlow":false,"hasDiscover":false,"authType":"legacy-auth","params":[{"name":"legacyPath","label":"Legacy folder","type":"path","scope":"member"}]}"#

    private func settingsFlow(_ fixture: ScopedDescriptorFixture) throws -> DesktopSourceSettingsFlow {
        try DesktopSourceSettingsFlow(
            source: JSONDecoder().decode(DesktopSource.self, from: Data(Self.source.utf8)),
            descriptor: JSONDecoder().decode(DesktopDescriptor.self, from: Data(Self.legacy.utf8)),
            api: fixture.api
        )
    }

    private func settingsFixture(_ override: @escaping (URLRequest) throws -> String?) throws -> ScopedDescriptorFixture {
        try ScopedDescriptorFixture { request in
            if let response = try override(request) { return response }
            switch request.url?.path {
            case "/admin/sources": return #"{"items":[\#(Self.source)]}"#
            case "/admin/devices": return #"{"items":[{"id":"current","name":"Current computer","kind":"collector"},{"id":"legacy","name":"Legacy computer","kind":"collector"}]}"#
            case "/admin/sources/descriptors":
                let device = try URLComponents(url: XCTUnwrap(request.url), resolvingAgainstBaseURL: false)?.queryItems?.first?.value ?? ""
                return #"{"deviceId":"\#(device)","items":[\#(device == "current" ? Self.current : Self.legacy)]}"#
            case "/admin/sources/fixture-source", "/admin/sources/fixture-source/members/current",
                 "/admin/sources/fixture-source/members/legacy":
                return #"{"source":\#(Self.source),"revision":"\#(Self.revision)"}"#
            default: XCTFail("Unexpected selected metadata request")
                throw URLError(.unsupportedURL)
            }
        }
    }

    private nonisolated static func body(_ request: URLRequest) throws -> [String: Any] {
        if let data = request.httpBody { return try JSONSerialization.jsonObject(with: data) as? [String: Any] ?? [:] }
        guard let stream = request.httpBodyStream else { return [:] }
        stream.open()
        defer { stream.close() }
        var data = Data(), bytes = [UInt8](repeating: 0, count: 1024)
        while stream.hasBytesAvailable {
            let count = stream.read(&bytes, maxLength: bytes.count)
            if count <= 0 { break }
            data.append(contentsOf: bytes.prefix(count))
        }
        return try JSONSerialization.jsonObject(with: data) as? [String: Any] ?? [:]
    }
}

@MainActor
private final class ScopedDescriptorFixture {
    let api: DesktopAPI
    private let session: URLSession
    private let host: String
    init(_ reply: @escaping (URLRequest) throws -> String) throws {
        let host = "scoped-\(UUID().uuidString.lowercased()).example.com"
        self.host = host
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [ScopedDescriptorURLProtocol.self]
        session = URLSession(configuration: config)
        let connection = try JSONDecoder().decode(
            DesktopConnection.self,
            from: Data(#"{"url":"https://\#(host)","token":"fixture-token","collectorDeviceId":"current"}"#.utf8)
        )
        api = try DesktopAPI(connection: connection, sessionOverride: session)
        ScopedDescriptorURLProtocol.registry.set(host, reply)
    }

    func close() {
        session.invalidateAndCancel()
        ScopedDescriptorURLProtocol.registry.remove(host)
    }
}

private final class ScopedDescriptorRegistry: @unchecked Sendable {
    private let lock = NSLock()
    private var entries: [String: (URLRequest) throws -> String] = [:]
    func set(_ host: String, _ reply: @escaping (URLRequest) throws -> String) {
        lock.lock()
        defer { lock.unlock() }
        entries[host] = reply
    }

    func remove(_ host: String) {
        lock.lock()
        defer { lock.unlock() }
        entries.removeValue(forKey: host)
    }

    func get(_ host: String) -> ((URLRequest) throws -> String)? {
        lock.lock()
        defer { lock.unlock() }
        return entries[host]
    }
}

private final class ScopedDescriptorURLProtocol: URLProtocol {
    static let registry = ScopedDescriptorRegistry()
    override class func canInit(with request: URLRequest) -> Bool {
        true
    }

    override class func canonicalRequest(for request: URLRequest) -> URLRequest {
        request
    }

    override func startLoading() {
        do {
            let reply = try XCTUnwrap(try Self.registry.get(XCTUnwrap(request.url?.host)))
            XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer fixture-token")
            let data = try Data(reply(request).utf8)
            let response = try XCTUnwrap(HTTPURLResponse(
                url: XCTUnwrap(request.url),
                statusCode: 200,
                httpVersion: "HTTP/1.1",
                headerFields: nil
            ))
            client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
            client?.urlProtocol(self, didLoad: data)
            client?.urlProtocolDidFinishLoading(self)
        } catch { client?.urlProtocol(self, didFailWithError: error) }
    }

    override func stopLoading() {}
}
