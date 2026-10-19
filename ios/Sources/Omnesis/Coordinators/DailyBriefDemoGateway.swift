// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

#if DEBUG
import Foundation

/// A stand-in for `GET /agent/conversations/:id/briefs/:day` and the
/// reaction `PUT` under it that behaves like them: it answers each day's
/// items from its own store, 404s a day with no brief, fails the first read
/// of each day named in `failingOnce` — so the Retry line can be driven on
/// the simulator and shown to recover — and refuses every reaction to an
/// item named in `refusingReactions`.
///
/// It backs the Morning brief UI tests (`DEMO_MENU_REVEAL=briefs`), which
/// drive the real conversation and check what it shows after each tap.
actor DailyBriefDemoGateway: DailyBriefItemsLoading {
    /// One reaction as it was sent.
    struct Reaction: Equatable {
        let observationId: String
        let kind: DailyBriefReaction.Kind?
        let note: String?
    }

    private let pages: [String: DailyBriefItems]
    private var failingOnce: Set<String>
    private let refusingReactions: Set<String>
    /// Every day read, in order, failed reads included.
    private(set) var reads: [String] = []
    /// Every reaction sent, in order, refused ones included.
    private(set) var reactions: [Reaction] = []

    init(pages: [DailyBriefItems], failingOnce: Set<String> = [], refusingReactions: Set<String> = []) {
        self.pages = Dictionary(pages.map { ($0.day, $0) }) { _, last in last }
        self.failingOnce = failingOnce
        self.refusingReactions = refusingReactions
    }

    func items(conversationId _: String, day: String) async throws -> DailyBriefItems {
        reads.append(day)
        if failingOnce.remove(day) != nil {
            throw GatewayClient.Error.serverError(status: 503, body: #"{"error":"Briefs are unavailable"}"#)
        }
        guard let page = pages[day] else { throw GatewayClient.Error.notFound }
        return page
    }

    func react(
        conversationId _: String,
        day: String,
        observationId: String,
        reaction: DailyBriefReaction.Kind?,
        note: String?
    ) async throws -> DailyBriefReaction? {
        reactions.append(Reaction(observationId: observationId, kind: reaction, note: note))
        if refusingReactions.contains(observationId) {
            throw GatewayClient.Error.serverError(status: 503, body: #"{"error":"Reactions are unavailable"}"#)
        }
        guard pages[day]?.items.contains(where: { $0.observationId == observationId }) == true else {
            throw GatewayClient.Error.notFound
        }
        return reaction.map { DailyBriefReaction(kind: $0, note: note, at: Date(timeIntervalSince1970: 1_792_000_000)) }
    }
}
#endif
