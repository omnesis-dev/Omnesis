// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation

/// Async cache preparation must not publish a control listener after the helper starts draining.
@MainActor
public final class DesktopBackgroundPreparationGate {
    private var incarnation = UUID()
    private var closed = false
    public init() {}

    public func begin() throws -> UUID {
        guard !closed else { throw CancellationError() }
        incarnation = UUID()
        return incarnation
    }

    public func accepts(_ operation: UUID) -> Bool {
        !closed && operation == incarnation
    }

    public func close() {
        closed = true
        incarnation = UUID()
    }
}
