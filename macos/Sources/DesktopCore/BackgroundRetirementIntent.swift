// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation

/// Freezing a helper is irreversible. Restoring its app retires that helper, not its library.
public struct DesktopBackgroundRetirementIntent {
    public enum Action: Equatable, Sendable { case unchanged, retire, shutdown }
    private enum Phase { case active, retiring(UUID), restoredTerminal }
    private var phase = Phase.active

    public init() {}

    public var ticket: UUID? {
        if case .retiring(let ticket) = phase { return ticket }
        return nil
    }

    public func permits(_ ticket: UUID) -> Bool {
        self.ticket == ticket
    }

    public mutating func observe(inTrash: Bool) -> Action {
        switch phase {
        case .active:
            guard inTrash else { return .unchanged }
            phase = .retiring(UUID())
            return .retire
        case .retiring:
            guard !inTrash else { return .retire }
            // Invalidate the pending launch synchronously, before asking the delegate to drain.
            phase = .restoredTerminal
            return .shutdown
        case .restoredTerminal:
            return .shutdown
        }
    }
}
