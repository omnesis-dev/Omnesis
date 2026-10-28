// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

#if DEBUG
import Foundation
@testable import OmnesisDemo
import SwiftUI
import UIKit
@preconcurrency import WebRTC
import XCTest

/// Realtime voice as the demo app, the only build that includes it, carries it.
@MainActor
final class LiveVoiceDemoTests: XCTestCase {
    private final class Session: URLSessionLike, @unchecked Sendable {
        var requests = 0

        func data(for request: URLRequest) async throws -> (Data, URLResponse) {
            requests += 1
            let body = #"{"live":{"version":1,"transport":"webrtc","model":"gpt-live-1","configuredAgent":true}}"#
            return (Data(body.utf8), HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!)
        }
    }

    func testDemoBuildOffersVoiceToAnExperimentalGatewayThatAdvertisesIt() async {
        let pairing = Pairing(
            url: URL(string: "https://gateway.example.com")!,
            token: "test-token",
            accountId: "test-account",
            deviceId: "test-device",
            gatewayName: "Example gateway"
        )
        let session = Session()
        XCTAssertTrue(RealtimeCapability.includedInBuild)
        let stable = await RealtimeCapability.offered(pairing: pairing, experimental: false, session: session)
        XCTAssertFalse(stable)
        XCTAssertEqual(session.requests, 0)
        let experimental = await RealtimeCapability.offered(pairing: pairing, experimental: true, session: session)
        XCTAssertTrue(experimental)
    }

    func testLiveVoiceActualPeerSignalingAndDataChannel() async throws {
        for name in ["WebRTC-LICENSE.md", "WebRTC-Build-LICENSE.txt", "WebRTC-Build-NOTICE.md"] {
            XCTAssertNotNil(Bundle.main.url(forResource: name, withExtension: nil), "Missing bundled dependency notice: \(name)")
        }
        let media = LiveWebRTCMedia()
        let remote = LiveWebRTCLoopback()
        defer { media.close()
            remote.close()
        }
        let receivedCaption = expectation(description: "actual RTC data-channel caption")
        var captions = LiveVoiceCaptions()
        var receivedStarted = false
        var failure: Error?
        media.onFailure = { failure = $0 }
        media.onEvent = { data in
            guard let event = RealtimeProtocol.event(data) else { return }
            if event["type"] as? String == "session.started" { receivedStarted = true }
            captions.receive(event)
            if !captions.fragments.isEmpty { receivedCaption.fulfill() }
        }
        let offer = try await media.offer()
        XCTAssertTrue(offer.contains("m=audio"))
        XCTAssertTrue(offer.contains("m=application"))
        let answer = try await remote.answer(offer: offer)
        try await media.connect(answer: answer)
        await fulfillment(of: [receivedCaption], timeout: 10)
        XCTAssertTrue(receivedStarted)
        XCTAssertNil(failure)
        XCTAssertFalse(RTCAudioSession.sharedInstance().isAudioEnabled)
        XCTAssertEqual(captions.fragments.map(\.text), ["The workshop notes are ready."])
        let session = PreviewMocks.realtimeListening
        session.isLive = true
        session.liveCaptions = captions.displayRuns
        try renderProof(session, name: "live-voice-actual-data-channel")
    }

    /// Draws through a hosting controller, as the snapshot catalogue does, so the
    /// UIKit-backed transcript renders instead of ImageRenderer's placeholder.
    private func renderProof(_ session: RealtimeCallSession, name: String) throws {
        let size = CGSize(width: 393, height: 852)
        let host = UIHostingController(rootView:
            RealtimeCallView(pairing: nil, session: session)
                .environment(AppStore.preview())
                .environment(\.appearanceStore, AppearanceStore(mode: .dark))
                .frame(width: size.width, height: size.height)
                .preferredColorScheme(.dark)
        )
        host.overrideUserInterfaceStyle = .dark
        host.safeAreaRegions = []
        host.view.frame = CGRect(origin: .zero, size: size)
        host.view.layoutIfNeeded()
        let image = UIGraphicsImageRenderer(size: size).image { _ in
            host.view.drawHierarchy(in: host.view.bounds, afterScreenUpdates: true)
        }
        let data = try XCTUnwrap(image.pngData())
        let directory = URL(fileURLWithPath: "/tmp/omnesis-snapshots", isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        try data.write(to: directory.appendingPathComponent("\(name).png"))
    }
}
#endif
