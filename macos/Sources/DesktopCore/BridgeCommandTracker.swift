// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/// Reply acknowledgements never release the lifecycle operation that is still
/// waiting for the account browser or device approval to finish.
public struct BridgeCommandTracker: Sendable {
    private var pending: [String: String] = [:]
    public init() {}
    public var busy: Bool {
        pending.values.contains { $0 != "respond" && $0 != "cancel" && $0 != "status" }
    }

    public var canPoll: Bool {
        pending.isEmpty
    }

    public mutating func submitted(id: String, command: String) {
        pending[id] = command
    }

    public mutating func completed(id: String) {
        pending.removeValue(forKey: id)
    }

    public func canSubmit(_ command: String) -> Bool {
        if command == "respond" || command == "cancel" { return true }
        if command == "status" { return canPoll }
        return !busy
    }
}
