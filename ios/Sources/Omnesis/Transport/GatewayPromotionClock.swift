// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation

public protocol GatewayPromotionWaiting: Sendable {
    func wait() async throws
}

public struct GatewayPromotionClock: GatewayPromotionWaiting {
    private let interval: Duration
    public init() {
        interval = .seconds(30)
    }

    init(interval: Duration) {
        self.interval = interval
    }

    public func wait() async throws {
        try await Task.sleep(for: interval)
    }
}
