// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

@testable import Omnesis
import XCTest

/// The decisions the shared access screens read and change, for the level editor's draft and for the
/// new level an approval draws, and the boundary a rule decodes.
final class AccessDecisionsTests: XCTestCase {
    private let sources = [
        AccessSourceInstance(id: "scope-mail:reader@example.org", name: "Mail · reader@example.org"),
        AccessSourceInstance(id: "scope-files:reader@example.org", name: "Files"),
        AccessSourceInstance(id: "scope-chat:+15550100123", name: "Chat · +1 (555) 010-0123"),
    ]
    private var overview: AccessOverview {
        var overview = AccessOverview(
            principals: [],
            sources: sources,
            policyFamilies: [.init(id: "policy-everyday", name: "Everyday privacy", revision: "1")],
            defaultPolicyFamilyId: "policy-everyday"
        )
        overview.sourceFilters = .init(enabled: true)
        return overview
    }

    private let request = AccessAuthorizationRequest(
        id: "authorization-example",
        approvalId: "approval-example",
        status: "pending",
        clientId: "client-example",
        clientName: "Northstar Assistant",
        clientUri: nil,
        redirectOrigin: "http://127.0.0.1:49152",
        resource: "https://gateway.example.com/mcp",
        scope: "mcp answer direct",
        expiresAt: 4_000_000_000_000,
        requiresAnswer: false
    )

    private func filter(_ sourceId: String, level: String = "new") -> ScopePolicy {
        ScopePolicy(
            sourceId: sourceId,
            audience: .init(accessLevel: level, capability: "answer"),
            rules: [.init(match: [.tree(field: "extra.folderIds", id: "projects")], action: "share")],
            otherwise: "hide"
        )
    }

    /// The new level an approval of `request` opens on.
    private func approval(_ request: AccessAuthorizationRequest? = nil) -> AccessDraftDecisions {
        let request = request ?? self.request
        let draft = AccessLevelDraft.approving(request: request, overview: overview, prefill: nil)
        return AccessDraftDecisions(draft: draft, overview: overview, original: draft, answerRequired: request.requiresAnswer)
    }

    /// Answer, Direct and Notes over every account but the chat one, with one account filtered and no review.
    private func decide(_ decisions: inout AccessDraftDecisions) throws {
        decisions.setHeld("direct", true)
        decisions.setHeld("notes", true)
        let all = try XCTUnwrap(decisions.selection(settingAllowed: true, for: sources, capability: "answer"))
        decisions.setSourceSelection(all, capability: "answer")
        let withoutChat = try XCTUnwrap(decisions.selection(toggling: sources[2], capability: "answer"))
        decisions.setSourceSelection(withoutChat, capability: "answer")
        decisions.setPolicy(filter(sources[1].id), sourceId: sources[1].id, capability: "answer")
        decisions.setRelease(.unreviewed)
    }

    func testAnApprovalSendsTheRulesTheLevelEditorSavesForTheSameDecisions() throws {
        var approved = approval()
        try decide(&approved)
        let blank = AccessLevelDraft(level: nil, overview: overview)
        var edited = AccessDraftDecisions(draft: blank, overview: overview, original: blank)
        try decide(&edited)

        let sent = try XCTUnwrap(approved.sendableRules)
        XCTAssertEqual(sent, edited.draft.serializedRules, "The approval sends what the level editor would save")
        XCTAssertEqual(Set(sent.map(\.capability)), ["answer", "direct", "notes"])
        let direct = try XCTUnwrap(sent.first { $0.capability == "direct" })
        XCTAssertEqual(direct.boundary, .init(mode: .allowlist, sourceIds: [sources[1].id, sources[0].id].sorted()))
        XCTAssertEqual(direct.scopePolicies.map(\.audience.capability), ["direct"], "Direct takes Answer's filter with its sources")
        XCTAssertEqual(sent.first { $0.capability == "answer" }?.release, .unreviewed)
        XCTAssertEqual(
            accessConnectSelection(rules: approved.sendableRules, request: request),
            .connect(rules: sent, credentialLabel: "Northstar Assistant")
        )
    }

    func testTheApprovalWalksTheScreensANewLevelWalksAndKeepsDirectApartOnceChosen() throws {
        var decisions = approval()
        let flow = { accessAuthorizationFlow(choice: nil, draft: decisions.draft) }
        XCTAssertEqual(flow(), [.permissions, .answerData, .future, .release, .review])
        XCTAssertEqual(accessAuthorizationIndicatorSteps(flow()), [.permissions, .data, .review])
        decisions.setHeld("direct", true)
        XCTAssertEqual(flow(), [.permissions, .answerData, .directChoice, .future, .release, .review])
        XCTAssertEqual(decisions.newSourceCapabilities, ["answer"])
        XCTAssertEqual(decisions.newSourcesHeading("answer"), "Answer and Direct")
        XCTAssertEqual(decisions.newSourcesSummary, "Answer: Blocked\nDirect: Blocked", "A summary names each capability")
        XCTAssertEqual(decisions.dataSummary("direct"), "Same sources and filters as Answer")
        XCTAssertEqual(decisions.decisionLines.map(\.step), [.permissions, .answerData, .directChoice, .future, .release])

        let all = try XCTUnwrap(decisions.selection(settingAllowed: true, for: sources, capability: "answer"))
        decisions.setSourceSelection(all, capability: "answer")
        decisions.setDirectSameAsAnswer(false)
        XCTAssertEqual(flow(), decisions.draft.creationSteps)
        XCTAssertEqual(flow(), [.permissions, .answerData, .directChoice, .directData, .future, .release, .review])
        XCTAssertEqual(decisions.decisionLines.map(\.step), [.permissions, .answerData, .directData, .future, .release])
        XCTAssertEqual(decisions.newSourceCapabilities, ["answer", "direct"])
        let onlyMail = try XCTUnwrap(decisions.selection(settingAllowed: false, for: Array(sources.dropFirst()), capability: "direct"))
        decisions.setSourceSelection(onlyMail, capability: "direct")
        XCTAssertEqual(decisions.allowedCountLabel("answer"), "3 of 3 allowed")
        XCTAssertEqual(decisions.allowedCountLabel("direct"), "1 of 3 allowed")
        XCTAssertEqual(decisions.dataSummary("direct"), "1 account selected · all content")
        let automatic = try XCTUnwrap(decisions.selection(allowingNewSources: true, capability: "direct"))
        decisions.setSourceSelection(automatic, capability: "direct")
        XCTAssertEqual(decisions.newSourcesSummary, "Answer: Blocked\nDirect: Automatic")
        let sent = try XCTUnwrap(decisions.sendableRules)
        XCTAssertEqual(sent.first { $0.capability == "direct" }?.boundary.mode, .denylist)

        decisions.setHeld("answer", false)
        decisions.setHeld("direct", false)
        decisions.setHeld("notes", true)
        XCTAssertEqual(flow(), [.permissions, .review])
        XCTAssertEqual(accessAuthorizationIndicatorSteps(flow()), [.permissions, .review])
    }

    func testAStepNamesWhatStopsItAndAnAgentThatNeedsAnswerKeepsIt() {
        var decisions = approval()
        XCTAssertEqual(decisions.problem(.answerData), "Select at least one source for Answer.")
        XCTAssertNil(decisions.problem(.release))
        decisions.setHeld("answer", false)
        XCTAssertEqual(decisions.problem(.permissions), "Choose at least one permission.")
        XCTAssertNil(decisions.release)

        let needsAnswer = AccessAuthorizationRequest(
            id: request.id,
            approvalId: request.approvalId,
            status: "pending",
            clientId: request.clientId,
            clientName: request.clientName,
            clientUri: nil,
            redirectOrigin: request.redirectOrigin,
            resource: request.resource,
            scope: "mcp answer",
            expiresAt: request.expiresAt,
            requiresAnswer: true
        )
        var required = approval(needsAnswer)
        XCTAssertTrue(required.answerRequired)
        required.setHeld("answer", false)
        XCTAssertTrue(required.holds("answer"))
        XCTAssertEqual(required.release, .reviewed(policyFamilyId: "policy-everyday"))
    }

    func testAListNamesEachAccountOnItsOwnLineAndSaysWhatItShares() {
        XCTAssertEqual(accessSourceNameParts(sources[0]).source, "Mail")
        XCTAssertEqual(accessSourceNameParts(sources[0]).account, "reader@example.org")
        XCTAssertEqual(accessSourceNameParts(sources[1]).account, "reader@example.org", "An account the name leaves out comes from the id")
        XCTAssertEqual(accessAccountLineText(sources[2]), "Chat · +1 (555) 010-0123")
        let gone = accessDisconnectedSource("scope-chat:+15550100199", overview: overview)
        XCTAssertFalse(gone.available)
        XCTAssertEqual(accessAccountLineText(gone), "Chat · no longer connected")
        let unknown = accessDisconnectedSource("scope-notes:workspace", overview: overview)
        XCTAssertEqual(accessAccountLineText(unknown), "Scope notes · no longer connected")

        XCTAssertEqual(AccessAccountStatus(allowed: false, policy: filter(sources[1].id)).text, "Not shared")
        XCTAssertEqual(AccessAccountStatus(allowed: true, policy: nil), .init(allowed: true, policy: nil))
        XCTAssertEqual(AccessAccountStatus(allowed: true, policy: nil).text, "All content")
        let only = AccessAccountStatus(allowed: true, policy: filter(sources[1].id))
        XCTAssertEqual(only.kind, .only)
        XCTAssertEqual(only.text, "Share matching content · 1 item")
        var hidden = filter(sources[1].id)
        hidden.rules = [.init(match: hidden.rules[0].match + [.tree(field: "extra.folderIds", id: "archive")], action: "hide")]
        hidden.otherwise = "share"
        XCTAssertEqual(AccessAccountStatus(allowed: true, policy: hidden).kind, .except)
        XCTAssertEqual(AccessAccountStatus(allowed: true, policy: hidden).text, "Hide matching content · 2 items")
    }

    func testALevelListsItsDecisionsInTheOrderTheFlowAsksThem() {
        let level = AccessLevelSummary(
            id: "level-example",
            name: "Research assistant",
            revision: 2,
            rules: [
                .answer(
                    sources: .init(mode: .allowlist, sourceIds: sources.map(\.id)),
                    release: .reviewed(policyFamilyId: "policy-everyday"),
                    filterRevision: 1,
                    scopePolicies: [filter(sources[1].id, level: "level-example")]
                ),
                .direct(sources: .init(mode: .allowlist, sourceIds: [sources[0].id])),
            ],
            connectionCount: 0,
            createdAt: 1,
            updatedAt: 2
        )
        let draft = AccessLevelDraft(level: level, overview: overview)
        let decisions = AccessDraftDecisions(draft: draft, overview: overview, original: draft)
        XCTAssertEqual(decisions.decisionLines, [
            .init(title: "Permissions", value: "", step: .permissions, holdings: .init(answer: true, direct: true)),
            .init(title: "Answer data", value: "3 accounts selected · 1 filtered", step: .answerData),
            .init(title: "Direct data", value: "1 account selected · all content", step: .directData),
            .init(title: "New sources", value: "Answer: Blocked\nDirect: Blocked", step: .future),
            .init(title: "Answer release", value: "Privacy review · Everyday privacy", step: .release),
        ])
        XCTAssertTrue(decisions.filterEntryVisible(sources[1], capability: "answer"))
        let gone = accessDisconnectedSource("scope-chat:+15550100199", overview: overview)
        XCTAssertNil(decisions.selection(toggling: gone, capability: "answer"))
    }

    func testAFilteredRuleReadsItsBoundaryFromScopeSourcesAndNeverSendsIt() throws {
        let filtered = """
        {"capability":"answer","sources":{"mode":"allowlist","sourceIds":["scope-mail:reader@example.org"]},
        "scopeSources":{"mode":"allowlist","sourceIds":["scope-files:reader@example.org","scope-mail:reader@example.org"]},
        "release":{"mode":"unreviewed"},"filterRevision":3,
        "scopePolicies":[{"sourceId":"scope-files:reader@example.org","audience":{"accessLevel":"level-example","capability":"answer"},
        "rules":[{"match":[{"capability":"tree","field":"extra.folderIds","id":"projects"}],"action":"share"}],"otherwise":"hide"}]}
        """
        let rule = try JSONDecoder().decode(AccessGrantRule.self, from: Data(filtered.utf8))
        XCTAssertEqual(rule.boundary.sourceIds, ["scope-files:reader@example.org", "scope-mail:reader@example.org"])
        XCTAssertEqual(rule.filterRevision, 3)
        XCTAssertEqual(rule.scopePolicies.map(\.sourceId), ["scope-files:reader@example.org"])
        let sent = try XCTUnwrap(JSONSerialization.jsonObject(with: JSONEncoder().encode(rule)) as? [String: Any])
        XCTAssertNil(sent["scopeSources"])
        XCTAssertEqual((sent["sources"] as? [String: Any])?["sourceIds"] as? [String], rule.boundary.sourceIds)
        XCTAssertEqual(sent["filterRevision"] as? Int, 3)

        let plain = #"{"capability":"direct","sources":{"mode":"denylist","sourceIds":["scope-chat:+15550100123"]}}"#
        let unfiltered = try JSONDecoder().decode(AccessGrantRule.self, from: Data(plain.utf8))
        XCTAssertEqual(unfiltered, .direct(sources: .init(mode: .denylist, sourceIds: ["scope-chat:+15550100123"])))
        let resent = try XCTUnwrap(JSONSerialization.jsonObject(with: JSONEncoder().encode(unfiltered)) as? [String: Any])
        XCTAssertEqual(Set(resent.keys), ["capability", "sources"], "A rule without filters sends neither a revision nor policies")
    }

    func testTheGatewayIsAskedAgainAfterTheWaitItNamesWithinBounds() {
        XCTAssertEqual(scopeRetryDelay(retryAfterMs: 1500, attempt: 1), .milliseconds(1500))
        XCTAssertEqual(scopeRetryDelay(retryAfterMs: 10, attempt: 1), .milliseconds(500))
        XCTAssertEqual(scopeRetryDelay(retryAfterMs: 60000, attempt: 1), .milliseconds(15000))
        XCTAssertEqual(
            [1, 2, 5, 40].map { scopeRetryDelay(retryAfterMs: nil, attempt: $0) },
            [.seconds(2), .seconds(4), .seconds(10), .seconds(15)]
        )
        XCTAssertEqual(scopeRetryDelay(retryAfterMs: nil, attempt: 0), .seconds(2))
        XCTAssertTrue(scopePreviewCanRetry(URLError(.timedOut)))
        XCTAssertFalse(scopePreviewCanRetry(GatewayClient.Error.unauthorized))
        XCTAssertFalse(scopePreviewCanRetry(GatewayClient.Error.notFound))
        XCTAssertEqual(scopePreviewFailureMessage(URLError(.timedOut)), "Counts could not be loaded.")
    }

    func testAFilterOfAnAccountNoLongerConnectedAppliesOnlyOnceItLosesAnItem() {
        var saved = filter(sources[1].id)
        saved.rules[0].match.append(.tree(field: "extra.folderIds", id: "archive"))
        XCTAssertEqual(scopeDisconnectedFilterCommit(mode: .only, policy: saved, initial: saved), .blocked)
        var shorter = saved
        shorter.rules[0].match.removeLast()
        XCTAssertEqual(scopeDisconnectedFilterCommit(mode: .only, policy: shorter, initial: saved), .apply(shorter))
        shorter.rules[0].match.removeAll()
        XCTAssertEqual(scopeDisconnectedFilterCommit(mode: .only, policy: shorter, initial: saved), .blocked)
        let hiding = ScopeFilterMode.except.applying(to: shorter)
        XCTAssertEqual(scopeDisconnectedFilterCommit(mode: .except, policy: hiding, initial: saved), .apply(nil))
    }

    func testLevelsAreListedByNameWhateverTheCaseAndUnnamedItemsSayWhatTheyAre() {
        let level = { (id: String, name: String) in
            AccessLevelSummary(id: id, name: name, revision: 1, rules: [.notes], connectionCount: 0, createdAt: 1, updatedAt: 2)
        }
        let listed = AccessOverview(
            principals: [],
            sources: [],
            policyFamilies: [],
            levels: [level("b", "research assistant"), level("a", "Notes capture"), level("c", "Archive")]
        )
        XCTAssertEqual(accessLevelsByName(listed).map(\.name), ["Archive", "Notes capture", "research assistant"])

        let chat = ScopeRef.membership(field: "extra.chatJid", id: "chat-workshop")
        XCTAssertEqual(scopeDisplayLabel(chat, hint: nil), "Saved item selection")
        XCTAssertTrue(scopeNameUnavailable(chat, hint: nil))
        let unnamed = ScopeItemHint(ref: chat, label: "chat-workshop", noun: "chat", missing: true)
        XCTAssertEqual(scopeDisplayLabel(chat, hint: unnamed), "Saved chat selection")
        let person = ScopeRef.person(label: "Maya Reeves", identifiers: [.init(type: "phone", value: "+15550100141")])
        XCTAssertEqual(scopeDisplayLabel(person, hint: nil), "Maya Reeves")
        XCTAssertFalse(scopeNameUnavailable(person, hint: nil))
        let named = ScopeItemHint(ref: chat, label: "Workshop planning", count: 24, noun: "chat")
        XCTAssertFalse(scopeNameUnavailable(chat, hint: named))
        XCTAssertEqual(scopeDisplayLabel(chat, hint: named), "Workshop planning")
    }

    func testFilterCopyNamesOnlyWhatASourceAcceptsAndEachKindOfItem() {
        XCTAssertEqual(scopeAddIdentifierTitle(["phone"]), "Add a phone number")
        XCTAssertEqual(scopeAddIdentifierTitle(["email", "domain"]), "Add an email or domain")
        XCTAssertEqual(scopeAddIdentifierTitle(["phone", "domain", "email"]), "Add an email, domain or phone number")
        XCTAssertEqual(scopeAddIdentifierTitle(["domain"]), "Add a domain")
        XCTAssertEqual(["phone", "domain", "email"].map(scopeIdentifierTypeName), ["Phone number", "Domain", "Email address"])
        let person = ScopeRef.person(label: "+15550100141", identifiers: [.init(type: "phone", value: "+15550100141")])
        XCTAssertEqual(accessScopeKindName(person, hint: nil), "Person")
        XCTAssertEqual(accessScopeKindName(.tree(field: "extra.folderIds", id: "f"), hint: nil, noun: "folder"), "Folder")
        let chat = ScopeRef.membership(field: "extra.chatJid", id: "c")
        XCTAssertEqual(accessScopeKindName(chat, hint: .init(ref: chat, label: "Book club", noun: "chat")), "Chat")
        XCTAssertEqual(accessScopeKindName(chat, hint: nil), "Item")
        XCTAssertEqual(accessScopeKindName(.tree(field: "extra.projectFolder", id: "", device: "device-studio"), hint: nil), "Device")
        XCTAssertEqual(
            accessNoConnectedAccountsMessage,
            "No connected accounts are available. Connect a source before granting data access."
        )
        XCTAssertEqual(scopeFilterLimitMessage, "A filter can include at most 256 items.")
    }

    func testAnExistingLevelInAnApprovalListsItsOwnDecisionsWithoutChange() {
        let level = AccessLevelSummary(
            id: "level-example",
            name: "Research assistant",
            revision: 2,
            rules: [
                .answer(sources: .init(mode: .allowlist, sourceIds: sources.map(\.id)), release: .unreviewed),
                .direct(sources: .init(mode: .allowlist, sourceIds: [sources[0].id])),
            ],
            connectionCount: 2,
            createdAt: 1,
            updatedAt: 2
        )
        let lines = accessLevelSummaryLines(level, overview: overview)
        XCTAssertEqual(lines.map(\.title), ["Answer data", "Direct data", "New sources", "Answer release"])
        XCTAssertEqual(lines.map(\.value), [
            "3 accounts selected · all content", "1 account selected · all content", "Answer: Blocked\nDirect: Blocked",
            "No privacy review",
        ])
        XCTAssertTrue(lines.allSatisfy(\.fixed))
    }

    func testTheInspectorShowsTimesAsDatesAndKeepsAnythingElse() throws {
        let zone = try XCTUnwrap(TimeZone(identifier: "Europe/Paris"))
        XCTAssertEqual(inspectorTimestamp("2026-03-14T09:12:00", timeZone: zone), "14 March 2026, 09:12")
        XCTAssertEqual(inspectorTimestamp("2026-03-14T08:12:00Z", timeZone: zone), "14 March 2026, 09:12")
        XCTAssertEqual(inspectorTimestamp("2026-03-14T08:12:00.250Z", timeZone: zone), "14 March 2026, 09:12")
        XCTAssertEqual(inspectorTimestamp("yesterday", timeZone: zone), "yesterday")
    }

    func testAPickerSearchNamesEveryLevelOfATreeWithNamedLevels() {
        let repositories = FilterEditorField(
            field: "extra.repositoryIds",
            capability: "tree",
            noun: .init(one: "repository", many: "repositories"),
            levels: [.init(one: "owner", many: "owners"), .init(one: "repository", many: "repositories")],
            picker: "tree"
        )
        XCTAssertEqual(scopeSearchPrompt(repositories), "Search repositories and owners")
        let folders = FilterEditorField(
            field: "extra.folderIds",
            capability: "tree",
            noun: .init(one: "folder", many: "folders"),
            levels: [.init(one: "folder", many: "folders")],
            picker: "tree"
        )
        XCTAssertEqual(scopeSearchPrompt(folders), "Search folders")
        XCTAssertEqual(scopeSearchPrompt(nil), "Search people")
    }
}
