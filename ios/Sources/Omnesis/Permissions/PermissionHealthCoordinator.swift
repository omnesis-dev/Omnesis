// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation
import Observation

@available(iOS 17.0, *)
@MainActor
@Observable
final class PermissionHealthCoordinator {
    enum Evaluation: Equatable {
        case notEvaluated
        case loading
        case evaluated([SourcePermissionHealthReport])
    }

    enum Delivery: Equatable {
        case idle
        case reporting
        case deferred(Set<String>)
    }

    typealias Evaluator = @MainActor () async -> [SourcePermissionHealthReport]
    typealias Reporter = @Sendable (SourcePermissionHealthReport) async throws -> Void

    struct SourceCheck {
        let enabled: Bool
        let evaluate: @MainActor () async -> SourcePermissionHealthReport?

        init(
            enabled: Bool,
            evaluate: @escaping @MainActor () async -> SourcePermissionHealthReport?
        ) {
            self.enabled = enabled
            self.evaluate = evaluate
        }
    }

    private(set) var evaluation: Evaluation = .notEvaluated
    private(set) var delivery: Delivery = .idle
    private var refreshGeneration = 0
    /// Sources the gateway answered 404 for: not registered for this device.
    /// They are not reported again until registration or the next foreground.
    private var unregisteredSourceIds: Set<String> = []

    var reports: [SourcePermissionHealthReport] {
        guard case .evaluated(let reports) = evaluation else { return [] }
        return reports
    }

    func reset() {
        refreshGeneration &+= 1
        unregisteredSourceIds = []
        evaluation = .notEvaluated
        delivery = .idle
    }

    #if DEBUG
    func installPreview(_ reports: [SourcePermissionHealthReport]) {
        evaluation = .evaluated(reports)
    }

    func installLoadingPreview() {
        evaluation = .loading
    }

    func installDeliveryErrorPreview(sourceIds: Set<String>) {
        delivery = .deferred(sourceIds)
    }
    #endif

    func refresh(evaluate: Evaluator, report: Reporter?) async {
        refreshGeneration &+= 1
        let generation = refreshGeneration
        if delivery == .reporting { delivery = .idle }
        evaluation = .loading
        let reports = await evaluate()
        guard refreshGeneration == generation else { return }
        evaluation = .evaluated(reports)
        guard let report else { return }
        var deferred: Set<String> = if case .deferred(let sourceIds) = delivery {
            sourceIds
        } else {
            []
        }
        delivery = .reporting
        defer {
            // A superseding refresh owns the state now. Otherwise every exit,
            // including cancellation, must leave a stable retryable state.
            if refreshGeneration == generation, delivery == .reporting {
                delivery = deferred.isEmpty ? .idle : .deferred(deferred)
            }
        }
        for snapshot in reports {
            guard refreshGeneration == generation else { return }
            guard !unregisteredSourceIds.contains(snapshot.sourceId) else { continue }
            do {
                try await report(snapshot)
                deferred.remove(snapshot.sourceId)
            } catch GatewayClient.Error.notFound {
                // Registration decides what happens to a source the gateway
                // doesn't host for this device; reporting it again first only
                // repeats the 404.
                unregisteredSourceIds.insert(snapshot.sourceId)
                deferred.remove(snapshot.sourceId)
            } catch {
                if Task.isCancelled { return }
                deferred.insert(snapshot.sourceId)
                AppLog.make(category: "permissions").debug(
                    "Permission health report deferred for a local source: \(String(describing: error), privacy: .private)"
                )
            }
        }
    }

    /// Lets sources a 404 stopped be reported again: every source once per
    /// foreground, or one source as soon as it is registered.
    func allowReportingAgain(for sourceId: String? = nil) {
        if let sourceId {
            unregisteredSourceIds.remove(sourceId)
        } else {
            unregisteredSourceIds = []
        }
    }

    /// App lifecycle and OS callbacks share this source plan. Disabled sources
    /// are neither evaluated nor reported, so a local opt-out cannot publish a
    /// stale permission warning on the next transition.
    func refresh(sources: [SourceCheck], report: Reporter?) async {
        await refresh(
            evaluate: {
                var reports: [SourcePermissionHealthReport] = []
                for source in sources where source.enabled {
                    if let snapshot = await source.evaluate() {
                        reports.append(snapshot)
                    }
                }
                return reports
            },
            report: report
        )
    }
}
