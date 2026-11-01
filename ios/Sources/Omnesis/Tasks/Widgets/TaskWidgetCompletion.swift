// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation

public enum TaskWidgetCompletionError: Error, Equatable {
    case staleAuthority
}

/// A rendered checkbox belongs to the authority that produced that timeline.
/// Re-pairing must never send a stale task identifier to another gateway.
public enum TaskWidgetCompletion {
    public static func perform(
        id: String,
        expectedAuthorityID: String,
        store: PairingStore = TaskWidgetStorage.keychain(),
        request: TaskWidgetClient.Request? = nil
    ) async throws {
        guard let credential = try TaskWidgetStorage.credential(store: store),
              credential.authorityID == expectedAuthorityID else {
            throw TaskWidgetCompletionError.staleAuthority
        }
        try await TaskWidgetClient(credential: credential, request: request).complete(id: id)
        // A failure above leaves the checkbox and cached task untouched. A
        // successful POST is reflected even when the next network read fails.
        do {
            guard try TaskWidgetStorage.credential(store: store) == credential,
                  let snapshot = try TaskWidgetStorage.snapshot(store: store) else { return }
            try TaskWidgetStorage.save(
                snapshot: TaskWidgetSnapshot(tasks: snapshot.tasks.filter { $0.id != id }, updatedAt: Date()),
                credential: credential,
                store: store
            )
        } catch {
            // The gateway committed the action. Local cache unavailability
            // must not report that successful completion as a failed command;
            // the provider's next refresh reconciles the task list.
        }
    }
}
