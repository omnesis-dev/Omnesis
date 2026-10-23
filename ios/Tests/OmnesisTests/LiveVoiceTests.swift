// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation
@testable import Omnesis
import XCTest

private actor LiveVoiceHTTPFixture: URLSessionLike {
    var requests: [URLRequest] = []
    var failCreate = false
    var capability: String?
    let id = "00000000-0000-4000-8000-000000000001"

    func data(for request: URLRequest) async throws -> (Data, URLResponse) {
        requests.append(request)
        let body: String
        var status = 200
        if request.url!.path.hasSuffix("/agent/realtime"), let capability {
            body = capability
        } else if request.url!.path.hasSuffix("/ready") {
            body = ""
            status = 204
        } else if request.httpMethod == "DELETE" {
            body = #"{"ended":true,"usageConfirmed":true}"#
        } else if request.httpMethod == "GET" {
            body = #"{"status":"connected"}"#
        } else if failCreate {
            status = 429
            body = #"{"error":"private contents","failure":{"code":"project_spend_limit_exceeded","retryable":false,"fatal":true}}"#
        } else {
            body = #"""
            {"id":"00000000-0000-4000-8000-000000000001","conversationId":"same-chat",
             "model":"configured-model","backend":"configured-backend","transport":{"type":"webrtc","sdp":"answer"},
             "voice":{"model":"gpt-live-1"},"future":true}
            """#
        }
        return (Data(body.utf8), HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: nil, headerFields: nil)!)
    }

    func rejectCreation() {
        failCreate = true
    }

    func advertise(_ body: String) {
        capability = body
    }
}

@MainActor
private final class LiveMediaFixture: LiveVoiceMedia {
    var onEvent: ((Data) -> Void)?
    var onFailure: ((Error) -> Void)?
    var onLevels: ((Double, Double) -> Void)?
    var enabled: [Bool] = []
    var closed = false
    var microphoneFailure: Error?
    func offer() async throws -> String {
        "offer"
    }

    func connect(answer: String) async throws {
        XCTAssertEqual(answer, "answer")
        event(["type": "session.started"])
    }

    func enableMicrophone(_ enabled: Bool) {
        self.enabled.append(enabled)
        if enabled, let microphoneFailure { onFailure?(microphoneFailure) }
    }

    func close() {
        closed = true
    }

    func event(_ event: [String: Any]) {
        guard let data = try? JSONSerialization.data(withJSONObject: event) else {
            XCTFail("Invalid scripted event")
            return
        }
        onEvent?(data)
    }
}

@MainActor
final class LiveVoiceTests: XCTestCase {
    private var pairing: Pairing {
        Pairing(
            url: URL(string: "https://gateway.example.com")!,
            token: "test-token",
            accountId: "local",
            deviceId: "test-device",
            gatewayName: "Example"
        )
    }

    func testCanonicalHandoffAndReadyPrecedeMicrophone() async throws {
        let http = LiveVoiceHTTPFixture()
        let media = LiveMediaFixture()
        var states: [LiveVoiceSession.State] = []
        let session = LiveVoiceSession(
            api: LiveVoiceAPI(pairing: pairing, session: http, statusStream: { _ in
                AsyncThrowingStream { continuation in
                    continuation.yield(LiveVoiceStatus(status: "connected", failure: nil))
                }
            }),
            media: media,
            permission: { true },
            publish: {
                states.append($0)
            }
        )
        await session.start(conversationID: "same-chat") { id in
            XCTAssertEqual(id, "same-chat")
            XCTAssertTrue(media.enabled.isEmpty)
            let beforeReady = await http.requests
            XCTAssertFalse(beforeReady.contains { $0.url!.path.hasSuffix("/ready") })
        }
        XCTAssertEqual(media.enabled, [true])
        XCTAssertTrue(states.last?.connected == true)
        let requests = await http.requests
        XCTAssertEqual(requests.map(\.httpMethod), ["POST", "POST"])
        XCTAssertEqual(requests.first?.value(forHTTPHeaderField: "Authorization"), "Bearer test-token")
        let body = try XCTUnwrap(try RealtimeProtocol.event(XCTUnwrap(requests.first?.httpBody)))
        XCTAssertEqual(body["conversationId"] as? String, "same-chat")
        XCTAssertNotNil(try UUID(uuidString: XCTUnwrap(body["clientSessionId"] as? String)))
        await session.end()
        XCTAssertTrue(media.closed)
        XCTAssertFalse(states.last?.connected == true)
        let endedRequests = await http.requests
        XCTAssertEqual(endedRequests.filter { $0.httpMethod == "DELETE" }.count, 1)
    }

    func testSynchronousMicrophoneFailureNeverPublishesConnected() async {
        let http = LiveVoiceHTTPFixture()
        let media = LiveMediaFixture()
        media.microphoneFailure = RealtimeCallFailure(code: "microphone_unavailable", fatal: true, retryable: true)
        var states: [LiveVoiceSession.State] = []
        let session = LiveVoiceSession(
            api: LiveVoiceAPI(pairing: pairing, session: http, statusStream: { _ in
                AsyncThrowingStream { continuation in
                    continuation.yield(LiveVoiceStatus(status: "connected", failure: nil))
                }
            }),
            media: media,
            permission: { true },
            publish: { states.append($0) }
        )
        await session.start(conversationID: nil, onReady: nil)
        XCTAssertFalse(states.contains { $0.connected })
        XCTAssertNotNil(states.last?.error)
        XCTAssertTrue(media.closed)
    }

    func testGatewayFailureStopsHealthyPeerAndPreservesActionableCause() async {
        for statusFailure in [true, false] {
            let http = LiveVoiceHTTPFixture()
            let media = LiveMediaFixture()
            let stream = AsyncThrowingStream<LiveVoiceStatus, Error>.makeStream()
            let failed = expectation(description: "gateway lifecycle failure delivered")
            var state = LiveVoiceSession.State()
            let session = LiveVoiceSession(
                api: LiveVoiceAPI(pairing: pairing, session: http, statusStream: { _ in stream.stream }),
                media: media,
                permission: { true },
                publish: {
                    state = $0
                    if $0.error != nil { failed.fulfill() }
                }
            )
            stream.continuation.yield(LiveVoiceStatus(status: "connected", failure: nil))
            await session.start(conversationID: nil, onReady: nil)
            XCTAssertTrue(state.connected)
            if statusFailure {
                stream.continuation.yield(LiveVoiceStatus(
                    status: "failed",
                    failure: LiveVoiceFailure(code: "pairing_rejected", retryable: false)
                ))
            } else {
                stream.continuation.finish(throwing: RealtimeCallFailure(code: "pairing_rejected", fatal: true, retryable: false))
            }
            await fulfillment(of: [failed], timeout: 2)
            XCTAssertFalse(state.connected)
            XCTAssertEqual(state.error?.code, "pairing_rejected")
            let requests = await http.requests
            XCTAssertFalse(requests.contains { $0.httpMethod == "GET" })
            XCTAssertTrue(media.closed)
            session.stop()
            stream.continuation.finish()
        }
    }

    func testNonfatalGatewayReplyFailureKeepsCallAndClearsOnNextStatus() async throws {
        let http = LiveVoiceHTTPFixture()
        let media = LiveMediaFixture()
        let stream = AsyncThrowingStream<LiveVoiceStatus, Error>.makeStream()
        let reported = expectation(description: "reply failure visible")
        let cleared = expectation(description: "next request clears reply failure")
        var state = LiveVoiceSession.State()
        var sawFailure = false
        let session = LiveVoiceSession(
            api: LiveVoiceAPI(pairing: pairing, session: http, statusStream: { _ in stream.stream }),
            media: media,
            permission: { true },
            publish: {
                state = $0
                if $0.replyFailure != nil {
                    sawFailure = true
                    reported.fulfill()
                } else if sawFailure { cleared.fulfill() }
            }
        )
        stream.continuation.yield(LiveVoiceStatus(status: "connected", failure: nil))
        await session.start(conversationID: nil, onReady: nil)
        let payload = Data(#"{"status":"connected","replyFailure":{"code":"project_spend_limit_exceeded","retryable":false}}"#.utf8)
        try stream.continuation.yield(JSONDecoder().decode(LiveVoiceStatus.self, from: payload))
        await fulfillment(of: [reported], timeout: 2)
        XCTAssertTrue(state.connected)
        XCTAssertFalse(media.closed)
        XCTAssertNil(state.error)
        XCTAssertEqual(state.replyFailure?.code, "project_spend_limit_exceeded")
        XCTAssertFalse(state.replyFailure?.fatal ?? true)
        XCTAssertFalse(state.replyFailure?.retryable ?? true)
        stream.continuation.yield(LiveVoiceStatus(status: "connected", failure: nil))
        await fulfillment(of: [cleared], timeout: 2)
        XCTAssertNil(state.replyFailure)
        XCTAssertTrue(state.connected)
        session.stop()
        stream.continuation.finish()
    }

    func testCreationFailureDoesNotEnableAudioOrDowngrade() async {
        let http = LiveVoiceHTTPFixture()
        await http.rejectCreation()
        let media = LiveMediaFixture()
        var failure: RealtimeCallFailure?
        let session = LiveVoiceSession(
            api: LiveVoiceAPI(pairing: pairing, session: http, statusStream: { _ in
                AsyncThrowingStream { continuation in
                    continuation.yield(LiveVoiceStatus(status: "connected", failure: nil))
                }
            }),
            media: media,
            permission: { true },
            publish: {
                failure = $0.error
            }
        )
        await session.start(conversationID: nil, onReady: nil)
        XCTAssertEqual(failure?.code, "project_spend_limit_exceeded")
        XCTAssertTrue(media.enabled.isEmpty)
        XCTAssertTrue(media.closed)
        let failedRequests = await http.requests
        XCTAssertEqual(failedRequests.count, 1)
    }

    func testPermissionDenialNeverCreatesProviderCall() async {
        let http = LiveVoiceHTTPFixture()
        let media = LiveMediaFixture()
        var failure: RealtimeCallFailure?
        let session = LiveVoiceSession(
            api: LiveVoiceAPI(pairing: pairing, session: http, statusStream: { _ in
                AsyncThrowingStream { continuation in
                    continuation.yield(LiveVoiceStatus(status: "connected", failure: nil))
                }
            }),
            media: media,
            permission: { false },
            publish: {
                failure = $0.error
            }
        )
        await session.start(conversationID: nil, onReady: nil)
        XCTAssertEqual(failure?.code, "microphone_permission")
        let deniedRequests = await http.requests
        XCTAssertTrue(deniedRequests.isEmpty)
        XCTAssertTrue(media.enabled.isEmpty)
    }

    func testMuteKeepsRemoteMediaAndOverlappingCaptionsIndependent() async {
        let http = LiveVoiceHTTPFixture()
        let media = LiveMediaFixture()
        var state = LiveVoiceSession.State()
        let session = LiveVoiceSession(
            api: LiveVoiceAPI(pairing: pairing, session: http, statusStream: { _ in
                AsyncThrowingStream { continuation in
                    continuation.yield(LiveVoiceStatus(status: "connected", failure: nil))
                }
            }),
            media: media,
            permission: { true },
            publish: { state = $0
            }
        )
        await session.start(conversationID: nil, onReady: nil)
        media.event(["type": "session.input_transcript.delta", "event_id": "u1", "start_ms": 100, "end_ms": 300, "delta": "Please arrange"])
        media.event(["type": "session.output_transcript.delta", "event_id": "a1", "start_ms": 200, "end_ms": 350, "delta": "Of course."])
        media.event(["type": "session.input_transcript.delta", "event_id": "u2", "start_ms": 300, "end_ms": 500, "delta": " the tables."])
        XCTAssertEqual(state.captions.fragments.map(\.text), ["Please arrange", "Of course.", " the tables."])
        session.mute(true)
        XCTAssertEqual(media.enabled, [true, false])
        XCTAssertFalse(media.closed)
        media.onLevels?(0, 0.4)
        XCTAssertEqual(state.outputLevel, 0.4)
        session.stop()
        let count = state.captions.fragments.count
        media.event(["type": "session.output_transcript.delta", "event_id": "stale", "start_ms": 600, "end_ms": 700, "delta": "Late"])
        XCTAssertEqual(state.captions.fragments.count, count)
    }

    func testCancelledConversationHandoffNeverStartsMicrophoneLate() async {
        let http = LiveVoiceHTTPFixture()
        let media = LiveMediaFixture()
        let reachedHandoff = expectation(description: "canonical handoff began")
        var resumeHandoff: CheckedContinuation<Void, Never>?
        let session = LiveVoiceSession(
            api: LiveVoiceAPI(pairing: pairing, session: http, statusStream: { _ in
                AsyncThrowingStream { continuation in
                    continuation.yield(LiveVoiceStatus(status: "connected", failure: nil))
                }
            }),
            media: media,
            permission: { true },
            publish: { _ in }
        )
        let task = Task {
            await session.start(conversationID: "same-chat") { _ in
                await withCheckedContinuation { continuation in
                    resumeHandoff = continuation
                    reachedHandoff.fulfill()
                }
            }
        }
        await fulfillment(of: [reachedHandoff], timeout: 2)
        session.stop()
        resumeHandoff?.resume()
        await task.value
        XCTAssertTrue(media.enabled.isEmpty)
        let requests = await http.requests
        XCTAssertFalse(requests.contains { $0.url!.path.hasSuffix("/ready") })
        XCTAssertTrue(media.closed)
    }

    func testCapabilityPrefersSupportedLiveButRetainsLegacyDiscovery() async throws {
        let http = LiveVoiceHTTPFixture()
        let legacy = #""available":true,"directAgentTools":true,"canonicalAgentEvents":true,"protocol":{"min":1,"max":2}"#
        await http.advertise("{" + legacy + "}")
        let old = try await RealtimeCapability.connectionKind(pairing: pairing, session: http)
        XCTAssertEqual(old, .realtime)
        await http
            .advertise("{" + legacy +
                #", "live":{"version":1,"transport":"webrtc","model":"gpt-live-1","configuredAgent":true,"future":true}}"#)
        let current = try await RealtimeCapability.connectionKind(pairing: pairing, session: http)
        XCTAssertEqual(current, .live)
        await http.advertise(
            #"{"live":{"version":1,"transport":"webrtc","model":"future-voice-model","configuredAgent":true}}"#
        )
        let compatibleModel = try await RealtimeCapability.connectionKind(pairing: pairing, session: http)
        XCTAssertEqual(compatibleModel, .live)
        await http.advertise(
            #"{"live":{"version":1,"protocol":{"min":1,"max":3},"transport":"webrtc","model":"next","configuredAgent":true}}"#
        )
        let overlap = try await RealtimeCapability.connectionKind(pairing: pairing, session: http)
        XCTAssertEqual(overlap, .live)
        await http.advertise("{" + legacy +
            #", "live":{"version":1,"protocol":{"min":2,"max":3},"transport":"webrtc","model":"next","configuredAgent":true}}"#)
        let unsupported = try await RealtimeCapability.connectionKind(pairing: pairing, session: http)
        XCTAssertEqual(unsupported, .realtime)
        await http.advertise(
            #"{"live":{"version":1,"protocol":{"min":1},"transport":"webrtc","model":"next","configuredAgent":true}}"#
        )
        let malformedRange = try await RealtimeCapability.connectionKind(pairing: pairing, session: http)
        XCTAssertNil(malformedRange)
        await http.advertise(#"{"live":{"version":1,"transport":"webrtc","model":" ","configuredAgent":true}}"#)
        let invalidModel = try await RealtimeCapability.connectionKind(pairing: pairing, session: http)
        XCTAssertNil(invalidModel)
        await http.advertise("{" + legacy + #", "live":{"version":2,"transport":"future"}}"#)
        let future = try await RealtimeCapability.connectionKind(pairing: pairing, session: http)
        XCTAssertEqual(future, .realtime)
        await http.advertise(#"{"available":false,"live":{"version":1,"transport":"webrtc","model":"gpt-live-1","configuredAgent":false}}"#)
        let disabled = try await RealtimeCapability.connectionKind(pairing: pairing, session: http)
        XCTAssertNil(disabled)
    }

    func testCaptionFragmentsPreserveWhitespaceOverlapAndDeduplicateOnlyEventIdentity() {
        var captions = LiveVoiceCaptions()
        let first: [String: Any] = [
            "type": "session.input_transcript.delta",
            "event_id": "one",
            "start_ms": 0,
            "end_ms": 100,
            "delta": "the",
        ]
        captions.receive(first)
        captions.receive(first)
        captions.receive([
            "type": "session.input_transcript.delta",
            "event_id": "two",
            "start_ms": 100,
            "end_ms": 200,
            "delta": " the table",
        ])
        captions.receive(["type": "session.output_transcript.delta", "event_id": "three", "start_ms": 50, "end_ms": 250, "delta": "Yes."])
        XCTAssertEqual(captions.fragments.count, 3)
        XCTAssertEqual(captions.displayRuns.map(\.text), ["the the table", "Yes."])
        XCTAssertEqual(captions.fragments.last?.startMilliseconds, 50)
        for index in 0 ..< 300 {
            captions.receive([
                "type": "session.input_transcript.delta",
                "event_id": "bounded-\(index)",
                "start_ms": index,
                "end_ms": index + 1,
                "delta": "text",
            ])
        }
        XCTAssertLessThanOrEqual(captions.fragments.count, 256)
    }

    func testAPIReportsConfiguredAgentIdentity() async throws {
        let http = LiveVoiceHTTPFixture()
        let call = try await LiveVoiceAPI(pairing: pairing, session: http, statusStream: { _ in
            AsyncThrowingStream { continuation in
                continuation.yield(LiveVoiceStatus(status: "connected", failure: nil))
            }
        }).create(
            sdp: "offer",
            conversationID: nil,
            clientSessionID: UUID().uuidString
        )
        XCTAssertEqual(call.model, "configured-model")
        XCTAssertEqual(call.backend, "configured-backend")
    }
}
