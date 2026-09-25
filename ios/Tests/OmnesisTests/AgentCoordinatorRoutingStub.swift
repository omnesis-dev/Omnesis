// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation

/// Explicit response barrier for ABA tests. Holding the response until the
/// test releases this gate proves the intended interleaving without relying
/// on wall-clock delays or scheduler speed.
final class ScriptedResponseGate: @unchecked Sendable {
    private let semaphore = DispatchSemaphore(value: 0)
    private let lock = NSLock()
    private var released = false

    func release() {
        lock.lock()
        defer { lock.unlock() }
        guard !released else { return }
        released = true
        semaphore.signal()
    }

    fileprivate func wait() {
        semaphore.wait()
    }
}

struct ScriptedMessageResponse {
    let delay: TimeInterval
    let status: Int
    let body: Data
    let gate: ScriptedResponseGate?

    init(
        delay: TimeInterval,
        status: Int,
        body: Data,
        gate: ScriptedResponseGate? = nil
    ) {
        self.delay = delay
        self.status = status
        self.body = body
        self.gate = gate
    }
}

struct ScriptedConversationResponse {
    let delay: TimeInterval
    let status: Int
    let body: Data
}

/// In-process `URLProtocol` that routes agent bootstrap, session, transcript,
/// and SSE requests through deterministic response queues.
final class RoutingStubProtocol: URLProtocol {
    nonisolated(unsafe) static var sseBody = Data()
    nonisolated(unsafe) static var jsonBody = Data("{}".utf8)
    nonisolated(unsafe) static var conversationsBody: Data?
    nonisolated(unsafe) static var conversationResponses: [ScriptedConversationResponse] = []
    nonisolated(unsafe) static var sessionResponses: [(delay: TimeInterval, body: Data)] = []
    nonisolated(unsafe) static var sendResponses: [ScriptedMessageResponse] = []
    nonisolated(unsafe) static var messageResponses: [ScriptedMessageResponse] = []
    nonisolated(unsafe) static var cancelResponses: [ScriptedMessageResponse] = []
    nonisolated(unsafe) static var conversationActionResponses: [ScriptedMessageResponse] = []
    nonisolated(unsafe) static var conversationRequestCount = 0
    nonisolated(unsafe) static var sessionRequestCount = 0
    nonisolated(unsafe) static var sessionRequestBodies: [Data] = []
    nonisolated(unsafe) static var sendRequestCount = 0
    nonisolated(unsafe) static var messageRequestCount = 0
    nonisolated(unsafe) static var cancelRequestCount = 0
    /// Every PATCH/DELETE against one stored conversation, including its body.
    nonisolated(unsafe) static var conversationActions: [(method: String, path: String, body: String)] = []
    /// Every `POST /agent/conversations/:id/seen`, as (conversation id, body).
    nonisolated(unsafe) static var seenMarks: [(id: String, body: String)] = []
    private static let lock = NSLock()

    static func reset() {
        lock.lock()
        sseBody = Data()
        jsonBody = Data("{}".utf8)
        conversationsBody = nil
        conversationResponses = []
        sessionResponses = []
        sendResponses = []
        messageResponses = []
        cancelResponses = []
        conversationActionResponses = []
        conversationRequestCount = 0
        sessionRequestCount = 0
        sessionRequestBodies = []
        sendRequestCount = 0
        messageRequestCount = 0
        cancelRequestCount = 0
        conversationActions = []
        seenMarks = []
        lock.unlock()
    }

    static func recordedSeenMarks() -> [(id: String, body: String)] {
        lock.lock()
        defer { lock.unlock() }
        return seenMarks
    }

    static func recordedConversationActions() -> [(method: String, path: String, body: String)] {
        lock.lock()
        defer { lock.unlock() }
        return conversationActions
    }

    static func seenSessionRequests() -> Int {
        lock.lock()
        defer { lock.unlock() }
        return sessionRequestCount
    }

    static func recordedSessionRequestBodies() -> [Data] {
        lock.lock()
        defer { lock.unlock() }
        return sessionRequestBodies
    }

    static func seenConversationRequests() -> Int {
        lock.lock()
        defer { lock.unlock() }
        return conversationRequestCount
    }

    static func seenMessageRequests() -> Int {
        lock.lock()
        defer { lock.unlock() }
        return messageRequestCount
    }

    static func seenSendRequests() -> Int {
        lock.lock()
        defer { lock.unlock() }
        return sendRequestCount
    }

    static func seenCancelRequests() -> Int {
        lock.lock()
        defer { lock.unlock() }
        return cancelRequestCount
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

    private func requestBody(bufferSize: Int) -> Data {
        request.httpBody ?? request.httpBodyStream.map { stream -> Data in
            stream.open()
            defer { stream.close() }
            var data = Data()
            var buffer = [UInt8](repeating: 0, count: bufferSize)
            while stream.hasBytesAvailable {
                let read = stream.read(&buffer, maxLength: buffer.count)
                if read <= 0 { break }
                data.append(contentsOf: buffer[0 ..< read])
            }
            return data
        } ?? Data()
    }

    override func startLoading() {
        let path = request.url?.path
        let isEvents = path == "/agent/events"
        Self.lock.lock()
        var body = isEvents ? Self.sseBody : Self.jsonBody
        var delay: TimeInterval = 0
        var status = 200
        var responseGate: ScriptedResponseGate?
        if !isEvents {
            if path == "/agent/conversations" {
                Self.conversationRequestCount += 1
                if !Self.conversationResponses.isEmpty {
                    let scripted = Self.conversationResponses.removeFirst()
                    delay = scripted.delay
                    status = scripted.status
                    body = scripted.body
                } else if let conversations = Self.conversationsBody {
                    body = conversations
                }
            } else if path == "/agent/sessions" {
                Self.sessionRequestCount += 1
                let raw = requestBody(bufferSize: 512)
                Self.sessionRequestBodies.append(raw)
                if !Self.sessionResponses.isEmpty {
                    let scripted = Self.sessionResponses.removeFirst()
                    delay = scripted.delay
                    body = scripted.body
                }
            } else if path?.hasPrefix("/agent/conversations/") == true,
                      path?.hasSuffix("/seen") == true {
                let id = path?
                    .replacingOccurrences(of: "/agent/conversations/", with: "")
                    .replacingOccurrences(of: "/seen", with: "") ?? ""
                // URLProtocol strips a streamed body, so read it back from the
                // request's bodyStream when httpBody is nil.
                let raw = requestBody(bufferSize: 256)
                Self.seenMarks.append((id: id, body: String(bytes: raw, encoding: .utf8) ?? ""))
                body = Data("{\"ok\":true}".utf8)
            } else if path?.hasPrefix("/agent/conversations/") == true,
                      path?.hasSuffix("/messages") == true {
                Self.messageRequestCount += 1
                if !Self.messageResponses.isEmpty {
                    let scripted = Self.messageResponses.removeFirst()
                    delay = scripted.delay
                    status = scripted.status
                    body = scripted.body
                    responseGate = scripted.gate
                }
            } else if path?.hasPrefix("/agent/sessions/") == true,
                      path?.hasSuffix("/messages") == true {
                Self.sendRequestCount += 1
                if !Self.sendResponses.isEmpty {
                    let scripted = Self.sendResponses.removeFirst()
                    delay = scripted.delay
                    status = scripted.status
                    body = scripted.body
                    responseGate = scripted.gate
                }
            } else if path?.hasPrefix("/agent/sessions/") == true,
                      path?.hasSuffix("/cancel") == true {
                Self.cancelRequestCount += 1
                if !Self.cancelResponses.isEmpty {
                    let scripted = Self.cancelResponses.removeFirst()
                    delay = scripted.delay
                    status = scripted.status
                    body = scripted.body
                    responseGate = scripted.gate
                }
            } else if path?.hasPrefix("/agent/conversations/") == true,
                      request.httpMethod == "PATCH" || request.httpMethod == "DELETE" {
                let raw = requestBody(bufferSize: 256)
                Self.conversationActions.append((
                    method: request.httpMethod ?? "",
                    path: path ?? "",
                    body: String(bytes: raw, encoding: .utf8) ?? ""
                ))
                body = Data("{\"ok\":true}".utf8)
                if !Self.conversationActionResponses.isEmpty {
                    let scripted = Self.conversationActionResponses.removeFirst()
                    delay = scripted.delay
                    status = scripted.status
                    body = scripted.body
                    responseGate = scripted.gate
                }
            }
        }
        Self.lock.unlock()
        let contentType = isEvents ? "text/event-stream" : "application/json"
        let respond = {
            let response = HTTPURLResponse(
                url: self.request.url!,
                statusCode: status,
                httpVersion: "HTTP/1.1",
                headerFields: ["Content-Type": contentType]
            )!
            self.client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
            self.client?.urlProtocol(self, didLoad: body)
            self.client?.urlProtocolDidFinishLoading(self)
        }
        if let responseGate {
            DispatchQueue.global().async {
                responseGate.wait()
                respond()
            }
        } else if delay > 0 {
            DispatchQueue.global().asyncAfter(deadline: .now() + delay, execute: respond)
        } else {
            respond()
        }
    }

    override func stopLoading() {}
}
