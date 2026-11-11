// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

@testable import Omnesis
import XCTest

/// The `PATCH /admin/config` bodies a Decision model choice saves, and the
/// verify and calibration wording the sheet shows.
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

    // MARK: - Calibration

    private let utc = TimeZone(identifier: "UTC")!
    private let english = Locale(identifier: "en_US")

    func testCalibrationStateIsOnlyForABackendsDecisionAPI() {
        XCTAssertNil(Setup.calibrationState(DecisionFixtures.overview(decision: ResolvedAssignment(kind: "typesafe", model: "jev"))))
        XCTAssertNil(Setup.calibrationState(DecisionFixtures.overview()))
        let uncalibrated = DecisionFixtures.overview(
            decision: ResolvedAssignment(kind: "decision", model: "kev", backendKey: "ollaya", calibrated: false)
        )
        XCTAssertEqual(Setup.calibrationState(uncalibrated), .uncalibrated)
        XCTAssertEqual(Setup.cardSummary(uncalibrated, role: "decision"), "Not calibrated to Jev's scale")
        XCTAssertNil(Setup.cardSummary(uncalibrated, role: "agent"))
        let stored = DecisionCalibration(fittedAt: "2026-11-08T14:30:00.000Z", agreement: 0.918, agreementBefore: 0.71)
        let calibrated = DecisionFixtures.overview(
            decision: ResolvedAssignment(kind: "decision", model: "kev", backendKey: "ollaya", calibrated: true),
            backends: ["ollaya": DecisionFixtures.decisionBackend(
                "http://127.0.0.1:11435/v1/systemone",
                BackendDecisionStatus(url: "http://127.0.0.1:11435/v1/systemone", calibrations: ["kev": stored])
            )]
        )
        XCTAssertEqual(Setup.calibrationState(calibrated), .calibrated(stored))
        XCTAssertEqual(Setup.cardSummary(calibrated, role: "decision"), "Calibrated · agrees with Jev on 92%")
        // An older gateway that reports `calibrated` without the stored record.
        let flagOnly = DecisionFixtures.overview(
            decision: ResolvedAssignment(kind: "decision", model: "kev", backendKey: "ollaya", calibrated: true)
        )
        XCTAssertEqual(Setup.calibrationState(flagOnly), .calibrated(nil))
        XCTAssertEqual(Setup.cardSummary(flagOnly, role: "decision"), "Calibrated to Jev's scale")
    }

    func testCalibratedTextLeadsWithKeepsAndSkipsWhenTheGatewaySendsThem() {
        let fit = DecisionCalibration(
            fittedAt: "2026-11-08T14:30:00Z",
            agreement: 0.92,
            agreementBefore: 0.71,
            keeps: 0.951,
            keepsBefore: 0.78,
            skips: 0.884,
            skipsBefore: 0.93
        )
        XCTAssertEqual(
            Setup.calibratedText(fit, locale: english, timeZone: utc),
            "Calibrated against Jev on Nov 8, 2026: keeps 95% of the reference emails Jev keeps and skips 88% "
                + "of those it skips (before: 78% and 93%)."
        )
        let noBefore = DecisionCalibration(fittedAt: "2026-11-08T14:30:00Z", keeps: 0.95, skips: 0.9)
        XCTAssertEqual(
            Setup.calibratedText(noBefore, locale: english, timeZone: utc),
            "Calibrated against Jev on Nov 8, 2026: keeps 95% of the reference emails Jev keeps and skips 90% "
                + "of those it skips."
        )
        // Keeps without skips is not the new method's record: the agreement sentence stands.
        let partial = DecisionCalibration(fittedAt: "2026-11-08T14:30:00Z", agreement: 0.9, keeps: 0.95)
        XCTAssertEqual(
            Setup.calibratedText(partial, locale: english, timeZone: utc),
            "Calibrated against Jev on Nov 8, 2026: agrees with Jev on 90% of the reference emails."
        )
        let overview = DecisionFixtures.overview(
            decision: ResolvedAssignment(kind: "decision", model: "kev", backendKey: "ollaya", calibrated: true),
            backends: ["ollaya": DecisionFixtures.decisionBackend(
                "http://127.0.0.1:11435/v1/systemone",
                BackendDecisionStatus(url: "http://127.0.0.1:11435/v1/systemone", calibrations: ["kev": fit])
            )]
        )
        XCTAssertEqual(Setup.cardSummary(overview, role: "decision"), "Calibrated · keeps 95% of what Jev keeps")
    }

    func testAFinishedRunDescribesItsOwnFit() {
        let stored = DecisionCalibration(agreement: 0.8)
        let fresh = DecisionCalibration(keeps: 0.95, skips: 0.9)
        let done = DecisionCalibrationStatus(state: "done", assignment: "ollaya/kev", result: fresh)
        XCTAssertEqual(Setup.shownCalibration(stored: stored, job: done), fresh)
        let running = DecisionCalibrationStatus(state: "running", assignment: "ollaya/kev")
        XCTAssertEqual(Setup.shownCalibration(stored: stored, job: running), stored)
        XCTAssertEqual(Setup.shownCalibration(stored: stored, job: nil), stored)
        XCTAssertNil(Setup.shownCalibration(stored: nil, job: DecisionCalibrationStatus(state: "done")))
    }

    func testCalibratedTextNamesTheDateAndAgreement() {
        let full = DecisionCalibration(fittedAt: "2026-11-08T14:30:00Z", agreement: 0.92, agreementBefore: 0.714)
        XCTAssertEqual(
            Setup.calibratedText(full, locale: english, timeZone: utc),
            "Calibrated against Jev on Nov 8, 2026: agrees with Jev on 92% of the reference emails (was 71%)."
        )
        let noBefore = DecisionCalibration(fittedAt: "2026-11-08T14:30:00Z", agreement: 0.9)
        XCTAssertEqual(
            Setup.calibratedText(noBefore, locale: english, timeZone: utc),
            "Calibrated against Jev on Nov 8, 2026: agrees with Jev on 90% of the reference emails."
        )
        XCTAssertEqual(Setup.calibratedText(nil, locale: english, timeZone: utc), "Calibrated against Jev.")
        XCTAssertEqual(
            Setup.uncalibratedText,
            "Thresholds were tuned on TypeSafe's Jev. Calibrate this model so they mean the same thing."
        )
    }

    func testCalibrationProgressAndOutcomeText() {
        let running = DecisionCalibrationStatus(state: "running", done: 120, total: 300)
        XCTAssertEqual(Setup.calibrationProgressText(running), "120 of 300 reference emails")
        let failing = DecisionCalibrationStatus(state: "running", done: 120, total: 300, failed: 2)
        XCTAssertEqual(Setup.calibrationProgressText(failing), "120 of 300 reference emails · 2 failed")
        XCTAssertEqual(Setup.calibrationProgressText(DecisionCalibrationStatus(state: "running")), "Starting…")
        let error = "Only 12 of 300 reference emails were answered: Nothing answered at http://127.0.0.1:11435/v1/systemone."
        XCTAssertEqual(Setup.calibrationOutcomeText(DecisionCalibrationStatus(state: "failed", error: error)), error)
        XCTAssertEqual(Setup.calibrationOutcomeText(DecisionCalibrationStatus(state: "failed")), "Calibration failed.")
        XCTAssertEqual(Setup.calibrationOutcomeText(DecisionCalibrationStatus(state: "cancelled")), "Calibration cancelled.")
        XCTAssertNil(Setup.calibrationOutcomeText(DecisionCalibrationStatus(state: "done")))
        XCTAssertNil(Setup.calibrationOutcomeText(DecisionCalibrationStatus(state: "idle")))
        XCTAssertTrue(Setup.calibrationExplanation(onHost: true).contains("several minutes"))
        XCTAssertTrue(Setup.calibrationExplanation(onHost: false).contains("a few cents"))
        XCTAssertTrue(Setup.calibrationExplanation(onHost: false).contains("no personal data"))
    }
}
