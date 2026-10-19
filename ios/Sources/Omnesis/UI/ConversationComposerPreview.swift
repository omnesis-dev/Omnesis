// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

#if DEBUG
import Foundation

/// Deterministic HTTP acknowledgements for the real composer UI regression.
@available(iOS 17.0, *)
@MainActor
enum ConversationComposerPreview {
    static func install(on coordinator: AgentCoordinator) {
        ConversationComposerProtocol.reset()
        coordinator.installPreviewConversationControls(ConversationControls(
            busy: false,
            pendingClarification: ConversationClarification(
                id: "preview-question",
                question: "Which period should I compare?",
                choices: ["This month", "This year", "Last year"].map {
                    ConversationClarification.Choice(label: $0, description: nil)
                }
            ),
            queuedMessages: []
        ))
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [ConversationComposerProtocol.self]
        coordinator.attachForTesting(
            client: AgentClient(
                baseURL: URL(string: "https://composer.example")!,
                token: "fictional-preview-token",
                session: URLSession(configuration: configuration)
            ),
            sessionId: coordinator.sessionId ?? "composer-preview"
        )
        coordinator.stopForTesting()
    }
}

private final class ConversationComposerProtocol: URLProtocol {
    private static let lock = NSLock()
    private nonisolated(unsafe) static var answered = false

    static func reset() {
        lock.lock()
        defer { lock.unlock() }
        answered = false
    }

    // URLProtocol requires class overrides.
    // swiftlint:disable:next static_over_final_class
    override class func canInit(with request: URLRequest) -> Bool {
        true
    }

    // swiftlint:disable:next static_over_final_class
    override class func canonicalRequest(for request: URLRequest) -> URLRequest {
        request
    }

    override func startLoading() {
        Self.lock.lock()
        let failed = ProcessInfo.processInfo.environment["DEMO_COMPOSER_ACK"] == "failure"
        let submission = request.url?.lastPathComponent == "submissions"
        if submission, !failed { Self.answered = true }
        let answered = Self.answered
        Self.lock.unlock()
        let question = answered ? "null" : #"""
        {"id":"preview-question","question":"Which period should I compare?","choices":[
          {"label":"This month"},{"label":"This year"},{"label":"Last year"}]}
        """#
        let body = "{\"busy\":false,\"pendingClarification\":\(question),\"queuedMessages\":[]}"
        let status = submission && failed ? 503 : 200
        guard let url = request.url,
              let response = HTTPURLResponse(url: url, statusCode: status, httpVersion: nil, headerFields: nil) else {
            return
        }
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        let responseBody = status == 503 ? "Temporarily unavailable." : body
        client?.urlProtocol(self, didLoad: Data(responseBody.utf8))
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}
}
#endif
