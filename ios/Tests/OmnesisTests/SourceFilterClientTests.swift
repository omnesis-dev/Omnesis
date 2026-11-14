// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

@testable import Omnesis
import XCTest

final class AccessSourceFilterClientTests: XCTestCase {
    private final class Session: URLSessionLike, @unchecked Sendable {
        var requests: [URLRequest] = []
        var body = "{}"
        var status = 200
        func data(for request: URLRequest) async throws -> (Data, URLResponse) {
            requests.append(request)
            return (Data(body.utf8), HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: "HTTP/1.1", headerFields: nil)!)
        }
    }

    private func client(_ session: Session) throws -> AccessClient {
        try AccessClient(baseURL: XCTUnwrap(URL(string: "https://gateway.example.org")), token: "fictional-owner", session: session)
    }

    func testOldEditorCannotReadOptionsThroughChangedPairing() async throws {
        let oldSession = Session(), newSession = Session()
        let old = try AccessClient(baseURL: XCTUnwrap(URL(string: "https://old.example.org")), token: "old-owner", session: oldSession)
        let changedGateway = try AccessClient(
            baseURL: XCTUnwrap(URL(string: "https://new.example.org")),
            token: "new-owner",
            session: newSession
        )
        let changedToken = AccessClient(baseURL: old.baseURL, token: "new-owner", session: newSession)
        for current in [changedGateway, changedToken] {
            do {
                _ = try await old.authorized(for: current)
                    .scopeOptions(sourceId: "gmail:mail@example.org", field: "extra.labelIds", query: "Design")
                XCTFail("An old source draft must not cross a pairing boundary")
            } catch GatewayClient.Error.unauthorized {} catch { XCTFail("Unexpected error: \(error)") }
        }
        XCTAssertTrue(oldSession.requests.isEmpty)
        XCTAssertTrue(newSession.requests.isEmpty)
        XCTAssertTrue(try old.authorized(for: old) === old)
    }

    func testPolicyPreviewPayloadsSendOnlyEachEntrysWireKeys() async throws {
        let person = ScopeRef.person(label: "Jamie Lopez", identifiers: [.init(type: "email", value: "jamie@example.org")])
        let cases: [(String, [ScopeRef])] = [
            ("gmail:mail@example.org", [.tree(field: "extra.labelIds", id: "Label_design"), person]),
            ("google-drive:files@example.org", [.tree(field: "extra.folderIds", id: "projects")]),
            ("whatsapp-messages:+15550100111", [.membership(field: "extra.chatJid", id: "chat-workshop-planning")]),
            ("claude-code:studio", [.tree(field: "extra.projectFolder", id: "", device: "device-studio-mac")]),
        ]
        for (sourceId, refs) in cases {
            let session = Session()
            session.body = #"{"status":"pending","retryAfterMs":1500}"#
            var policy = ScopePolicy.empty(sourceId: sourceId, levelId: "example-level", capability: "answer")
            policy.rules[0].match = refs
            let response = try await client(session).scopePreview(policy)
            XCTAssertEqual(response, .pending(retryAfterMs: 1500))
            let body = try XCTUnwrap(session.requests.last?.httpBody)
            let root = try XCTUnwrap(JSONSerialization.jsonObject(with: body) as? [String: Any])
            let encodedPolicy = try XCTUnwrap(root["policy"] as? [String: Any])
            XCTAssertNil(encodedPolicy["maxAge"])
            let rules = try XCTUnwrap(encodedPolicy["rules"] as? [[String: Any]])
            let matches = try XCTUnwrap(rules.first?["match"] as? [[String: Any]])
            for (ref, sent) in zip(refs, matches) {
                let expected: Set<String> = ref.isPerson ? ["capability", "label", "identifiers"]
                    : ref.device == nil ? ["capability", "field", "id"] : ["capability", "field", "id", "device"]
                XCTAssertEqual(Set(sent.keys), expected)
            }
        }
    }

    func testPickerEncodesAccountFieldQueryAndDeviceAsSeparateComponents() async throws {
        let session = Session()
        session.body = """
        {"sourceId":"scope-chat:one/account","field":"extra.projectFolder","nextCursor":"next-page","retryAfterMs":1500,
         "items":[{"ref":{"capability":"tree","field":"extra.projectFolder","id":"~/work/ledger","device":"device-studio-mac"},
                   "label":"~/work/ledger","shortLabel":"ledger","count":null,"parentId":"~/work","hasChildren":false,"depth":2}]}
        """
        let value = try await client(session).scopeOptions(
            sourceId: "scope-chat:one/account",
            field: "extra.projectFolder",
            query: "+44 7700 900123 & archive",
            parentId: "folder/c++",
            device: "device-studio-mac",
            cursor: "page+two"
        )
        XCTAssertEqual(value.nextCursor, "next-page")
        XCTAssertEqual(value.retryAfterMs, 1500)
        XCTAssertEqual(value.items.map(\.shortLabel), ["ledger"])
        XCTAssertEqual(value.items.map(\.count), [nil])
        XCTAssertEqual(value.items.first?.ref.device, "device-studio-mac")
        let request = try XCTUnwrap(session.requests.first)
        XCTAssertTrue(try XCTUnwrap(request.url?.absoluteString.contains("scope-chat%3Aone%2Faccount/options")))
        let query = try XCTUnwrap(try URLComponents(url: XCTUnwrap(request.url), resolvingAgainstBaseURL: false)?.queryItems)
        XCTAssertEqual(query.first { $0.name == "field" }?.value, "extra.projectFolder")
        XCTAssertEqual(query.first { $0.name == "q" }?.value, "+44 7700 900123 & archive")
        XCTAssertEqual(query.first { $0.name == "parentId" }?.value, "folder/c++")
        // The gateway reads a bare "+" in a query as a space, so every "+" is sent encoded.
        let raw = try XCTUnwrap(request.url?.query)
        XCTAssertFalse(raw.contains("+"), raw)
        XCTAssertTrue(raw.contains("q=%2B44"), raw)
        XCTAssertTrue(raw.contains("cursor=page%2Btwo"), raw)
        XCTAssertEqual(query.first { $0.name == "device" }?.value, "device-studio-mac")
        XCTAssertEqual(query.first { $0.name == "cursor" }?.value, "page+two")
        XCTAssertEqual(request.value(forHTTPHeaderField: "Cache-Control"), "no-store")
        XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer fictional-owner")
    }

    func testPreviewDecodesTheGatewaysSentencesForRecordsItCannotDecide() async throws {
        let session = Session()
        session.body = """
        {"status":"ready","sourceId":"gmail:mail@example.org","total":1200,"visible":1061,"hidden":139,"tooOld":0,"unmatched":2,
         "tooOldText":null,"unmatchedText":"2 records can’t be matched to a person and stay hidden.","connected":true,
         "items":[{"ref":{"capability":"tree","field":"extra.labelIds","id":"Label_12"},"label":"Finance","count":131,"depth":0},
                  {"ref":{"capability":"tree","field":"extra.labelIds","id":"Label_40"},"label":"Label_40","count":0,"missing":true,
                   "reason":"not-in-list"},
                  {"ref":{"capability":"tree","field":"extra.labelIds","id":"Label_41"},"label":"Label_41","count":0,"missing":true,
                   "reason":"list-gone"}]}
        """
        var policy = ScopePolicy.empty(sourceId: "gmail:mail@example.org", levelId: "new", capability: "answer")
        policy.rules[0].match = [.person(label: "Maya", identifiers: [.init(type: "email", value: "maya@example.org")])]
        let response = try await client(session).scopePreview(policy)
        let value = try XCTUnwrap(response.ready)
        XCTAssertEqual(value.hidden, 139)
        XCTAssertEqual(value.undecidedLines, ["2 records can’t be matched to a person and stay hidden."])
        XCTAssertTrue(value.connected)
        XCTAssertEqual(value.items.map(\.missing), [nil, true, true])
        XCTAssertEqual(value.items.map(\.reason), [nil, "not-in-list", "list-gone"])
        XCTAssertEqual(
            scopeItemHints(value, fields: []).map { scopeItemNote($0.ref, hint: $0) },
            [nil, "No longer in this account", "Name unavailable"]
        )
        let request = try XCTUnwrap(session.requests.first)
        XCTAssertEqual(request.httpMethod, "POST")
        XCTAssertFalse(try XCTUnwrap(try String(data: XCTUnwrap(request.httpBody), encoding: .utf8)?.contains("personId")))
        let both = ScopePreview(
            sourceId: "google-drive:files@example.org",
            total: 120,
            visible: 18,
            hidden: 102,
            tooOld: 6,
            unmatched: 0,
            tooOldText: "6 older items could not be resynced and stay hidden from agents using this filter.",
            unmatchedText: "0 records can’t be matched to a folder and stay hidden.",
            items: []
        )
        XCTAssertEqual(both.undecidedLines, ["6 older items could not be resynced and stay hidden from agents using this filter."])
    }

    func testEditorDecodesEveryFieldStateAndCountsStillBeingWorkedOut() async throws {
        let session = Session()
        session.body = """
        {"sourceId":"gmail:mail@example.org","sourceType":"gmail","devices":[{"id":"dev_studio","name":"Studio Mac"}],
         "showDeviceLevel":false,"profile":"declared","profileText":null,"connected":true,"retryAfterMs":1500,
         "resync":{"state":"needs-resync","fields":["$people","extra.labelIds"],
                   "text":"Label and people filters need Gmail to be resynced. Your emails stay searchable meanwhile."},
         "fields":[
          {"field":"$people","capability":"person","noun":{"one":"person","many":"people"},"picker":"search","scope":"global",
           "identifiers":["email","domain"],"state":{"status":"ready"},
           "counts":{"status":"ready","tooOld":0,"unmatched":0,"tooOldText":null,"unmatchedText":null}},
          {"field":"extra.labelIds","capability":"tree","noun":{"one":"label","many":"labels"},"picker":"tree","scope":"global",
           "levels":[{"one":"label","many":"labels"}],"inside":{"one":"label","many":"labels"},"insideText":"Includes the labels inside.",
           "state":{"status":"needs-resync","cost":"This reads about 95,000 messages a day.",
                    "text":"Label filters need Gmail to be resynced."},"counts":{"status":"pending"}},
          {"field":"a","capability":"tree","noun":{"one":"a","many":"as"},"picker":"tree","scope":"device",
           "state":{"status":"resyncing","processed":212,"total":900,"text":"Resyncing Gmail: 212 of about 900."},
           "counts":{"status":"pending"}},
          {"field":"b","capability":"tree","noun":{"one":"b","many":"bs"},"picker":"tree","scope":"device",
           "state":{"status":"collector-behind","devices":[{"id":"dev_studio","name":"Studio Mac"}],
                    "text":"Update Omnesis on Studio Mac to use these filters."},"counts":{"status":"pending"}},
          {"field":"c","capability":"membership","noun":{"one":"c","many":"cs"},"picker":"search","scope":"global",
           "state":{"status":"gateway-behind","text":"Update this Omnesis gateway to use these filters."},"counts":{"status":"pending"}},
          {"field":"d","capability":"membership","noun":{"one":"d","many":"ds"},"picker":"search","scope":"global",
           "state":{"status":"list-pending","text":"Waiting for Gmail to send its list of labels."},"counts":{"status":"pending"}},
          {"field":"e","capability":"membership","noun":{"one":"e","many":"es"},"picker":"search","scope":"global",
           "state":{"status":"a-state-from-the-future"},"counts":{"status":"pending"}},
          {"field":"f","capability":"membership","noun":{"one":"f","many":"fs"},"picker":"search","scope":"global",
           "state":{"status":"disconnected","text":"This account is no longer connected."},"counts":{"status":"pending"}}
         ]}
        """
        let editor = try await client(session).filterEditor(sourceId: "gmail:mail@example.org")
        XCTAssertEqual(session.requests.first?.url?.path, "/admin/access/source-filters/gmail:mail@example.org")
        XCTAssertEqual(editor.devices, [.init(id: "dev_studio", name: "Studio Mac")])
        XCTAssertEqual(editor.resync?.fields, ["$people", "extra.labelIds"])
        XCTAssertEqual(
            editor.resync?.fieldState,
            .needsResync(cost: nil, text: "Label and people filters need Gmail to be resynced. Your emails stay searchable meanwhile.")
        )
        XCTAssertEqual(editor.fields.map(\.state), [
            .ready,
            .needsResync(cost: "This reads about 95,000 messages a day.", text: "Label filters need Gmail to be resynced."),
            .resyncing(processed: 212, total: 900, text: "Resyncing Gmail: 212 of about 900."),
            .collectorBehind(
                devices: [.init(id: "dev_studio", name: "Studio Mac")],
                text: "Update Omnesis on Studio Mac to use these filters."
            ),
            .gatewayBehind(text: "Update this Omnesis gateway to use these filters."),
            .listPending(text: "Waiting for Gmail to send its list of labels."),
            .unsupported,
            .disconnected(text: "This account is no longer connected."),
        ])
        XCTAssertEqual(editor.profile, "declared")
        XCTAssertNil(editor.profileText)
        XCTAssertTrue(editor.connected)
        XCTAssertEqual(editor.fields[0].counts, .ready(tooOld: 0, unmatched: 0, tooOldText: nil, unmatchedText: nil))
        XCTAssertEqual(editor.fields[1].counts, .pending)
        XCTAssertEqual(editor.fields[1].insideText, "Includes the labels inside.")
        XCTAssertEqual(editor.fields.map(\.perDevice), [false, false, true, true, false, false, false, false])
        XCTAssertEqual(editor.fields.map(\.state.isReady), [true, false, false, false, false, false, false, false])
        XCTAssertEqual(editor.fields[6].state.text, "This version of Omnesis can’t use this filter yet.")
        XCTAssertEqual(editor.fields[7].state.text, "This account is no longer connected.")
        XCTAssertTrue(editor.settling)
        XCTAssertEqual(editor.field("extra.labelIds")?.noun.many, "labels")
        let settled = SourceFilterEditor(sourceId: "x", sourceType: "x", fields: [editor.fields[0], editor.fields[1], editor.fields[3]])
        XCTAssertFalse(settled.settling, "Nothing changes by itself without counts or a field on its way to ready")
        XCTAssertTrue(SourceFilterEditor(sourceId: "x", sourceType: "x", fields: [editor.fields[2]]).settling)
        XCTAssertTrue(SourceFilterEditor(sourceId: "x", sourceType: "x", fields: [editor.fields[5]]).settling)
    }
}

/// What the gateway says about an account a filter cannot be edited on: one that is gone, or one whose source has
/// not said what can be filtered yet.
extension AccessSourceFilterClientTests {
    func testAGoneAccountsEditorAndPreviewSayItIsNoLongerConnected() async throws {
        let gone = "This account is no longer connected. Its saved filter entries are kept until you remove them."
        let session = Session()
        session.body = """
        {"sourceId":"whatsapp-messages:+15550100123","sourceType":"whatsapp-messages","devices":[],"showDeviceLevel":false,
         "profile":"declared","profileText":"\(gone)","connected":false,
         "fields":[{"field":"extra.chatJid","capability":"membership","noun":{"one":"chat","many":"chats"},"picker":"search",
                    "scope":"global","state":{"status":"disconnected","text":"\(gone)"},
                    "counts":{"status":"ready","tooOld":0,"unmatched":0,"tooOldText":null,"unmatchedText":null}}]}
        """
        let editor = try await client(session).filterEditor(sourceId: "whatsapp-messages:+15550100123")
        XCTAssertFalse(editor.connected)
        XCTAssertEqual(editor.profileText, gone)
        XCTAssertEqual(editor.fields.first?.state, .disconnected(text: gone))
        XCTAssertFalse(editor.settling)
        session.body = """
        {"status":"ready","sourceId":"whatsapp-messages:+15550100123","connected":false,"total":0,"visible":0,"hidden":0,
         "tooOld":0,"unmatched":0,"tooOldText":null,"unmatchedText":null,
         "items":[{"ref":{"capability":"membership","field":"extra.chatJid","id":"chat-1"},"label":"Workshop planning","count":0}]}
        """
        var policy = ScopePolicy.empty(sourceId: "whatsapp-messages:+15550100123", levelId: "level", capability: "answer")
        policy.rules[0].match = [.membership(field: "extra.chatJid", id: "chat-1")]
        let response = try await client(session).scopePreview(policy)
        let preview = try XCTUnwrap(response.ready)
        XCTAssertFalse(preview.connected)
        // A gone account's entries keep their last known names, and nothing is counted for them.
        let hints = scopeItemHints(preview, fields: editor.fields)
        XCTAssertEqual(hints.map(\.label), ["Workshop planning"])
        XCTAssertEqual(hints.map(\.count), [nil])
    }

    func testAnEditorWithoutAProfileCarriesTheGatewaysReason() throws {
        let body = """
        {"sourceId":"notes:one","sourceType":"notes","devices":[],"showDeviceLevel":false,"profile":"no-profile",
         "profileText":"Filters for this account are available after its first sync.","connected":true,"fields":[]}
        """
        let editor = try JSONDecoder().decode(SourceFilterEditor.self, from: Data(body.utf8))
        XCTAssertEqual(editor.profile, "no-profile")
        XCTAssertEqual(editor.profileText, "Filters for this account are available after its first sync.")
        XCTAssertTrue(editor.fields.isEmpty)
        let older = try JSONDecoder().decode(SourceFilterEditor.self, from: Data(#"{"sourceId":"a","sourceType":"b","fields":[]}"#.utf8))
        XCTAssertEqual(older.profile, "declared")
        XCTAssertTrue(older.connected)
    }

    func testTypedIdentifiersAreReadByTheGateway() async throws {
        let session = Session()
        session.body = #"{"identifier":{"type":"phone","value":"+15550100142"}}"#
        let accepted = try await client(session).checkIdentifier(type: "phone", value: "00 1 (555) 010-0142")
        XCTAssertEqual(accepted, .identifier(.init(type: "phone", value: "+15550100142")))
        let request = try XCTUnwrap(session.requests.first)
        XCTAssertEqual(request.url?.path, "/admin/access/source-filters/identifiers")
        let body = try XCTUnwrap(JSONSerialization.jsonObject(with: XCTUnwrap(request.httpBody)) as? [String: String])
        XCTAssertEqual(body, ["type": "phone", "value": "00 1 (555) 010-0142"])
        session.body = #"{"error":"Enter a valid phone number. Include the international country code."}"#
        let refused = try await client(session).checkIdentifier(type: "phone", value: "+44 (0)7700 900123")
        XCTAssertEqual(refused, .problem("Enter a valid phone number. Include the international country code."))
    }

    func testDocumentFilterDetailsAndWhoCanReadItDecode() async throws {
        let session = Session()
        session.body = """
        {"documentId":"doc_8d1e","sourceVersion":2,"fields":[
          {"field":"extra.labelIds","noun":{"one":"label","many":"labels"},"state":"present","stateText":"",
           "items":[{"id":"Label_12","label":"Finance","listed":true},{"id":"INBOX","label":"Inbox","listed":true}]},
          {"field":"$people","noun":{"one":"person","many":"people"},"state":"present","stateText":"",
           "items":[{"id":"maya.reeves@example.org","label":"Maya Reeves","listed":true}]},
          {"field":"extra.folderIds","noun":{"one":"folder","many":"folders"},"state":"too-old",
           "stateText":"Too old to carry its folders. Resync Google Drive to add them.","items":[]},
          {"field":"extra.chatJid","noun":{"one":"chat","many":"chats"},"state":"present","stateText":"","items":[]}]}
        """
        let details = try await client(session).documentFilterDetails(documentId: "doc_8d1e")
        XCTAssertEqual(session.requests.last?.url?.path, "/admin/documents/doc_8d1e/filter-details")
        XCTAssertEqual(documentFilterDetailRows(details), [
            .init(key: "Labels", value: "Finance, Inbox"),
            .init(key: "Person", value: "Maya Reeves"),
            .init(key: "Folders", value: "Too old to carry its folders. Resync Google Drive to add them."),
            .init(key: "Chats", value: "None"),
            .init(key: "Source version", value: "2"),
        ])
        // A source no filter can use has no details, so the inspector shows no section rather than a lone version.
        XCTAssertEqual(documentFilterDetailRows(DocumentFilterDetails(documentId: "doc_8d1e", sourceVersion: 2, fields: [])), [])
        session.body = """
        {"documentId":"doc_8d1e","title":"Q4 budget review","sourceId":"gmail:maya.reeves@example.org",
         "sourceName":"Gmail (maya.reeves@example.org)","sourceVersion":2,
         "notes":{"answer":"“Can read” under Answer means Omnesis may use this document when answering that agent.",
                  "owner":"This page is for you, the owner."},
         "levels":[{"id":"lvl_7c21","name":"Coding assistant",
           "agents":[{"id":"grt_51aa","name":"Claude Code on Studio Mac","kind":"connection"},
                     {"id":"dev_1","name":"Kitchen speaker","kind":"device"}],
           "answer":{"readable":true,"code":"readable","text":"This account is shared with all content"},
           "direct":{"readable":false,"code":"hidden-by-item","text":"Hidden by: label Finance"}},
          {"id":"lvl_90fe","name":"Travel planner","agents":[],
           "answer":{"readable":false,"code":"account-not-shared","text":"This account is not shared"},
           "direct":{"readable":false,"code":"permission-not-granted","text":"Direct is not granted on this level"}}]}
        """
        let audit = try await client(session).documentAccess(documentId: "doc_8d1e")
        XCTAssertEqual(session.requests.last?.url?.path, "/admin/documents/doc_8d1e/access")
        XCTAssertEqual(audit.levels.map(\.name), ["Coding assistant", "Travel planner"])
        XCTAssertEqual(audit.levels[0].direct, .init(readable: false, code: "hidden-by-item", text: "Hidden by: label Finance"))
        let usage = AccessLevelUsage(agents: audit.levels[0].agents)
        XCTAssertEqual(usage.connections, ["Claude Code on Studio Mac"])
        XCTAssertEqual(usage.integrations, ["Kitchen speaker"])
        XCTAssertTrue(usage.inUse)
        XCTAssertFalse(AccessLevelUsage(agents: audit.levels[1].agents).inUse)
    }

    func testLevelUpdateCarriesBothPreviousFilterRevisionsIncludingRemovedCapabilities() async throws {
        let session = Session()
        session.status = 409
        session.body = "{\"error\":\"stale-filter-revision\"}"
        let client = try AccessClient(
            baseURL: XCTUnwrap(URL(string: "https://gateway.example")),
            token: "fictional-owner",
            session: session
        )
        do {
            _ = try await client.updateLevel(
                id: "level-example",
                name: "Research assistant",
                rules: [.notes],
                expectedRevision: 7,
                expectedFilterRevisions: ["answer": 4, "direct": 2]
            )
            XCTFail("Stale edits must be refused")
        } catch GatewayClient.Error.serverError(let status, _) { XCTAssertEqual(status, 409) }
        let request = try XCTUnwrap(session.requests.first)
        let body = try XCTUnwrap(try JSONSerialization.jsonObject(with: XCTUnwrap(request.httpBody)) as? [String: Any])
        XCTAssertEqual(body["expectedRevision"] as? Int, 7)
        XCTAssertEqual(body["expectedFilterRevisions"] as? [String: Int], ["answer": 4, "direct": 2])
        XCTAssertEqual(session.requests.count, 1)
    }
}

private actor ScopeReadProbe {
    private var continuations: [CheckedContinuation<Data, Never>] = []
    private(set) var starts = 0
    private(set) var active = 0
    private(set) var peak = 0
    let firstTwo: XCTestExpectation
    let allThree: XCTestExpectation
    init(firstTwo: XCTestExpectation, allThree: XCTestExpectation) {
        self.firstTwo = firstTwo
        self.allThree = allThree
    }

    func run() async -> Data {
        starts += 1
        active += 1
        peak = max(peak, active)
        if starts <= 2 { firstTwo.fulfill() }
        allThree.fulfill()
        let result = await withCheckedContinuation { continuations.append($0) }
        active -= 1
        return result
    }

    func completePending() {
        let pending = continuations
        continuations = []
        pending.forEach { $0.resume(returning: Data("result".utf8)) }
    }
}

extension AccessSourceFilterClientTests {
    func testCancelledConsumersKeepPhysicalReadBudgetUntilTransportCompletes() async throws {
        let coordinator = ScopeReadCoordinator()
        let firstTwo = expectation(description: "two physical reads")
        firstTwo.expectedFulfillmentCount = 2
        let allThree = expectation(description: "third starts after capacity is released")
        allThree.expectedFulfillmentCount = 3
        let probe = ScopeReadProbe(firstTwo: firstTwo, allThree: allThree)
        let first = Task { try await coordinator.read(key: "gateway-a/owner/source/options") { await probe.run() } }
        let duplicate = Task { try await coordinator.read(key: "gateway-a/owner/source/options") { await probe.run() } }
        let second = Task { try await coordinator.read(key: "gateway-a/owner/source/preview") { await probe.run() } }
        let third = Task { try await coordinator.read(key: "gateway-b/other/source/options") { await probe.run() } }
        await fulfillment(of: [firstTwo], timeout: 3)
        first.cancel()
        let startsBeforeRelease = await probe.starts
        XCTAssertEqual(startsBeforeRelease, 2)
        await probe.completePending()
        await fulfillment(of: [allThree], timeout: 3)
        await probe.completePending()
        do { _ = try await first.value
            XCTFail("Cancelled consumer should not accept a result")
        } catch is CancellationError {}
        _ = try await duplicate.value
        _ = try await second.value
        _ = try await third.value
        let peak = await probe.peak
        let starts = await probe.starts
        XCTAssertEqual(peak, 2)
        XCTAssertEqual(starts, 3)
    }
}

private actor ScopeReadCounter {
    private(set) var count = 0
    func next() -> Data {
        count += 1
        return Data([UInt8(count)])
    }
}

extension AccessSourceFilterClientTests {
    func testImmediateFollowupReadNeverReusesCompletedValidation() async throws {
        let coordinator = ScopeReadCoordinator()
        let counter = ScopeReadCounter()
        for _ in 0 ..< 20 {
            async let first = coordinator.read(key: "same-gateway-and-source") { await counter.next() }
            async let duplicate = coordinator.read(key: "same-gateway-and-source") { await counter.next() }
            let completed = try await duplicate
            let fresh = try await coordinator.read(key: "same-gateway-and-source") { await counter.next() }
            _ = try await first
            XCTAssertGreaterThan(try XCTUnwrap(fresh.first), try XCTUnwrap(completed.first))
        }
    }
}

extension AccessSourceFilterClientTests {
    func testCancelledQueuedSearchNeverReachesTransportBeforeCurrentSearch() async throws {
        let coordinator = ScopeReadCoordinator()
        let firstTwo = expectation(description: "physical slots occupied")
        firstTwo.expectedFulfillmentCount = 2
        let allThree = expectation(description: "current fourth request starts")
        allThree.expectedFulfillmentCount = 3
        let probe = ScopeReadProbe(firstTwo: firstTwo, allThree: allThree)
        let first = Task { try await coordinator.read(key: "first") { await probe.run() } }
        let second = Task { try await coordinator.read(key: "second") { await probe.run() } }
        await fulfillment(of: [firstTwo], timeout: 3)
        let cancelled = Task {
            try await coordinator.read(key: "obsolete-query") {
                XCTFail("Cancelled queued request reached transport")
                return Data()
            }
        }
        for _ in 0 ..< 1000 {
            if await coordinator.queuedCount == 1 { break }
            await Task.yield()
        }
        let queued = await coordinator.queuedCount
        XCTAssertEqual(queued, 1)
        cancelled.cancel()
        do { _ = try await cancelled.value
            XCTFail("Expected cancellation")
        } catch is CancellationError {}
        let current = Task { try await coordinator.read(key: "current-query") { await probe.run() } }
        await probe.completePending()
        await fulfillment(of: [allThree], timeout: 3)
        await probe.completePending()
        _ = try await first.value
        _ = try await second.value
        _ = try await current.value
        let starts = await probe.starts
        XCTAssertEqual(starts, 3)
    }
}

extension AccessSourceFilterClientTests {
    func testTheAuditsAccountLineIsTheSourceNameThenTheAccount() throws {
        let json = """
        {"documentId":"doc_1","title":"Workshop planning","sourceId":"whatsapp-messages:+15550100123",
         "sourceName":"WhatsApp","sourceVersion":1,"notes":{"answer":"","owner":""},"levels":[]}
        """
        var audit = try JSONDecoder().decode(DocumentAccessAudit.self, from: Data(json.utf8))
        XCTAssertEqual(audit.sourceLine, "WhatsApp · +15550100123")
        audit.sourceId = "notes"
        XCTAssertEqual(audit.sourceLine, "WhatsApp")
    }
}
