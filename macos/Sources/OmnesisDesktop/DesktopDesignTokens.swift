// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import SwiftUI

/// Shared presentation values; layout-specific geometry remains with its owning view.
enum DesktopDesignTokens {
    enum Typography {
        static let display = Font.system(size: 30, weight: .semibold)
        static let emptyTitle = Font.system(size: 28, weight: .semibold)
        static let pageTitle = Font.system(size: 24, weight: .semibold)
        static let section = Font.system(size: 17, weight: .semibold)
        static let body = Font.system(size: 14)
        static let secondary = Font.system(size: 13)
        static let navigation = Font.system(size: 13, weight: .medium)
        static let button = Font.system(size: 13, weight: .medium)
        static let metadata = Font.system(size: 12)
        static let caption = Font.system(size: 11)
    }

    enum Space {
        static let xSmall: CGFloat = 4
        static let small: CGFloat = 8
        static let medium: CGFloat = 12
        static let regular: CGFloat = 16
        static let large: CGFloat = 20
        static let section: CGFloat = 24
        static let wide: CGFloat = 32
    }

    enum Radius {
        static let small: CGFloat = 4
        static let control: CGFloat = 6
        static let medium: CGFloat = 8
        static let large: CGFloat = 12
        static let composer: CGFloat = 16
    }

    enum Icon {
        static let metadata: CGFloat = 12
        static let standard: CGFloat = 16
        static let prominent: CGFloat = 20
    }

    enum Control {
        static let compactHeight: CGFloat = 26
        static let height: CGFloat = 30
        static let iconTarget: CGFloat = 32
        static let horizontalPadding: CGFloat = 12
    }

    enum Layout {
        static let compactMargin: CGFloat = 16
        static let pageMargin: CGFloat = 24
        static let wideMargin: CGFloat = 32
        static let compactWidth: CGFloat = 520
        static let formWidth: CGFloat = 640
        static let readingWidth: CGFloat = 720
        static let generalWidth: CGFloat = 960
    }

    enum Motion {
        /// Presentation may opt into this transition; controls need no decorative motion.
        static func transition(reduceMotion: Bool) -> Animation? {
            reduceMotion ? nil : .easeInOut(duration: 0.18)
        }
    }
}
