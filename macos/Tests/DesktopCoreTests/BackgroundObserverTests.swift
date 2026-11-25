// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import DesktopCore
import Foundation
import XCTest

final class BackgroundObserverTests: XCTestCase {
    func testOnlyActualTrashDescendantsRetireTheApplication() {
        let trash = URL(fileURLWithPath: "/example/.Trash", isDirectory: true)
        XCTAssertTrue(DesktopApplicationLocation.isInTrash(URL(fileURLWithPath: "/example/.Trash/Omnesis.app"), trash: trash))
        XCTAssertFalse(DesktopApplicationLocation.isInTrash(URL(fileURLWithPath: "/example/.Trash-copy/Omnesis.app"), trash: trash))
        XCTAssertFalse(DesktopApplicationLocation.isInTrash(URL(fileURLWithPath: "/Applications/Omnesis.app"), trash: trash))
        XCTAssertFalse(DesktopApplicationLocation.isInTrash(URL(fileURLWithPath: "/example/Other/Omnesis.app"), trash: trash))
    }
}
