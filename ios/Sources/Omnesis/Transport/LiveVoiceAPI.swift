// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation

enum VoiceConnectionKind: Equatable { case realtime, live }

struct LiveVoiceCall: Decodable, Equatable {
    struct Transport: Decodable, Equatable { let type: String
        let sdp: String
    }

    let id: String
    let conversationId: String
    let model: String
    let backend: String
    let transport: Transport
}

struct LiveVoiceFailure: Decodable {
    let code: String
    let retryable: Bool?
    var presentation: RealtimeCallFailure {
        RealtimeCallFailure.server(["error": ["code": code, "retryable": retryable as Any]])
    }
}

struct LiveVoiceStatus: Decodable {
    let status: String
    let failure: LiveVoiceFailure?
    var replyFailure: LiveVoiceFailure?
}

struct LiveVoiceEnd: Decodable {
    let ended: Bool
    let usageConfirmed: Bool
    let failure: LiveVoiceFailure?
}

/// Signaling remains on the paired, authenticated gateway; provider credentials
/// stay on the gateway. REST uses an opaque gateway call identity; native media
/// ignores any provider identity carried by lifecycle events.
struct LiveVoiceAPI {
    let pairing: Pairing
    var session: URLSessionLike = OmnesisURLSession.shared
    var statusStream: (@Sendable (String) -> AsyncThrowingStream<LiveVoiceStatus, Error>)?

    func create(sdp: String, conversationID: String?, clientSessionID: String) async throws -> LiveVoiceCall {
        var body: [String: String] = ["sdp": sdp, "timeZone": TimeZone.current.identifier, "clientSessionId": clientSessionID]
        body["conversationId"] = conversationID
        let call: LiveVoiceCall = try await request("", method: "POST", body: body)
        guard call.transport.type == "webrtc", !call.transport.sdp.isEmpty, UUID(uuidString: call.id) != nil else {
            throw RealtimeCallFailure(code: "protocol_error", fatal: true, retryable: true)
        }
        return call
    }

    func events(id: String) -> AsyncThrowingStream<LiveVoiceStatus, Error> {
        if let statusStream { return statusStream(id) }
        return AsyncThrowingStream { continuation in
            let task = Task {
                do {
                    guard pairing.url.scheme == "https" else { throw URLError(.badURL) }
                    let url = pairing.url.appendingPathComponent("agent/realtime/sessions/\(id)/events")
                    var request = URLRequest(url: url)
                    request.timeoutInterval = 60
                    request.setValue("Bearer \(pairing.token)", forHTTPHeaderField: "Authorization")
                    request.setValue("text/event-stream", forHTTPHeaderField: "Accept")
                    request.setValue("identity", forHTTPHeaderField: "Accept-Encoding")
                    request.setValue("no-cache", forHTTPHeaderField: "Cache-Control")
                    let (bytes, response) = try await OmnesisURLSession.shared.bytes(for: request)
                    guard let http = response as? HTTPURLResponse, http.statusCode == 200 else {
                        throw RealtimeCallFailure.local(
                            URLError(.badServerResponse),
                            httpStatus: (response as? HTTPURLResponse)?.statusCode
                        )
                    }
                    var parser = SSEFrameParser()
                    var frameBytes = 0
                    for try await byte in bytes {
                        try Task.checkCancellation()
                        frameBytes += 1
                        guard frameBytes <= 65536 else { throw URLError(.dataLengthExceedsMaximum) }
                        if let frame = parser.consume(byte: byte) {
                            frameBytes = 0
                            let status = try JSONDecoder().decode(LiveVoiceStatus.self, from: Data(frame.data.utf8))
                            continuation.yield(status)
                        }
                    }
                    continuation.finish()
                } catch { continuation.finish(throwing: error) }
            }
            continuation.onTermination = { _ in task.cancel() }
        }
    }

    func ready(id: String) async throws {
        _ = try await perform("/\(id)/ready", method: "POST")
    }

    func status(id: String) async throws -> LiveVoiceStatus {
        try await request("/\(id)", method: "GET")
    }

    func end(id: String) async throws -> LiveVoiceEnd {
        try await request("/\(id)", method: "DELETE")
    }

    private func request<T: Decodable>(_ path: String, method: String, body: [String: String]? = nil) async throws -> T {
        try await JSONDecoder().decode(T.self, from: perform(path, method: method, body: body))
    }

    private func perform(_ path: String, method: String, body: [String: String]? = nil) async throws -> Data {
        guard pairing.url.scheme == "https" else { throw URLError(.badURL) }
        let url = pairing.url.appendingPathComponent("agent/realtime/sessions\(path)")
        var request = URLRequest(url: url)
        request.httpMethod = method
        request.timeoutInterval = 20
        request.setValue("Bearer \(pairing.token)", forHTTPHeaderField: "Authorization")
        if let body {
            request.httpBody = try JSONEncoder().encode(body)
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        }
        let (data, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse else { throw URLError(.badServerResponse) }
        guard (200 ..< 300).contains(http.statusCode) else {
            if let payload = RealtimeProtocol.event(data), let error = payload["failure"] as? [String: Any], error["code"] is String {
                throw RealtimeCallFailure.server(["error": error])
            }
            throw RealtimeCallFailure.local(URLError(.badServerResponse), httpStatus: http.statusCode)
        }
        return data
    }
}

/// Caption intervals are projections, never inferred canonical turns. Both
/// speakers may continue at once; packet gaps do not imply completion.
struct LiveVoiceCaption: Equatable, Identifiable {
    enum Speaker: String { case user, assistant }
    let id: String
    let speaker: Speaker
    let startMilliseconds: Int
    var endMilliseconds: Int
    var text: String
}

struct LiveVoiceCaptions {
    private(set) var fragments: [LiveVoiceCaption] = []
    private var seen: Set<String> = []

    var displayRuns: [LiveVoiceCaption] {
        var runs: [LiveVoiceCaption] = []
        for fragment in fragments {
            if let last = runs.indices.last, runs[last].speaker == fragment.speaker {
                runs[last].text += fragment.text
                runs[last].endMilliseconds = max(runs[last].endMilliseconds, fragment.endMilliseconds)
            } else { runs.append(fragment) }
        }
        return runs
    }

    mutating func receive(_ event: [String: Any]) {
        let speaker: LiveVoiceCaption.Speaker
        switch event["type"] as? String {
        case "session.input_transcript.delta": speaker = .user
        case "session.output_transcript.delta": speaker = .assistant
        default: return
        }
        guard let id = event["event_id"] as? String, id.utf8.count <= 256, !seen.contains(id),
              let delta = event["delta"] as? String, delta.utf8.count <= 65536,
              let start = event["start_ms"] as? Int, let end = event["end_ms"] as? Int,
              start >= 0, end >= start else { return }
        seen.insert(id)
        fragments.append(LiveVoiceCaption(id: id, speaker: speaker, startMilliseconds: start, endMilliseconds: end, text: delta))
        // Bound projection memory without changing canonical persisted history.
        while fragments.count > 256 || fragments.reduce(0, { $0 + $1.text.utf8.count }) > 65536 {
            fragments.removeFirst()
        }
        if seen.count > 2048 { seen = Set(fragments.map(\.id)) }
    }
}
