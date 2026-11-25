// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import AppIntents
import Foundation
import Observation

@MainActor @Observable
final class DesktopActionRouter {
    static let shared = DesktopActionRouter()
    var newConversation = UUID()
    var question: String?
}

struct NewOmnesisConversationIntent: AppIntent {
    static let title: LocalizedStringResource = "New Omnesis conversation"
    static let description = IntentDescription("Open Omnesis and start a conversation about your information.")
    static let openAppWhenRun = true
    static var parameterSummary: some ParameterSummary {
        Summary("Start a new Omnesis conversation")
    }

    @MainActor func perform() async throws -> some IntentResult {
        DesktopActionRouter.shared.question = nil
        DesktopActionRouter.shared.newConversation = UUID()
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
        DesktopActionRouter.shared.question = question
        DesktopActionRouter.shared.newConversation = UUID()
        return .result()
    }
}
