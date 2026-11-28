// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import AppIntents
import Foundation
import Observation

@MainActor @Observable
final class DesktopActionRouter {
    static let shared = DesktopActionRouter()
    struct Request: Equatable {
        let id: UUID
        let question: String?
    }

    var pending: Request?

    func enqueue(question: String?) {
        pending = Request(id: UUID(), question: question)
    }

    @discardableResult func consume(_ request: Request) -> Bool {
        guard pending?.id == request.id else { return false }
        pending = nil
        return true
    }
}

struct NewOmnesisConversationIntent: AppIntent {
    static let title: LocalizedStringResource = "New Omnesis conversation"
    static let description = IntentDescription("Open Omnesis and start a conversation about your information.")
    static let openAppWhenRun = true
    static var parameterSummary: some ParameterSummary {
        Summary("Start a new Omnesis conversation")
    }

    @MainActor func perform() async throws -> some IntentResult {
        DesktopActionRouter.shared.enqueue(question: nil)
        return .result()
    }
}

struct AskOmnesisDesktopIntent: AppIntent {
    static let title: LocalizedStringResource = "Ask Omnesis"
    static let description = IntentDescription("Open a new Omnesis conversation with your question ready to send.")
    static let openAppWhenRun = true
    @Parameter(title: "Question") var question: String
    static var parameterSummary: some ParameterSummary {
        Summary("Ask Omnesis \(\.$question)")
    }

    @MainActor func perform() async throws -> some IntentResult {
        DesktopActionRouter.shared.enqueue(question: question)
        return .result()
    }
}
