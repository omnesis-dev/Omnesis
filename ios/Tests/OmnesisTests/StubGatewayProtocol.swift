// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

/// In-process gateway for the runner: answers session-create, send and
/// event-stream calls, records every request, and can be told to stall or
/// to reject a capped resume the way an older gateway does.
final class StubGatewayProtocol: URLProtocol, @unchecked Sendable {
    private struct State {
        var requests: [URLRequest] = []
        var sessionId = "sess-new"
        var priorMessageCount = 0
        var answer: String?
        var rejectCapped = false
        var rejectCreateStatus: Int?
        var stallCreate = false
        var stallAfterSend = false
        var busyResumeId: String?
        var rejectSendStatus: Int?
        var onSessionCreate: (@Sendable () -> Void)?
    }

    /// The assistant message id every turn runs under. Known up front, so
    /// the event stream can be served the moment it is attached.
    static let messageId = "m-1"

    private nonisolated(unsafe) static var state = State()
    private static let lock = NSLock()

    private static func mutate<T>(_ body: (inout State) -> T) -> T {
        lock.lock()
        defer { lock.unlock() }
        return body(&state)
    }

    static func reset() {
        mutate { $0 = State() }
    }

    /// Serve a turn that streams `text` and ends, over a conversation that
    /// already held `priorMessageCount` messages.
    static func answerTurn(sessionId: String, text: String, priorMessageCount: Int = 0) {
        mutate {
            $0.sessionId = sessionId
            $0.answer = text
            $0.priorMessageCount = priorMessageCount
        }
    }

    /// Reject `transcriptLimit=0` with a 400, as a gateway predating the
    /// empty-transcript page does.
    static func rejectCappedResume() {
        mutate { $0.rejectCapped = true }
    }

    static func rejectSessionCreate(status: Int) {
        mutate { $0.rejectCreateStatus = status }
    }

    /// Accept the connection for session-create and then never answer.
    static func stallSessionCreate() {
        mutate { $0.stallCreate = true }
    }

    /// Accept the question, then leave the turn running forever.
    static func acceptSendThenStall(sessionId: String) {
        mutate {
            $0.sessionId = sessionId
            $0.stallAfterSend = true
        }
    }

    /// Answer a resume of `sessionId` as a conversation whose previous turn is
    /// still running; a fresh create is served as usual.
    static func resumeIsBusy(sessionId: String) {
        mutate { $0.busyResumeId = sessionId }
    }

    static func rejectSend(status: Int) {
        mutate { $0.rejectSendStatus = status }
    }

    /// Called on each session-create, before the response is built — the
    /// hook a test uses to spend budget on the setup step.
    static func onSessionCreate(_ hook: @escaping @Sendable () -> Void) {
        mutate { $0.onSessionCreate = hook }
    }

    /// Session-create calls only — `/agent/sessions/:id/messages` shares
    /// the prefix, so matching on it would count the send as a create.
    static func sessionCreates() -> [URLRequest] {
        mutate {
            $0.requests.filter { $0.url?.path == "/agent/sessions" }
        }
    }

    static func sends() -> [URLRequest] {
        mutate {
            $0.requests.filter { $0.url?.path.hasSuffix("/messages") ?? false }
        }
    }

    // URLProtocol's overrides must be class funcs (they override class
    // methods), so `static` isn't possible here.
    // swiftlint:disable:next static_over_final_class
    override class func canInit(with _: URLRequest) -> Bool {
        true
    }

    // swiftlint:disable:next static_over_final_class
    override class func canonicalRequest(for request: URLRequest) -> URLRequest {
        request
    }

    override func startLoading() {
        let request = self.request
        Self.mutate { $0.requests.append(request) }
        let path = request.url?.path ?? ""
        let query = request.url?.query

        if path == "/agent/events" {
            // A stalled turn is a stream that stays open saying nothing;
            // an answered one streams its text and ends the message. The
            // stream is left open either way, so the engine folds it
            // rather than seeing EOF and re-attaching.
            if Self.mutate({ $0.stallAfterSend }) {
                openStream()
                return
            }
            let sessionId = Self.mutate { $0.sessionId }
            let answer = Self.mutate { $0.answer } ?? ""
            openStream(events: [
                [
                    "type": "agent.text.delta",
                    "payload": [
                        "sessionId": sessionId, "messageId": Self.messageId, "delta": answer,
                    ],
                ],
                [
                    "type": "agent.message.end",
                    "payload": [
                        "sessionId": sessionId, "messageId": Self.messageId,
                        "stopReason": "end_turn",
                    ],
                ],
            ])
            return
        }
        if path == "/agent/sessions" {
            respondToSessionCreate(query: query)
            return
        }
        if path.hasSuffix("/messages") {
            if let status = Self.mutate({ $0.rejectSendStatus }) {
                respond(status: status, body: Data("send rejected".utf8))
                return
            }
            respond(status: 200, json: ["messageId": Self.messageId, "userMessageId": "u-1"])
            return
        }
        if path.hasPrefix("/agent/conversations/") {
            if Self.mutate({ $0.stallAfterSend }) { return }
            let sessionId = Self.mutate { $0.sessionId }
            let answer = Self.mutate { $0.answer } ?? ""
            // The prior turns the ask resumed, then its own — so the
            // engine's index into the transcript has something to land on.
            let prior = (0 ..< Self.mutate { $0.priorMessageCount }).map { index in
                [
                    "role": index.isMultiple(of: 2) ? "user" : "assistant",
                    "parts": [["kind": "text", "text": "earlier"]],
                ]
            }
            respond(status: 200, json: [
                "id": sessionId,
                "callerId": "token:test",
                "model": "test-model",
                "backend": "test-backend",
                "createdAt": "2026-01-01T00:00:00.000Z",
                "updatedAt": "2026-01-01T00:00:00.000Z",
                "title": "test",
                "pinned": false,
                "messages": prior + [
                    ["role": "user", "parts": [["kind": "text", "text": "q"]]],
                    ["role": "assistant", "parts": [["kind": "text", "text": answer]]],
                ],
            ])
            return
        }
        respond(status: 404, body: Data())
    }

    override func stopLoading() {}

    /// A session create: stalled, rejected, a busy resume, or a fresh session.
    private func respondToSessionCreate(query: String?) {
        Self.mutate { $0.onSessionCreate }?()
        if Self.mutate({ $0.stallCreate }) { return }
        if let status = Self.mutate({ $0.rejectCreateStatus }) {
            respond(status: status, body: Data("request rejected".utf8))
            return
        }
        if Self.mutate({ $0.rejectCapped }), query == "transcriptLimit=0" {
            respond(status: 400, body: Data("transcript limit must be an integer".utf8))
            return
        }
        let resumeFromId = request.stubbedBody
            .flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] }?["resumeFromId"] as? String
        let busyId = Self.mutate { $0.busyResumeId }
        let busy = resumeFromId != nil && resumeFromId == busyId
        let sessionId = busy ? (busyId ?? "") : Self.mutate { $0.sessionId }
        respond(status: 200, json: [
            "sessionId": sessionId,
            "conversationId": sessionId,
            "model": "test-model",
            "backend": "test-backend",
            "messageCount": Self.mutate { $0.priorMessageCount },
            "busy": busy,
            "messages": [],
        ])
    }

    /// Open an SSE response, write each event as a frame, and leave the
    /// stream open — never finishing it, so the engine keeps folding
    /// rather than treating the end as a dropped connection.
    private func openStream(events: [[String: Any]] = []) {
        guard let url = request.url,
              let response = HTTPURLResponse(
                  url: url,
                  statusCode: 200,
                  httpVersion: "HTTP/1.1",
                  headerFields: ["Content-Type": "text/event-stream"]
              )
        else {
            return
        }
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        for event in events {
            guard let data = try? JSONSerialization.data(withJSONObject: event),
                  let json = String(data: data, encoding: .utf8)
            else {
                continue
            }
            client?.urlProtocol(self, didLoad: Data("data: \(json)\n\n".utf8))
        }
    }

    private func respond(status: Int, json: [String: Any]) {
        respond(status: status, body: (try? JSONSerialization.data(withJSONObject: json)) ?? Data())
    }

    private func respond(status: Int, body: Data) {
        guard let url = request.url,
              let response = HTTPURLResponse(
                  url: url,
                  statusCode: status,
                  httpVersion: "HTTP/1.1",
                  headerFields: ["Content-Type": "application/json"]
              )
        else {
            return
        }
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: body)
        client?.urlProtocolDidFinishLoading(self)
    }
}
