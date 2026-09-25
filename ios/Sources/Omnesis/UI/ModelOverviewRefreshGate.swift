// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation

/// Apply only the most recently started models-overview request. A GET begun
/// before a behavior PATCH cannot replace the overview fetched after it.
@MainActor
final class ModelOverviewRefreshGate {
    enum Outcome {
        case loaded(ModelsOverview, ticket: Int)
        case failed(Error, ticket: Int)
        case stale
    }

    private var revision = 0

    func fetch(_ request: () async throws -> ModelsOverview) async -> Outcome {
        revision += 1
        let ticket = revision
        do {
            let overview = try await request()
            return ticket == revision ? .loaded(overview, ticket: ticket) : .stale
        } catch {
            return ticket == revision ? .failed(error, ticket: ticket) : .stale
        }
    }

    func isCurrent(_ ticket: Int) -> Bool {
        ticket == revision
    }
}
