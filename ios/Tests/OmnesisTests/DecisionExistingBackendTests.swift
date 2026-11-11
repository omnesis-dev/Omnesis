// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

@testable import Omnesis
import XCTest

/// Saving a backend whose decision API is already set up sends only what
/// changed, and the key field, calibration status and model listing follow
/// the gateway's own state.
final class DecisionExistingBackendTests: XCTestCase {
    private typealias Setup = DecisionModelSetup

    /// A backend written by hand: no preset, OpenAI's Decisions format,
    /// Fastino-style key header. A preset's defaults must never replace these.
    private let handWritten = Setup.ExistingBackend(
        key: "studio",
        status: DecisionFixtures.decisionBackend(
            "https://decide.example.com/v1/decisions",
            hasApiKey: true,
            BackendDecisionStatus(
                url: "https://decide.example.com/v1/decisions",
                protocol: "openai-decisions",
                auth: "x-api-key",
                hasApiKey: true
            )
        ),
        preset: nil
    )

    private var handWrittenURL: String {
        handWritten.decision?.url ?? ""
    }

    private func draft(_ backend: Setup.ExistingBackend, url: String, apiKey: String = "", model: String) -> Setup.Draft {
        Setup.Draft(
            choice: .existing(backend),
            name: backend.key,
            url: url,
            apiKey: apiKey,
            model: model,
            enableRemoteInference: false
        )
    }

    private func overview(using model: String?) -> ModelsOverview {
        DecisionFixtures.overview(
            decision: model.map { ResolvedAssignment(kind: "decision", model: $0, backendKey: "studio") },
            backends: ["studio": handWritten.status]
        )
    }

    // MARK: - Saving an existing backend

    func testANewModelSendsOnlyTheAssignment() throws {
        let plan = Setup.savePlan(
            draft(handWritten, url: handWrittenURL, model: "decider-2"),
            in: overview(using: "decider-1")
        )
        XCTAssertEqual(
            try DecisionFixtures.json(plan.patch),
            ["inference": ["assignments": ["decision": "studio/decider-2"]]] as NSDictionary
        )
    }

    func testANewKeyOrURLSendsOnlyThatFieldNeverProtocolAuthOrScoreField() throws {
        let rotate = Setup.savePlan(
            draft(handWritten, url: handWrittenURL, apiKey: " xk-new ", model: "decider-1"),
            in: overview(using: "decider-1")
        )
        XCTAssertEqual(
            try DecisionFixtures.json(rotate.patch),
            ["inference": ["backends": ["studio": ["apiKey": "xk-new"]]]] as NSDictionary
        )
        let moved = Setup.savePlan(
            draft(handWritten, url: "https://decide2.example.com/v1/decisions", model: "decider-1"),
            in: overview(using: "decider-1")
        )
        XCTAssertEqual(
            try DecisionFixtures.json(moved.patch),
            ["inference": ["backends": ["studio": ["decision": ["url": "https://decide2.example.com/v1/decisions"]]]]]
                as NSDictionary
        )
        // An existing preset backend gets no preset defaults either.
        let presetBackend = Setup.ExistingBackend(
            key: "fastino",
            status: DecisionFixtures.decisionBackend("https://api.fastino.ai/v1/systemone", preset: "fastino", hasApiKey: true),
            preset: DecisionFixtures.fastino
        )
        let presetPlan = Setup.savePlan(
            draft(presetBackend, url: "https://api.fastino.ai/v1/systemone", apiKey: "fk-new", model: "fastino/GLiDE"),
            in: DecisionFixtures.overview()
        )
        XCTAssertEqual(
            try DecisionFixtures.json(presetPlan.patch),
            ["inference": [
                "backends": ["fastino": ["apiKey": "fk-new"]],
                "assignments": ["decision": "fastino/fastino/GLiDE"],
            ] as [String: Any]] as NSDictionary
        )
    }

    func testAnUnchangedBackendAndModelMakeAnEmptyPatch() throws {
        let plan = Setup.savePlan(
            draft(handWritten, url: " \(handWrittenURL) ", model: "decider-1"),
            in: overview(using: "decider-1")
        )
        XCTAssertTrue(plan.patch.isEmpty)
        XCTAssertEqual(try DecisionFixtures.json(plan.patch), ["inference": [:] as [String: Any]] as NSDictionary)
        XCTAssertEqual(plan.verifyTarget, .backend(key: "studio", model: "decider-1"))
        let consented = DecisionConfigPatch(enableRemoteInference: true)
        XCTAssertFalse(consented.isEmpty)
    }

    func testTypeSafeWithTheSameModelLeavesTheAssignmentOut() {
        let current = DecisionFixtures.overview(decision: ResolvedAssignment(kind: "typesafe", model: "jev-1.14.0"))
        let draft = Setup.Draft(
            choice: .preset(DecisionFixtures.typesafe),
            name: "",
            url: "",
            apiKey: "ts-new",
            model: "jev-1.14.0",
            enableRemoteInference: false
        )
        let plan = Setup.savePlan(draft, in: current)
        XCTAssertTrue(plan.patch.isEmpty)
        XCTAssertEqual(plan.typesafeApiKey, "ts-new")
    }

    func testConsentForAnExistingBackendUsesTheGatewaysOnHostVerdict() {
        let tunnelledURL = "http://decider.example.com:8080/v1/systemone"
        let tunnelled = Setup.ExistingBackend(
            key: "lan",
            status: DecisionFixtures.decisionBackend(tunnelledURL, BackendDecisionStatus(url: tunnelledURL, onHost: true)),
            preset: nil
        )
        let off = DecisionFixtures.overview(allowRemoteInference: false)
        XCTAssertFalse(Setup.needsRemoteConsent(tunnelled, url: tunnelledURL, in: off))
        XCTAssertTrue(Setup.needsRemoteConsent(tunnelled, url: "https://decide.example.org/v1/systemone", in: off))
        XCTAssertFalse(Setup.needsRemoteConsent(handWritten, url: handWrittenURL, in: overview(using: nil).allowing))
        XCTAssertTrue(Setup.needsRemoteConsent(handWritten, url: handWrittenURL, in: off))
    }

    // MARK: - API key field

    func testTypeSafeKeyIsRequiredOnlyWhenKnownToBeMissing() {
        let none = DecisionFixtures.overview()
        let current = DecisionFixtures.overview(decision: ResolvedAssignment(kind: "typesafe", model: "jev", hasApiKey: true))
        XCTAssertEqual(Setup.typesafeKeyStored(listed: false, in: current), true)
        XCTAssertNil(Setup.typesafeKeyStored(listed: nil, in: none))
        let typesafe = Setup.Choice.preset(DecisionFixtures.typesafe)
        XCTAssertEqual(
            Setup.keyField(typesafe, in: none, typesafeStored: false),
            Setup.KeyField(shown: true, required: true, stored: false)
        )
        XCTAssertEqual(
            Setup.keyField(typesafe, in: none, typesafeStored: nil),
            Setup.KeyField(shown: true, required: false, stored: false),
            "a failed listing is unknown, not missing"
        )
        XCTAssertEqual(
            Setup.keyField(typesafe, in: none, typesafeStored: true),
            Setup.KeyField(shown: true, required: false, stored: true)
        )
        let selfHosted = ModelsOverview(
            assignmentDisplays: [:],
            capabilities: [],
            inference: InferenceOverview(
                backends: [:],
                assignments: [:],
                typesafe: TypeSafeEndpointStatus(url: "http://127.0.0.1:9000/v1/systemone", selfHosted: true, onHost: true)
            ),
            catalog: [],
            installed: [],
            presets: DecisionFixtures.presets
        )
        XCTAssertFalse(Setup.keyField(typesafe, in: selfHosted, typesafeStored: false).required)
    }

    func testTypeSafeListingCountsAFileOrTheEnvironment() {
        let spec = CredentialSpec(fields: [CredentialField(name: "apiKey", label: "API key", secret: true)])
        func entry(configured: Bool, environment: Bool?) -> ModelCredentialEntry {
            ModelCredentialEntry(
                fileKey: "typesafe",
                providerType: "typesafe",
                providerName: "TypeSafe",
                spec: spec,
                configured: configured,
                environment: environment
            )
        }
        XCTAssertTrue(Setup.typesafeKeyListed([entry(configured: true, environment: false)]))
        XCTAssertTrue(Setup.typesafeKeyListed([entry(configured: false, environment: true)]))
        XCTAssertFalse(Setup.typesafeKeyListed([entry(configured: false, environment: nil)]))
        XCTAssertFalse(Setup.typesafeKeyListed([]))
    }

    func testExistingBackendKeyFieldFollowsItsPresetAndStoredKey() {
        let none = DecisionFixtures.overview()
        XCTAssertEqual(
            Setup.keyField(.existing(handWritten), in: none, typesafeStored: nil),
            Setup.KeyField(shown: true, required: false, stored: true)
        )
        let unreadable = Setup.ExistingBackend(
            key: "openrouter",
            status: DecisionFixtures.chatBackend(
                "https://openrouter.ai/api",
                preset: "openrouter",
                hasApiKey: false,
                decision: BackendDecisionStatus(
                    url: "https://openrouter.ai/api/v1/systemone",
                    apiKeySecretError: "Backend \"openrouter\" API key secret is missing or unreadable"
                )
            ),
            preset: DecisionFixtures.openRouter
        )
        XCTAssertEqual(
            Setup.keyField(.existing(unreadable), in: none, typesafeStored: nil),
            Setup.KeyField(shown: true, required: true, stored: false)
        )
        let localWithoutKey = Setup.ExistingBackend(
            key: "ollaya",
            status: DecisionFixtures.decisionBackend("http://127.0.0.1:11435/v1/systemone", preset: "ollaya"),
            preset: DecisionFixtures.ollaya
        )
        XCTAssertEqual(
            Setup.keyField(.existing(localWithoutKey), in: none, typesafeStored: nil),
            Setup.KeyField(shown: true, required: false, stored: false)
        )
        XCTAssertEqual(
            Setup.keyField(.preset(DecisionFixtures.openRouter), in: none, typesafeStored: nil),
            Setup.KeyField(shown: true, required: true, stored: false)
        )
        XCTAssertFalse(Setup.keyField(.custom, in: none, typesafeStored: nil).required)
    }

    // MARK: - Calibration and listing

    func testCalibrationOfAnotherAssignmentIsIgnored() {
        let current = overview(using: "decider-1")
        let mine = DecisionCalibrationStatus(state: "running", assignment: "studio/decider-1", done: 3, total: 300)
        let other = DecisionCalibrationStatus(state: "failed", assignment: "ollaya/kev", error: "boom")
        let idle = DecisionCalibrationStatus(state: "idle")
        XCTAssertEqual(Setup.relevantCalibration(mine, in: current), mine)
        XCTAssertNil(Setup.relevantCalibration(other, in: current))
        XCTAssertEqual(Setup.relevantCalibration(idle, in: current), idle)
        XCTAssertNil(Setup.relevantCalibration(nil, in: current))
    }

    func testProbeNoteNamesAFailureOrAnEmptyListing() {
        XCTAssertNil(Setup.probeNote(DecisionProbeResult(ok: true, models: ["kev"], listed: true)))
        XCTAssertNil(Setup.probeNote(DecisionProbeResult(ok: true, models: [], listed: false)))
        XCTAssertEqual(Setup.probeNote(DecisionProbeResult(ok: true, models: [], listed: true)), "The server lists no models yet.")
        XCTAssertEqual(
            Setup.probeNote(DecisionProbeResult(ok: false, reason: "HTTP 401 from http://127.0.0.1:11435/api/tags")),
            "HTTP 401 from http://127.0.0.1:11435/api/tags"
        )
        XCTAssertEqual(Setup.probeNote(DecisionProbeResult(ok: false)), "The server did not list its models.")
    }
}

extension ModelsOverview {
    /// The same overview with cloud inference allowed.
    fileprivate var allowing: ModelsOverview {
        ModelsOverview(
            assignmentDisplays: assignmentDisplays,
            capabilities: capabilities,
            inference: InferenceOverview(
                backends: inference.backends,
                assignments: inference.assignments,
                allowRemoteInference: true,
                typesafe: inference.typesafe
            ),
            catalog: catalog,
            installed: installed,
            presets: presets,
            decisionProviders: decisionProviders
        )
    }
}
