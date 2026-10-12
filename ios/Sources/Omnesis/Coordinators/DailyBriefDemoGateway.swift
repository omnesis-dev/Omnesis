// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

#if DEBUG
import Foundation

/// A stand-in for `GET /agent/conversations/:id/briefs/:day` that behaves
/// like it: it answers each day's items from its own store, 404s a day with
/// no brief, and fails the first read of each day named in `failingOnce` —
/// so the Retry line can be driven on the simulator and shown to recover.
///
/// It backs the Morning brief UI tests (`DEMO_MENU_REVEAL=briefs`), which
/// drive the real conversation and check what it shows after each tap.
actor DailyBriefDemoGateway: DailyBriefItemsLoading {
    private let pages: [String: DailyBriefItems]
    private var failingOnce: Set<String>
    /// Every day read, in order, failed reads included.
    private(set) var reads: [String] = []

    init(pages: [DailyBriefItems], failingOnce: Set<String> = []) {
        self.pages = Dictionary(pages.map { ($0.day, $0) }) { _, last in last }
        self.failingOnce = failingOnce
    }

    func items(conversationId _: String, day: String) async throws -> DailyBriefItems {
        reads.append(day)
        if failingOnce.remove(day) != nil {
            throw GatewayClient.Error.serverError(status: 503, body: #"{"error":"Briefs are unavailable"}"#)
        }
        guard let page = pages[day] else { throw GatewayClient.Error.notFound }
        return page
    }
}
#endif
