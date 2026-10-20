// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation

/// Present each receipt once while its transcript arrives. A send-now request
/// can roll back its optimistic transfer; a delivered event cannot. Keep server
/// snapshots untouched and preserve newer receipts, even with identical text.
struct ConversationQueueHandoff {
    private var transferring: Set<String> = []
    private var consumed: Set<String> = []

    mutating func delivered(ids: [String]) {
        consumed.formUnion(ids)
    }

    mutating func begin(ids: [String]) -> Set<String> {
        let added = Set(ids).subtracting(transferring)
        transferring.formUnion(ids)
        return added
    }

    mutating func failed(_ attempt: Set<String>) {
        transferring.subtract(attempt)
    }

    func presenting(_ controls: ConversationControls) -> ConversationControls {
        ConversationControls(
            busy: controls.busy,
            pendingClarification: controls.pendingClarification,
            queuedMessages: controls.queuedMessages
                .filter { $0.status != "queued" || !transferring.contains($0.id) && !consumed.contains($0.id) },
            capabilities: controls.capabilities
        )
    }
}
