// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation
import Observation

/// Whether an operating-system permission prompt is on screen, so a waiting
/// page says "Waiting for iOS…" only while one really is. Code that asks for
/// access marks a prompt only when iOS will show one; an answer the user has
/// already given never marks one.
@available(iOS 17.0, *)
@MainActor
@Observable
public final class SystemPromptActivity {
    public static let shared = SystemPromptActivity()

    public private(set) var isPromptUp = false
    @ObservationIgnored private var openPrompts = 0
    /// How many prompts have been counted, so a check can tell that a decided
    /// permission showed none.
    @ObservationIgnored public private(set) var promptsShown = 0

    public init() {}

    /// Runs `work`, counting a prompt as up for its duration when `prompts`.
    public func during<T>(_ prompts: Bool, _ work: () async throws -> T) async rethrows -> T {
        guard prompts else { return try await work() }
        begin()
        defer { end() }
        return try await work()
    }

    /// Counts a prompt as up, for a wait that only learns part-way that iOS
    /// showed one.
    public func begin() {
        openPrompts += 1
        promptsShown += 1
        isPromptUp = true
    }

    public func end() {
        openPrompts = max(0, openPrompts - 1)
        isPromptUp = openPrompts > 0
    }
}
