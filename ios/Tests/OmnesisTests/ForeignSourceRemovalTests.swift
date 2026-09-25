// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

#if canImport(UIKit)
@testable import Omnesis
import XCTest

/// A gateway registry lists every device's sources. Another phone hosting
/// its own source of a type this phone also hosts says nothing about this
/// phone's source, so a source-list refresh must never switch this phone's
/// local source off because of it. This phone's own source losing its
/// membership still does.
@available(iOS 17.0, *)
@MainActor
final class ForeignSourceRemovalTests: XCTestCase {
    private let thisPhone = "dev_this_phone"
    private let otherPhone = "dev_other_phone"

    private final class StubSession: URLSessionLike, @unchecked Sendable {
        let sourcesJSON: String
        init(sourcesJSON: String) {
            self.sourcesJSON = sourcesJSON
        }

        func data(for request: URLRequest) async throws -> (Data, URLResponse) {
            let items = request.url?.path == "/admin/sources" ? sourcesJSON : "[]"
            let body = "{\"items\":\(items),\"removedSourceIds\":[],\"pageInfo\":{\"hasMore\":false,\"limit\":0}}"
            let response = HTTPURLResponse(
                url: request.url!,
                statusCode: 200,
                httpVersion: "HTTP/1.1",
                headerFields: ["Content-Type": "application/json"]
            )!
            return (Data(body.utf8), response)
        }
    }

    private func source(id: String, host: String) -> String {
        let parts = id.split(separator: ":", maxSplits: 1)
        return """
        {"id":"\(id)","type":"\(parts[0])","accountId":"\(parts[1])","deviceId":"\(host)",\
        "config":{},"enabled":true,"createdAt":0,"updatedAt":0,"members":["\(host)"],\
        "multiDeviceMode":"replicated"}
        """
    }

    private func storeWithAppleHealthEnabled() -> AppStore {
        let settings = HealthSettings(defaults: DictionaryDefaults())
        settings.appleHealthEnabled = true
        let store = AppStore(healthSettings: settings, localSourceOwner: LocalSourceOwnerRecord(defaults: DictionaryDefaults()))
        XCTAssertTrue(store.appleHealthEnabled)
        return store
    }

    private func client(_ sources: [String]) -> AdminClient {
        AdminClient(
            baseURL: URL(string: "https://stub.local")!,
            token: "t",
            session: StubSession(sourcesJSON: "[\(sources.joined(separator: ","))]")
        )
    }

    func testAnotherPhonesSourceOfTheSameTypeLeavesLocalAppleHealthEnabled() async {
        let store = storeWithAppleHealthEnabled()

        await store.refreshSourcesForTesting(
            client: client([
                source(id: "apple-health:local", host: thisPhone),
                source(id: "apple-health:fictional-other-phone", host: otherPhone),
            ]),
            localDeviceId: thisPhone
        )

        XCTAssertTrue(store.appleHealthEnabled, "another phone's Apple Health source must not disable this phone's")
    }

    func testLosingLocalMembershipStillDisablesAppleHealth() async {
        let store = storeWithAppleHealthEnabled()

        await store.refreshSourcesForTesting(
            client: client([source(id: "apple-health:local", host: otherPhone)]),
            localDeviceId: thisPhone
        )

        XCTAssertFalse(store.appleHealthEnabled, "a local source this phone no longer hosts must be switched off")
    }
}
#endif
