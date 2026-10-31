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
            return !Task.isCancelled && ticket == revision ? .loaded(overview, ticket: ticket) : .stale
        } catch {
            return !Task.isCancelled && ticket == revision ? .failed(error, ticket: ticket) : .stale
        }
    }

    /// Awaited by the view's structured task; a late request cannot create a
    /// polling lifetime after the screen disappears or the app becomes inactive.
    func refreshWhileVisible(
        load: () async -> Void,
        interval: () -> Duration,
        refresh: () async -> Void,
        sleep: (Duration) async throws -> Void = { try await Task.sleep(for: $0) }
    ) async {
        guard !Task.isCancelled else { return }
        await load()
        while !Task.isCancelled {
            do { try await sleep(interval()) } catch { return }
            guard !Task.isCancelled else { return }
            await refresh()
        }
    }

    func isCurrent(_ ticket: Int) -> Bool {
        ticket == revision
    }
}
