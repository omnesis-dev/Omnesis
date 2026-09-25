// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

@testable import Omnesis
import XCTest

/// Unit coverage for the composer's `/`→Deep Research affordance:
///   - the pure slash-command matching/decision logic (the menu open/close
///     rules + which commands surface), and
///   - the per-message `deepResearch` flag riding the `/messages` POST body.
///
/// The interactive arm→send→clear behaviour is a SwiftUI gesture sequence
/// that snapshots can't catch; it's reasoned about against these pure
/// functions (arming seeds `armedCommand`; `submit()` reads it, clears it,
/// and hands it to `onSend` — so the flag governs exactly one send).
final class SlashCommandsTests: XCTestCase {
    // MARK: - Registry

    func testRegistrySeededWithDeepResearch() {
        let cmd = SlashCommand.byId("deep-research")
        XCTAssertNotNil(cmd)
        XCTAssertEqual(cmd?.label, "Deep Research (beta)")
        XCTAssertTrue(cmd?.deepResearch == true)
    }

    func testUnknownIdReturnsNil() {
        XCTAssertNil(SlashCommand.byId("does-not-exist"))
        XCTAssertNil(SlashCommand.byId(nil))
    }

    func testDeepResearchIsNotExperimental() {
        XCTAssertEqual(SlashCommand.byId("deep-research")?.experimental, false)
    }

    // MARK: - Availability across gateway modes

    func testAvailableShowsDeepResearchWhenExperimentalModeIsDisabled() {
        let available = SlashCommand.available(experimentalEnabled: false)
        XCTAssertTrue(
            available.contains { $0.id == "deep-research" },
            "Deep Research must be offered on a stable gateway"
        )
    }

    func testAvailableShowsExperimentalWhenEnabled() {
        let available = SlashCommand.available(experimentalEnabled: true)
        XCTAssertTrue(available.contains { $0.id == "deep-research" })
    }

    func testMenuOverGatedSetShowsDeepResearchInBothModes() {
        let stable = matchSlashCommands("/", commands: SlashCommand.available(experimentalEnabled: false))
        XCTAssertTrue(stable.isOpen)
        XCTAssertTrue(stable.matches.contains { $0.id == "deep-research" })

        let experimental = matchSlashCommands("/", commands: SlashCommand.available(experimentalEnabled: true))
        XCTAssertTrue(experimental.matches.contains { $0.id == "deep-research" })

        XCTAssertEqual(
            matchSlashCommands("/deep", commands: SlashCommand.available(experimentalEnabled: false))
                .matches.first?.id,
            "deep-research"
        )
    }

    // MARK: - matchSlashCommands

    func testNonSlashTextClosesMenu() {
        XCTAssertFalse(matchSlashCommands("").isOpen)
        XCTAssertFalse(matchSlashCommands("hello").isOpen)
        XCTAssertFalse(matchSlashCommands(" /deep").isOpen)
    }

    func testBareSlashListsEverything() {
        let state = matchSlashCommands("/")
        XCTAssertTrue(state.isOpen)
        XCTAssertEqual(state.matches.count, SlashCommand.all.count)
    }

    func testPartialTokenMatchesByTriggerAndLabel() {
        XCTAssertEqual(matchSlashCommands("/deep").matches.first?.id, "deep-research")
        XCTAssertEqual(matchSlashCommands("/research").matches.first?.id, "deep-research")
        // Case-insensitive.
        XCTAssertEqual(matchSlashCommands("/DEEP").matches.first?.id, "deep-research")
    }

    func testWhitespaceClosesMenuEvenAfterSlashWord() {
        // Once the user types a space, they're composing a real prompt — the
        // menu must close even though the text still starts with `/`.
        XCTAssertFalse(matchSlashCommands("/deep research my running").isOpen)
    }

    func testNoMatchKeepsMenuOpenButEmpty() {
        let state = matchSlashCommands("/zzzz")
        XCTAssertTrue(state.isOpen)
        XCTAssertTrue(state.matches.isEmpty)
    }

    // MARK: - Send-path flag (AgentClient body)

    func testDefaultSendOmitsDeepResearch() throws {
        let body = try AgentClient.sendMessageBody(
            text: "what's on my calendar",
            deepResearch: false,
            encoder: JSONEncoder()
        )
        let json = try XCTUnwrap(JSONSerialization.jsonObject(with: body) as? [String: Any])
        XCTAssertEqual(json["text"] as? String, "what's on my calendar")
        // A plain turn's payload is byte-identical to before — no key.
        XCTAssertNil(json["deepResearch"])
    }

    func testArmedSendCarriesDeepResearchTrue() throws {
        let body = try AgentClient.sendMessageBody(
            text: "trace my spending on coffee this quarter",
            deepResearch: true,
            encoder: JSONEncoder()
        )
        let json = try XCTUnwrap(JSONSerialization.jsonObject(with: body) as? [String: Any])
        XCTAssertEqual(json["deepResearch"] as? Bool, true)
    }

    /// The armed command an armed pill represents resolves to `deepResearch:
    /// true` — the bridge the composer uses (`command?.deepResearch ?? false`)
    /// when handing the send to the coordinator.
    func testArmedDeepResearchCommandMapsToFlag() {
        let armed = SlashCommand.byId("deep-research")
        XCTAssertEqual(armed?.deepResearch ?? false, true)
        // No armed command ⇒ ordinary turn.
        let none: SlashCommand? = nil
        XCTAssertEqual(none?.deepResearch ?? false, false)
    }
}
