// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

@testable import Omnesis
import XCTest

/// The `PATCH /admin/config` bodies a Decision model choice saves, and the
/// verify wording the sheet shows.
final class DecisionModelSaveTests: XCTestCase {
    private typealias Setup = DecisionModelSetup

    private func draft(
        _ choice: Setup.Choice,
        name: String = "",
        url: String = "",
        apiKey: String = "",
        model: String = "kev",
        consent: Bool = false
    )
        -> Setup.Draft {
        Setup.Draft(choice: choice, name: name, url: url, apiKey: apiKey, model: model, enableRemoteInference: consent)
    }

    private func savePlan(_ draft: Setup.Draft, in overview: ModelsOverview = DecisionFixtures.overview()) -> Setup.SavePlan {
        Setup.savePlan(draft, in: overview)
    }

    /// The value at a dotted path through nested JSON objects.
    private func value(_ object: NSDictionary, _ path: String) -> Any? {
        path.split(separator: ".").reduce(object as Any?) { current, key in
            (current as? NSDictionary)?[String(key)]
        }
    }

    // MARK: - Save plans

    func testNewProviderWithBothAPIsSavesOneKeyForItsChatAndDecisionEndpoints() throws {
        let plan = savePlan(draft(
            .preset(DecisionFixtures.openRouter),
            name: "openrouter",
            url: "https://openrouter.ai/api/v1/systemone",
            apiKey: "  sk-example  ",
            model: " liquid/d1.1 ",
            consent: true
        ))
        let expected: NSDictionary = ["inference": [
            "allowRemoteInference": true,
            "backends": ["openrouter": [
                "type": "http",
                "preset": "openrouter",
                "url": "https://openrouter.ai/api",
                "apiKey": "sk-example",
                "decision": [
                    "url": "https://openrouter.ai/api/v1/systemone",
                    "protocol": "systemone",
                    "auth": "bearer",
                ],
            ] as [String: Any]],
            "assignments": ["decision": "openrouter/liquid/d1.1"],
        ] as [String: Any]]
        XCTAssertEqual(try DecisionFixtures.json(plan.patch), expected)
        XCTAssertNil(plan.typesafeApiKey)
        XCTAssertEqual(plan.verifyTarget, .backend(key: "openrouter", model: "liquid/d1.1"))
    }

    func testDecisionOnlyProviderSavesNoChatURLAndLeavesABlankKeyOut() throws {
        let plan = savePlan(draft(
            .preset(DecisionFixtures.ollaya),
            name: "ollaya",
            url: "http://127.0.0.1:11435/v1/systemone",
            apiKey: "   "
        ))
        let expected: NSDictionary = ["inference": [
            "backends": ["ollaya": [
                "type": "http",
                "preset": "ollaya",
                "decision": ["url": "http://127.0.0.1:11435/v1/systemone", "protocol": "systemone", "auth": "bearer"],
            ] as [String: Any]],
            "assignments": ["decision": "ollaya/kev"],
        ] as [String: Any]]
        XCTAssertEqual(try DecisionFixtures.json(plan.patch), expected)
    }

    func testPresetProtocolAuthAndScoreFieldCarryOver() throws {
        let fastino = try DecisionFixtures.json(savePlan(draft(
            .preset(DecisionFixtures.fastino),
            name: "fastino",
            url: "https://api.fastino.ai/v1/systemone",
            apiKey: "fk-example",
            model: "fastino/GLiDE"
        )).patch)
        let backend = try XCTUnwrap(value(fastino, "inference.backends.fastino") as? NSDictionary)
        XCTAssertEqual(backend["apiKey"] as? String, "fk-example", "the key sits on the backend, not its decision API")
        XCTAssertNil(backend["url"])
        XCTAssertEqual(value(fastino, "inference.backends.fastino.decision.auth") as? String, "x-api-key")
        XCTAssertEqual(value(fastino, "inference.backends.fastino.decision.scoreField") as? String, "expected_level")
        XCTAssertNil(value(fastino, "inference.backends.fastino.decision.apiKey"))
        let cloudflare = try DecisionFixtures.json(savePlan(draft(
            .preset(DecisionFixtures.cloudflare),
            name: "cloudflare",
            url: "https://api.cloudflare.com/client/v4/accounts/0123abcd/ai/run",
            apiKey: "cf-example",
            model: "@cf/cloudflare/clef"
        )).patch)
        XCTAssertEqual(value(cloudflare, "inference.backends.cloudflare.decision.protocol") as? String, "workers-ai")
        XCTAssertEqual(
            value(cloudflare, "inference.backends.cloudflare.decision.url") as? String,
            "https://api.cloudflare.com/client/v4/accounts/0123abcd/ai/run"
        )
        XCTAssertNil(value(cloudflare, "inference.backends.cloudflare.decision.scoreField"))
    }

    func testOtherServerSavesSystemOneWithBearerAndNoPreset() throws {
        let plan = savePlan(draft(.custom, name: " studio ", url: "http://127.0.0.1:8080/v1/systemone", model: "d1"))
        let expected: NSDictionary = ["inference": [
            "backends": ["studio": [
                "type": "http",
                "decision": ["url": "http://127.0.0.1:8080/v1/systemone", "protocol": "systemone", "auth": "bearer"],
            ] as [String: Any]],
            "assignments": ["decision": "studio/d1"],
        ] as [String: Any]]
        XCTAssertEqual(try DecisionFixtures.json(plan.patch), expected)
        XCTAssertEqual(plan.verifyTarget, .backend(key: "studio", model: "d1"))
    }

    func testAddingDecisionsToABackendSendsItsDecisionAPIAndNoKey() throws {
        let fireworks = Setup.ExistingBackend(
            key: "fireworks",
            status: DecisionFixtures.chatBackend("https://api.fireworks.ai/inference", preset: "fireworks"),
            preset: DecisionFixtures.fireworks
        )
        // A key typed anyway (the form shows no field) is still never sent.
        let plan = savePlan(draft(
            .enable(fireworks),
            name: "fireworks",
            url: "https://api.fireworks.ai/inference/v1/systemone",
            apiKey: "fw-typed",
            model: "accounts/fireworks/models/rune"
        ))
        let expected: NSDictionary = ["inference": [
            "backends": ["fireworks": ["decision": [
                "url": "https://api.fireworks.ai/inference/v1/systemone",
                "protocol": "systemone",
                "auth": "bearer",
            ]]],
            "assignments": ["decision": "fireworks/accounts/fireworks/models/rune"],
        ] as [String: Any]]
        XCTAssertEqual(try DecisionFixtures.json(plan.patch), expected)
        XCTAssertEqual(
            try String(data: JSONEncoder().encode(plan.patch), encoding: .utf8)?.contains("apiKey"),
            false
        )
        XCTAssertNil(plan.typesafeApiKey)
        XCTAssertEqual(plan.verifyTarget, .backend(key: "fireworks", model: "accounts/fireworks/models/rune"))
        XCTAssertEqual(
            Setup.keyField(.enable(fireworks), in: DecisionFixtures.overview(), typesafeStored: nil),
            Setup.KeyField(shown: false, required: false, stored: true)
        )
    }

    func testReusingABackendSendsOnlyTheAssignmentOrANewKey() throws {
        let backend = Setup.ExistingBackend(
            key: "openrouter",
            status: DecisionFixtures.chatBackend(
                "https://openrouter.ai/api",
                preset: "openrouter",
                decision: BackendDecisionStatus(url: "https://openrouter.ai/api/v1/systemone", hasApiKey: true)
            ),
            preset: DecisionFixtures.openRouter
        )
        let keep = savePlan(draft(
            .existing(backend),
            name: "openrouter",
            url: "https://openrouter.ai/api/v1/systemone",
            model: "liquid/d1.1"
        ))
        XCTAssertEqual(
            try DecisionFixtures.json(keep.patch),
            ["inference": ["assignments": ["decision": "openrouter/liquid/d1.1"]]] as NSDictionary
        )
        let rotate = savePlan(draft(.existing(backend), name: "openrouter", apiKey: "sk-new", model: "liquid/d1.1"))
        XCTAssertEqual(
            try DecisionFixtures.json(rotate.patch),
            ["inference": [
                "backends": ["openrouter": ["apiKey": "sk-new"]],
                "assignments": ["decision": "openrouter/liquid/d1.1"],
            ] as [String: Any]] as NSDictionary
        )
    }

    func testTypeSafeKeepsTheBuiltInAssignmentAndSendsItsKeySeparately() throws {
        let plan = savePlan(draft(.preset(DecisionFixtures.typesafe), apiKey: "ts-example", model: "jev-1.14.0", consent: true))
        XCTAssertEqual(
            try DecisionFixtures.json(plan.patch),
            ["inference": ["allowRemoteInference": true, "assignments": ["decision": "typesafe/jev-1.14.0"]] as [String: Any]]
                as NSDictionary
        )
        XCTAssertEqual(plan.typesafeApiKey, "ts-example")
        XCTAssertEqual(plan.verifyTarget, .typesafe(model: "jev-1.14.0"))
        let keep = savePlan(draft(.preset(DecisionFixtures.typesafe), model: "jev-1.14.0"))
        XCTAssertNil(keep.typesafeApiKey)
    }

    func testTurningDecisionsOffRemovesADecisionOnlyBackendButKeepsAChatBackend() throws {
        let backends = [
            "ollaya": DecisionFixtures.decisionBackend("http://127.0.0.1:11435/v1/systemone", preset: "ollaya"),
            "openrouter": DecisionFixtures.chatBackend(
                "https://openrouter.ai/api",
                preset: "openrouter",
                decision: BackendDecisionStatus(url: "https://openrouter.ai/api/v1/systemone", hasApiKey: true)
            ),
        ]
        let pointing = DecisionFixtures.overview(
            decision: ResolvedAssignment(kind: "decision", model: "kev", backendKey: "ollaya"),
            backends: backends
        )
        XCTAssertEqual(
            try DecisionFixtures.json(Setup.removalPatch(key: "ollaya", in: pointing)),
            ["inference": ["backends": ["ollaya": NSNull()], "assignments": ["decision": NSNull()]]] as NSDictionary
        )
        XCTAssertEqual(
            try DecisionFixtures.json(Setup.removalPatch(key: "openrouter", in: pointing)),
            ["inference": ["backends": ["openrouter": ["decision": NSNull()]]]] as NSDictionary
        )
        let onOpenRouter = DecisionFixtures.overview(
            decision: ResolvedAssignment(kind: "decision", model: "liquid/d1.1", backendKey: "openrouter"),
            backends: backends
        )
        XCTAssertEqual(
            try DecisionFixtures.json(Setup.removalPatch(key: "openrouter", in: onOpenRouter)),
            ["inference": [
                "backends": ["openrouter": ["decision": NSNull()]],
                "assignments": ["decision": NSNull()],
            ] as [String: Any]] as NSDictionary
        )
    }

    // MARK: - Verify

    func testVerifyTargetFollowsTheCurrentAssignment() {
        let backend = DecisionFixtures.overview(decision: ResolvedAssignment(kind: "decision", model: "kev", backendKey: "ollaya"))
        XCTAssertEqual(Setup.currentVerifyTarget(backend), .backend(key: "ollaya", model: "kev"))
        let typesafe = DecisionFixtures.overview(decision: ResolvedAssignment(kind: "typesafe", model: "jev-1.14.0"))
        XCTAssertEqual(Setup.currentVerifyTarget(typesafe), .typesafe(model: "jev-1.14.0"))
        XCTAssertNil(Setup.currentVerifyTarget(DecisionFixtures.overview(decision: ResolvedAssignment(kind: "unresolved"))))
        XCTAssertNil(Setup.currentVerifyTarget(DecisionFixtures.overview(decision: ResolvedAssignment(kind: "decision", model: "kev"))))
        XCTAssertNil(Setup.currentVerifyTarget(DecisionFixtures.overview()))
    }

    func testVerifyTextShowsTheLatencyTheAnsweringAliasOrTheReasonVerbatim() {
        let same = DecisionVerifyResult(ok: true, answeredBy: "kev", latencyMs: 240)
        XCTAssertEqual(Setup.verifyText(same, model: "kev"), "Answered in 240 ms")
        let alias = DecisionVerifyResult(ok: true, answeredBy: "kev-4b-q8", latencyMs: 240)
        XCTAssertEqual(Setup.verifyText(alias, model: "kev"), "Answered in 240 ms by kev-4b-q8")
        XCTAssertEqual(Setup.verifyText(DecisionVerifyResult(ok: true, answeredBy: ""), model: "kev"), "Answered")
        let reason = "The API key was refused (HTTP 401). invalid key"
        XCTAssertEqual(Setup.verifyText(DecisionVerifyResult(ok: false, status: 401, reason: reason), model: "kev"), reason)
        XCTAssertEqual(Setup.verifyText(DecisionVerifyResult(ok: false, reason: "  "), model: "kev"), "The model did not answer.")
    }
}

// MARK: - Adding decisions to a backend without a key

extension DecisionModelSaveTests {
    private var keylessOpenRouter: Setup.ExistingBackend {
        Setup.ExistingBackend(
            key: "openrouter-lab",
            status: DecisionFixtures.chatBackend("https://openrouter.ai/api", preset: "openrouter", hasApiKey: false),
            preset: DecisionFixtures.openRouter
        )
    }

    func testABackendWithoutAKeyAsksForOneThatServesBothItsAPIs() throws {
        let backend = keylessOpenRouter
        XCTAssertTrue(backend.needsKeyForDecisions)
        XCTAssertEqual(
            Setup.keyField(.enable(backend), in: DecisionFixtures.overview(), typesafeStored: nil),
            Setup.KeyField(shown: true, required: true, stored: false)
        )
        XCTAssertEqual(Setup.enableSummary(backend), "OpenRouter — Needs a key")
        XCTAssertEqual(Setup.sharedKeyNote, "It becomes this backend's key for its OpenAI-compatible and decision APIs.")
        let plan = savePlan(draft(
            .enable(backend),
            name: "openrouter-lab",
            url: "https://openrouter.ai/api/v1/systemone",
            apiKey: " sk-example ",
            model: "liquid/d1.1"
        ))
        let expected: NSDictionary = ["inference": [
            "backends": ["openrouter-lab": [
                "apiKey": "sk-example",
                "decision": ["url": "https://openrouter.ai/api/v1/systemone", "protocol": "systemone", "auth": "bearer"],
            ] as [String: Any]],
            "assignments": ["decision": "openrouter-lab/liquid/d1.1"],
        ] as [String: Any]]
        XCTAssertEqual(try DecisionFixtures.json(plan.patch), expected)
    }

    func testABackendWithAKeyOrAKeylessProviderIsNeverAskedForOne() {
        let withKey = Setup.ExistingBackend(
            key: "fireworks",
            status: DecisionFixtures.chatBackend("https://api.fireworks.ai/inference", preset: "fireworks"),
            preset: DecisionFixtures.fireworks
        )
        XCTAssertFalse(withKey.needsKeyForDecisions)
        XCTAssertEqual(Setup.enableSummary(withKey), "Fireworks AI — uses your existing key")
        let keylessProvider = ProviderPreset(
            id: "lan-decider",
            name: "LAN decider",
            kind: "local",
            defaultUrl: "http://127.0.0.1:8080",
            decision: ProviderDecisionPreset(url: "http://127.0.0.1:8080/v1/systemone", keyRequired: false)
        )
        let noKeyNeeded = Setup.ExistingBackend(
            key: "lan",
            status: DecisionFixtures.chatBackend("http://127.0.0.1:8080", preset: "lan-decider", hasApiKey: false),
            preset: keylessProvider
        )
        XCTAssertFalse(noKeyNeeded.needsKeyForDecisions)
        XCTAssertEqual(
            Setup.keyField(.enable(noKeyNeeded), in: DecisionFixtures.overview(), typesafeStored: nil),
            Setup.KeyField(shown: false, required: false, stored: false)
        )
        XCTAssertEqual(Setup.enableSummary(noKeyNeeded), "LAN decider — uses your existing key")
    }
}
