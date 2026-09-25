// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation

/// Slash-command registry for the agent composer — the iOS analogue of the
/// portal's `slash-commands.js`.
///
/// A composer affordance: typing `/` at the very start of an empty composer
/// opens a typeahead menu of slash commands. Selecting one "arms" it as a
/// per-message pill above the text field — it governs the NEXT send only and
/// clears afterward (per-message; the following message is an ordinary turn
/// unless the user re-arms it).
///
/// This is a GENERAL, extensible registry deliberately seeded with a single
/// entry ("Deep research") so more slash commands can be added later without
/// touching the composer wiring: append a descriptor to `SlashCommand.all`
/// and it shows up in the menu and arms a pill the same way.
///
/// The matching/decision logic is pure (no SwiftUI, no I/O) so it unit-tests
/// cleanly — the interactive arm/clear behaviour, which snapshots can't catch,
/// is reasoned about against these functions.
public struct SlashCommand: Identifiable, Equatable, Sendable {
    /// Stable identifier (also the menu key).
    public let id: String
    /// Pill + menu display label.
    public let label: String
    /// One-line menu description.
    public let hint: String
    /// The typed token that selects it (without the leading `/`).
    public let trigger: String
    /// An SF Symbol name rendered by the composer for the menu row and pill.
    public let systemImage: String
    /// Whether arming this command sends `deepResearch: true` in the POST
    /// body. The registry stays generic — each command names the send options
    /// it contributes — but the only send-option the gateway honours today is
    /// the deep-research flag, so we model it explicitly rather than as an
    /// open dictionary the Swift type system can't validate at the boundary.
    public let deepResearch: Bool
    /// Whether this command is experimental — only offered when the paired
    /// gateway runs in experimental mode. Mirrors the portal's
    /// `experimental: true` descriptor flag: the composer filters such
    /// commands out of its menu unless the gateway reports `experimental`,
    /// so a user can't arm them otherwise.
    public let experimental: Bool

    public init(
        id: String,
        label: String,
        hint: String,
        trigger: String,
        systemImage: String,
        deepResearch: Bool,
        experimental: Bool = false
    ) {
        self.id = id
        self.label = label
        self.hint = hint
        self.trigger = trigger
        self.systemImage = systemImage
        self.deepResearch = deepResearch
        self.experimental = experimental
    }

    /// The registry. Seeded with exactly one command today; append to extend.
    ///
    /// `telescope` is not in the SF Symbols catalogue on the deployment
    /// target, so we use `binoculars` — the closest stock glyph for the same
    /// "scan the horizon" intent the portal's lucide `telescope` conveys.
    public static let all: [SlashCommand] = [
        SlashCommand(
            id: "deep-research",
            label: "Deep Research (beta)",
            hint: "Plan, fan out across your corpus, verify, and synthesize a cited report.",
            trigger: "deep-research",
            systemImage: "binoculars",
            deepResearch: true
        ),
    ]

    /// The commands offered to a composer paired with a gateway whose
    /// experimental mode is `experimentalEnabled`. Any future experimental
    /// commands are dropped unless the gateway reports experimental mode.
    /// Deep Research itself is available on every gateway.
    public static func available(experimentalEnabled: Bool) -> [SlashCommand] {
        all.filter { !$0.experimental || experimentalEnabled }
    }

    /// Look up a command by id. Returns `nil` for an unknown id so callers
    /// degrade gracefully rather than crashing.
    public static func byId(_ id: String?) -> SlashCommand? {
        guard let id else { return nil }
        return all.first { $0.id == id }
    }
}

/// The outcome of inspecting the composer's current text for a slash query.
public struct SlashMenuState: Equatable, Sendable {
    public let isOpen: Bool
    public let query: String
    public let matches: [SlashCommand]

    public static let closed = SlashMenuState(isOpen: false, query: "", matches: [])
}

/// Decide whether the composer's current text is a slash-menu query, and if
/// so which commands match.
///
/// The menu is an at-start affordance: it opens only when the text begins
/// with `/` and contains no whitespace yet (a lone `/` or a `/partial`
/// token). Once the user types a space — i.e. starts composing a real prompt
/// — the menu closes even if the prompt happens to begin with a slash word.
///
/// Matching is a case-insensitive substring over each command's trigger AND
/// label (whitespace-insensitive), so `/deep`, `/research`, and
/// `/Deep Research` all surface the one seeded item. A bare `/` lists
/// everything in `commands`.
///
/// `commands` is the gated command set the composer offers — typically
/// `SlashCommand.available(experimentalEnabled:)`, so experimental commands
/// only surface when the paired gateway runs in experimental mode. Defaults
/// to the full registry for callers that don't gate.
public func matchSlashCommands(
    _ text: String,
    commands: [SlashCommand] = SlashCommand.all
)
    -> SlashMenuState {
    guard text.hasPrefix("/") else { return .closed }
    let rest = text.dropFirst()
    // Any whitespace means the user has moved past the command token into a
    // real prompt — stop offering the menu.
    if rest.contains(where: \.isWhitespace) { return .closed }
    let query = rest.lowercased()
    let normalizedQuery = query.replacingOccurrences(of: " ", with: "")
    let matches = commands.filter { cmd in
        if query.isEmpty { return true }
        let label = cmd.label.lowercased().replacingOccurrences(of: " ", with: "")
        return cmd.trigger.lowercased().contains(query) || label.contains(normalizedQuery)
    }
    return SlashMenuState(isOpen: true, query: query, matches: matches)
}
