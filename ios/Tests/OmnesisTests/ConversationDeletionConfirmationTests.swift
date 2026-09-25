// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

@testable import Omnesis
import XCTest

final class ConversationDeletionConfirmationTests: XCTestCase {
    func testConfirmationRetainsTargetWhenDialogDismissesBeforeAction() {
        var confirmation = ConversationDeletionConfirmation()
        confirmation.present(conversationId: "conversation-a")

        // SwiftUI can write `false` to the presentation binding before it
        // invokes the destructive button's closure.
        confirmation.dismissPresentation()

        XCTAssertEqual(confirmation.takeConfirmedConversationId(), "conversation-a")
        XCTAssertNil(confirmation.conversationId)
        XCTAssertFalse(confirmation.isPresented)
    }

    func testCancelClearsPendingTarget() {
        var confirmation = ConversationDeletionConfirmation()
        confirmation.present(conversationId: "conversation-a")

        confirmation.cancel()

        XCTAssertNil(confirmation.takeConfirmedConversationId())
        XCTAssertFalse(confirmation.isPresented)
    }
}
