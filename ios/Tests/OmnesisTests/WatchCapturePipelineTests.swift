// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

@testable import Omnesis
import XCTest

private actor CaptureEvents {
    var events: [String] = []
    func add(_ event: String) {
        events.append(event)
    }
}

final class WatchCapturePipelineTests: XCTestCase {
    private var directory: URL!
    private var inbox: WatchVoiceInbox!

    override func setUpWithError() throws {
        directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        inbox = WatchVoiceInbox(directory: directory.appendingPathComponent("inbox"))
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: directory)
    }

    private func receive(_ route: WatchCaptureRoute, ref: String = UUID().uuidString) throws -> WatchVoiceInbox.Item {
        let file = directory.appendingPathComponent(UUID().uuidString + ".m4a")
        try Data([1, 2, 3]).write(to: file)
        let metadata = WatchVoiceRecording(ref: ref, captureTime: .now(), locale: "en_GB", route: route).metadata
        XCTAssertEqual(metadata["voiceKind"], "capture")
        return try XCTUnwrap(inbox.admit(file: file, metadata: metadata))
    }

    private func dependencies(
        _ events: CaptureEvents,
        gateway: Bool,
        route: WatchCaptureRoute = .note,
        localText: String? = "The bicycle is at the workshop",
        saved: Bool = true
    )
        -> WatchCapturePipeline
        .Dependencies {
        .init(
            gatewayDictation: { gateway },
            transcribeGateway: { _, _ in await events.add("gateway")
                return "Where is the bicycle?"
            },
            transcribeLocal: { _, _ in await events.add("local")
                return localText
            },
            classify: { _ in await events.add("classify")
                return route
            },
            saveNote: { text, _, audio in await events.add(audio == nil ? "note:\(text)" : "audio-note")
                return saved
            },
            ask: { _ in await events.add("ask") },
            notify: { _ in await events.add("notice") }
        )
    }

    func testAutomaticCaptureReportsTheResolvedRouteBeforeAsking() async throws {
        let events = CaptureEvents()
        var deps = dependencies(events, gateway: true, route: .ask)
        deps.resolved = { route in await events.add("resolved:\(route.rawValue)") }
        try await WatchCapturePipeline().handle(receive(.automatic), inbox: inbox, deps: deps)
        let actual = await events.events
        XCTAssertEqual(actual, ["gateway", "classify", "resolved:ask", "ask"])
    }

    func testExplicitAskUsesGatewayTranscriptionWithoutDecisionOrLocalTranscription() async throws {
        let events = CaptureEvents()
        let item = try receive(.ask)
        await WatchCapturePipeline().handle(item, inbox: inbox, deps: dependencies(events, gateway: true))
        let actual = await events.events
        XCTAssertEqual(actual, ["gateway", "ask"])
        XCTAssertTrue(inbox.claimLeftovers().isEmpty)
    }

    func testTellHandsAudioToDurableNoteQueueWithoutWaitingForAnyTranscript() async throws {
        let events = CaptureEvents()
        try await WatchCapturePipeline().handle(receive(.note), inbox: inbox, deps: dependencies(events, gateway: true))
        let actual = await events.events
        XCTAssertEqual(actual, ["audio-note"])
    }

    func testAutomaticUsesLocalTranscriptAndDecisionWhenGatewayTranscriptionIsOff() async throws {
        let events = CaptureEvents()
        try await WatchCapturePipeline().handle(receive(.automatic), inbox: inbox, deps: dependencies(events, gateway: false))
        let actual = await events.events
        XCTAssertEqual(actual, ["local", "classify", "note:The bicycle is at the workshop"])
    }

    func testUnavailableLocalRecognitionRetainsAudioAndNotifiesOnlyOnceAcrossRetries() async throws {
        let events = CaptureEvents()
        let pipeline = WatchCapturePipeline()
        let item = try receive(.ask)
        let deps = dependencies(events, gateway: false, localText: nil)
        await pipeline.handle(item, inbox: inbox, deps: deps)
        XCTAssertTrue(FileManager.default.fileExists(atPath: inbox.audioURL(item.id).path))
        let retry = try XCTUnwrap(inbox.claimLeftovers().first)
        await pipeline.handle(retry, inbox: inbox, deps: deps)
        let actual = await events.events
        XCTAssertEqual(actual, ["local", "notice", "local"])
    }

    func testFailedNoteSaveKeepsTranscriptForRetryAndDoesNotClassifyTwice() async throws {
        let events = CaptureEvents()
        let pipeline = WatchCapturePipeline()
        try await pipeline.handle(
            receive(.automatic),
            inbox: inbox,
            deps: dependencies(events, gateway: false, saved: false)
        )
        let retry = try XCTUnwrap(inbox.claimLeftovers().first)
        await pipeline.handle(retry, inbox: inbox, deps: dependencies(events, gateway: false))
        let actual = await events.events
        XCTAssertEqual(actual.filter { $0 == "classify" }.count, 1)
        XCTAssertEqual(actual.filter { $0 == "local" }.count, 1)
        XCTAssertTrue(inbox.claimLeftovers().isEmpty)
    }

    func testDuplicateTransferPreservesAmbiguousAskMarkerAcrossRestart() async throws {
        let ref = UUID().uuidString
        var first = try receive(.ask, ref: ref)
        first.state.askStarted = true
        try inbox.save(first)
        inbox.release(first)
        let duplicate = try receive(.ask, ref: ref)
        XCTAssertEqual(duplicate.id, first.id)
        XCTAssertEqual(duplicate.state.askStarted, true)
        let events = CaptureEvents()
        await WatchCapturePipeline().handle(duplicate, inbox: inbox, deps: dependencies(events, gateway: true))
        let actual = await events.events
        XCTAssertEqual(actual, ["notice"])
    }

    func testCompletedCaptureCannotBeSubmittedAgain() async throws {
        let ref = UUID().uuidString
        let events = CaptureEvents()
        try await WatchCapturePipeline().handle(receive(.ask, ref: ref), inbox: inbox, deps: dependencies(events, gateway: true))
        try await WatchCapturePipeline().handle(receive(.ask, ref: ref), inbox: inbox, deps: dependencies(events, gateway: true))
        let actual = await events.events
        XCTAssertEqual(actual, ["gateway", "ask"])
    }

    func testCompletedExpiredDuplicateDoesNotReportAFalseFailure() async throws {
        let ref = UUID().uuidString
        var item = try receive(.ask, ref: ref)
        let oldTime = NoteCaptureTime(
            capturedAt: Date().addingTimeInterval(-2 * WatchOutboxPolicy.retention),
            timeZoneId: "UTC",
            utcOffsetSeconds: 0
        )
        item.state.metadata = WatchVoiceRecording(ref: ref, captureTime: oldTime, locale: "en_GB", route: .ask).metadata
        try inbox.save(item)
        try inbox.complete(ref)
        let events = CaptureEvents()
        await WatchCapturePipeline().handle(item, inbox: inbox, deps: dependencies(events, gateway: true))
        let actual = await events.events
        XCTAssertTrue(actual.isEmpty)
        XCTAssertTrue(inbox.claimLeftovers().isEmpty)
    }

    func testCapabilityRoundTripAndLegacyFallback() {
        let gate = WatchDictationGate(
            active: false,
            maxAudioBytes: 0,
            updatedAt: Date(timeIntervalSince1970: 1_800_000_000),
            decisionGate: true,
            captureSupported: true
        )
        XCTAssertEqual(WatchDictationGate(applicationContext: gate.applicationContext), gate)
        let old = WatchDictationGate(active: true, maxAudioBytes: 10000, updatedAt: Date())
        XCTAssertFalse(old.decisionGate)
        XCTAssertFalse(old.captureSupported)
    }
}
