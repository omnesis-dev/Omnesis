// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation

/// Budgets columns inside the existing detail viewport rather than enlarging its window.
struct DesktopChatLayout: Equatable {
    static let historyWidth: CGFloat = 190
    static let separatorWidth: CGFloat = 1
    static let minimumReadingWidth: CGFloat = 320
    static let preferredReadingWidth: CGFloat = 400
    static let minimumSourcesWidth: CGFloat = 260
    static let maximumSourcesWidth: CGFloat = 320

    let readingWidth: CGFloat
    let sourcesWidth: CGFloat
    let showsHistory: Bool
    var showsSources: Bool {
        sourcesWidth > 0
    }

    var showsReading: Bool {
        readingWidth > 0
    }

    init(width: CGFloat, historyRequested: Bool, sourcesRequested: Bool) {
        let available = width.isFinite ? max(0, width) : 0
        if sourcesRequested {
            let minimum = Self.minimumReadingWidth + Self.minimumSourcesWidth + Self.separatorWidth
            guard available >= minimum else {
                // Keep the conversation mounted but inaccessible until sources close.
                readingWidth = 0
                sourcesWidth = available
                showsHistory = false
                return
            }
            let historyBudget = Self.historyWidth + Self.separatorWidth
            showsHistory = historyRequested && available >= historyBudget + Self.preferredReadingWidth + Self.minimumSourcesWidth + Self
                .separatorWidth
            let remaining = available - (showsHistory ? historyBudget : 0) - Self.separatorWidth
            sourcesWidth = min(Self.maximumSourcesWidth, max(Self.minimumSourcesWidth, remaining - Self.preferredReadingWidth))
            readingWidth = remaining - sourcesWidth
        } else {
            sourcesWidth = 0
            showsHistory = historyRequested && available >= Self.historyWidth + Self.separatorWidth + Self.minimumReadingWidth
            readingWidth = available - (showsHistory ? Self.historyWidth + Self.separatorWidth : 0)
        }
    }
}
