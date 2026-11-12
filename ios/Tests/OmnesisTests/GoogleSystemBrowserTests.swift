// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation
@testable import Omnesis
import XCTest
#if canImport(AuthenticationServices)
import AuthenticationServices
#if canImport(AppKit)
import AppKit
#endif

@MainActor
final class GoogleSystemBrowserTests: XCTestCase {
    private func authorization() throws -> GoogleNativeAuthorization {
        try GoogleNativeAuthorization(clientId: "fictional-ios.apps.googleusercontent.com", nonce: "fixture-browser-challenge")
    }

    private func anchor() -> ASPresentationAnchor {
        #if canImport(AppKit)
        _ = NSApplication.shared
        #endif
        return ASPresentationAnchor()
    }

    private func waitForSessions(_ count: Int, _ factory: BrowserSessionFactory) async throws {
        for _ in 0 ..< 1000 {
            if factory.sessions.count >= count { return }
            await Task.yield()
        }
        XCTFail("The browser session was not started")
        throw CloudPairingError.response
    }

    private func assertError(_ task: Task<URL, Error>, _ expected: CloudPairingError) async {
        do { _ = try await task.value
            XCTFail("Sign-in unexpectedly succeeded")
        } catch { XCTAssertEqual(error as? CloudPairingError, expected) }
    }

    func testDefaultCompositionCreatesTheActualEphemeralSystemSessionWithoutOpeningAWindowOrNetwork() throws {
        let browser = try XCTUnwrap(GoogleCloudPairingCoordinator.systemBrowser() as? GoogleSystemBrowser)
        _ = browser.anchorProvider()
        let session = try browser.sessionFactory(authorization(), { _, _ in }, browser)
        let actual = try XCTUnwrap(session as? ASWebAuthenticationSession)
        XCTAssertTrue(actual.prefersEphemeralWebBrowserSession)
        XCTAssertTrue(actual.presentationContextProvider === browser)
        XCTAssertNotNil(browser.presentationAnchor(for: actual))
        browser.cancel()
    }

    func testMissingAnchorAndPreCancelledTasksNeverCreateASession() async throws {
        let factory = BrowserSessionFactory()
        let browser = GoogleSystemBrowser(anchorProvider: { nil }, sessionFactory: factory.make)
        let auth = try authorization()
        let missing = Task { try await browser.signIn(auth) }
        await assertError(missing, .configuration)
        let cancelled = Task { try await browser.signIn(auth) }
        cancelled.cancel()
        await assertError(cancelled, .cancelled)
        XCTAssertTrue(factory.sessions.isEmpty)
    }

    func testCancellationWhilePreparingTheAnchorDoesNotStartTheSession() async throws {
        let factory = BrowserSessionFactory(), window = anchor(), holder = BrowserTaskHolder()
        let browser = GoogleSystemBrowser(anchorProvider: {
            holder.task?.cancel()
            return window
        }, sessionFactory: factory.make)
        let auth = try authorization()
        holder.task = Task { try await browser.signIn(auth) }
        try await assertError(XCTUnwrap(holder.task), .cancelled)
        XCTAssertTrue(factory.sessions.isEmpty)
        browser.cancel()
    }

    func testStartFalseAndLateCallbacksResumeExactlyOnceAndReleaseTheSession() async throws {
        let factory = BrowserSessionFactory(), window = anchor()
        factory.starts = false
        let browser = GoogleSystemBrowser(anchorProvider: { window }, sessionFactory: factory.make)
        let auth = try authorization(), task = Task { try await browser.signIn(auth) }
        await assertError(task, .configuration)
        XCTAssertEqual(factory.sessions.first?.cancelCount, 1)
        factory.callbacks.first?(URL(string: auth.redirectURI), nil)
        await Task.yield()
        browser.cancel()
        XCTAssertEqual(factory.sessions.first?.cancelCount, 1)
    }

    func testCallbackURLAndSystemErrorsAreSeparateFromVerifiedOAuthExchange() async throws {
        let factory = BrowserSessionFactory(), window = anchor()
        let browser = GoogleSystemBrowser(anchorProvider: { window }, sessionFactory: factory.make)
        defer { browser.cancel() }
        let auth = try authorization(), callback = try XCTUnwrap(URL(string: "\(auth.redirectURI)?code=fixture&state=\(auth.state)"))
        let success = Task { try await browser.signIn(auth) }
        try await waitForSessions(1, factory)
        let actual = GoogleSystemBrowser.systemSession(authorization: auth, completion: { _, _ in }, presentationProvider: browser)
        XCTAssertTrue(try browser.presentationAnchor(for: XCTUnwrap(actual as? ASWebAuthenticationSession)) === window)
        factory.callbacks[0](callback, nil)
        let result = try await success.value
        XCTAssertEqual(result, callback)
        XCTAssertEqual(factory.sessions[0].cancelCount, 0)
        for (url, error) in [
            (nil, NSError(domain: "FictionalSystemBrowser", code: 1)),
            (nil, nil),
            (callback, NSError(domain: "FictionalSystemBrowser", code: 2)),
        ] as [(URL?, Error?)] {
            let task = Task { try await browser.signIn(auth) }
            let count = factory.sessions.count + 1
            try await waitForSessions(count, factory)
            factory.callbacks[count - 1](url, error)
            await assertError(task, .cancelled)
        }
    }

    func testManualAndTaskCancellationFinishWithoutDependingOnASystemCallback() async throws {
        for cancelTask in [false, true] {
            let factory = BrowserSessionFactory(), window = anchor()
            let browser = GoogleSystemBrowser(anchorProvider: { window }, sessionFactory: factory.make)
            let auth = try authorization(), task = Task { try await browser.signIn(auth) }
            try await waitForSessions(1, factory)
            if cancelTask { task.cancel() } else { browser.cancel() }
            await assertError(task, .cancelled)
            XCTAssertEqual(factory.sessions[0].cancelCount, 1)
            factory.callbacks[0](URL(string: auth.redirectURI), nil)
            await Task.yield()
        }
    }

    func testSupersededAndReentrantCallbacksCannotFinishANewerSignIn() async throws {
        let factory = BrowserSessionFactory(), window = anchor()
        factory.completeOnCancel = true
        let browser = GoogleSystemBrowser(anchorProvider: { window }, sessionFactory: factory.make)
        defer { browser.cancel() }
        let auth = try authorization(), first = Task { try await browser.signIn(auth) }
        try await waitForSessions(1, factory)
        let second = Task { try await browser.signIn(auth) }
        try await waitForSessions(2, factory)
        await assertError(first, .cancelled)
        first.cancel()
        factory.callbacks[0](URL(string: "\(auth.redirectURI)?code=stale"), nil)
        await Task.yield()
        XCTAssertEqual(factory.sessions[1].cancelCount, 0)
        let callback = try XCTUnwrap(URL(string: "\(auth.redirectURI)?code=current"))
        factory.callbacks[1](callback, nil)
        let result = try await second.value
        XCTAssertEqual(result, callback)
    }

    func testCallbackAfterBrowserReleaseHasNoContinuationToResume() async throws {
        let factory = BrowserSessionFactory(), window = anchor()
        var browser: GoogleSystemBrowser? = GoogleSystemBrowser(anchorProvider: { window }, sessionFactory: factory.make)
        weak var weakBrowser = browser
        let auth = try authorization()
        let task = Task { try await browser!.signIn(auth) }
        try await waitForSessions(1, factory)
        let callback = try XCTUnwrap(URL(string: auth.redirectURI))
        factory.callbacks[0](callback, nil)
        _ = try await task.value
        browser = nil
        await Task.yield()
        XCTAssertNil(weakBrowser)
        factory.callbacks[0](callback, nil)
        await Task.yield()
    }
}

@MainActor
private final class BrowserTaskHolder {
    var task: Task<URL, Error>?
}

@MainActor
private final class BrowserSessionFactory {
    var starts = true
    var completeOnCancel = false
    var sessions: [BrowserAuthenticationSession] = []
    var callbacks: [GoogleSystemBrowser.Completion] = []

    func make(
        authorization _: GoogleNativeAuthorization,
        completion: @escaping GoogleSystemBrowser.Completion,
        presentationProvider _: any ASWebAuthenticationPresentationContextProviding
    )
        -> any GoogleBrowserAuthenticationSession {
        let session = BrowserAuthenticationSession(starts: starts)
        if completeOnCancel { session.onCancel = { completion(nil, CloudPairingError.cancelled) } }
        sessions.append(session)
        callbacks.append(completion)
        return session
    }
}

@MainActor
private final class BrowserAuthenticationSession: GoogleBrowserAuthenticationSession {
    let starts: Bool
    var cancelCount = 0
    var onCancel: (() -> Void)?
    init(starts: Bool) {
        self.starts = starts
    }

    func start() -> Bool {
        starts
    }

    func cancel() {
        cancelCount += 1
        onCancel?()
    }
}
#endif
