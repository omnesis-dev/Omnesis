// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

@testable import DesktopCore
import Foundation
import XCTest

final class NearbyGatewayBrowserTests: XCTestCase {
    private static let observationLock = NSLock()
    private static var retainedObservationResources: [(DesktopOwnedUIObservation, DesktopNearbyGatewayBrowser, Driver)] = []
    private final class Clock: @unchecked Sendable {
        private let lock = NSLock()
        private var value = ContinuousClock.now
        private var nextRead: (() -> Void)?
        func onNextRead(_ action: @escaping () -> Void) {
            lock.withLock { nextRead = action }
        }

        func now() -> ContinuousClock.Instant {
            let (instant, action) = lock.withLock {
                let action = nextRead
                nextRead = nil
                return (value, action)
            }
            action?()
            return instant
        }

        func advance(_ duration: Duration) {
            lock.withLock { value = value.advanced(by: duration) }
        }
    }

    private final class Driver: NearbyGatewayDNSDriver, @unchecked Sendable {
        final class Slot: NearbyGatewayDNSReference, @unchecked Sendable {
            private let lock = NSLock()
            let kind: String
            let service: NearbyGatewayDNSService?
            let host: String?
            let queue: DispatchQueue
            let receive: (NearbyGatewayDNSEvent) -> Void
            private var cancelCount = 0
            private var contextReleased = false
            var cancelled: Int {
                lock.withLock { cancelCount }
            }

            var released: Bool {
                lock.withLock { contextReleased }
            }

            init(
                _ kind: String,
                service: NearbyGatewayDNSService? = nil,
                host: String? = nil,
                queue: DispatchQueue,
                receive: @escaping (NearbyGatewayDNSEvent) -> Void
            ) {
                self.kind = kind
                self.service = service
                self.host = host
                self.queue = queue
                self.receive = receive
            }

            func cancel() {
                dispatchPrecondition(condition: .onQueue(queue))
                let first = lock.withLock { () -> Bool in
                    if cancelCount != 0 { return false }
                    cancelCount = 1
                    return true
                }
                if first { queue.async { self.lock.withLock { self.contextReleased = true } } }
            }

            /// Deliberately allows already queued stale callbacks after cancellation.
            func emit(_ event: NearbyGatewayDNSEvent) async {
                await withCheckedContinuation { continuation in queue.async { self.receive(event)
                    continuation.resume()
                } }
            }
        }

        private let lock = NSLock()
        private var slots: [Slot] = []
        var blockBrowse: (() -> Void)?
        var denyBrowse = false
        func all(_ kind: String) -> [Slot] {
            lock.withLock { slots.filter { $0.kind == kind } }
        }

        private func create(
            _ kind: String,
            service: NearbyGatewayDNSService? = nil,
            host: String? = nil,
            queue: DispatchQueue,
            receive: @escaping (NearbyGatewayDNSEvent) -> Void
        )
            -> Slot {
            let slot = Slot(kind, service: service, host: host, queue: queue, receive: receive)
            lock.withLock { slots.append(slot) }
            return slot
        }

        func browse(on queue: DispatchQueue, receive: @escaping (NearbyGatewayDNSEvent) -> Void) throws -> NearbyGatewayDNSReference {
            blockBrowse?()
            if denyBrowse { throw NearbyGatewayDNSFailure(denied: true) }
            return create("browse", queue: queue, receive: receive)
        }

        func resolve(
            _ service: NearbyGatewayDNSService,
            on queue: DispatchQueue,
            receive: @escaping (NearbyGatewayDNSEvent) -> Void
        ) throws
            -> NearbyGatewayDNSReference {
            create("resolve", service: service, queue: queue, receive: receive)
        }

        func addresses(
            _ host: String,
            port: Int,
            interface: UInt32,
            on queue: DispatchQueue,
            receive: @escaping (NearbyGatewayDNSEvent) -> Void
        ) throws
            -> NearbyGatewayDNSReference {
            create("addresses", host: host, queue: queue, receive: receive)
        }
    }

    private func ownedBrowser(
        driver: Driver,
        now: @escaping @Sendable () -> ContinuousClock.Instant = { .now },
        closeNow: @escaping @Sendable () -> ContinuousClock.Instant = { .now },
        observation: DesktopOwnedUIObservation? = nil
    )
        -> DesktopNearbyGatewayBrowser {
        let browser = DesktopNearbyGatewayBrowser(driver: driver, now: now, closeNow: closeNow)
        addTeardownBlock {
            if let observation {
                let joined = await observation.close()
                if !joined {
                    Self.observationLock.withLock { Self.retainedObservationResources.append((observation, browser, driver)) }
                    XCTFail("Diagnostic cleanup is unconfirmed; the observation and exact fixture resources are retained")
                    return
                }
            }
            let result = await browser.beginClose().join(until: closeNow().advanced(by: .seconds(1)))
            XCTAssertEqual(result, .confirmed)
        }
        return browser
    }

    private func finish(_ browser: DesktopNearbyGatewayBrowser, driver: Driver) async {
        let handle = browser.beginClose()
        XCTAssertTrue(handle === browser.beginClose())
        let result = await handle.join(until: .now.advanced(by: .seconds(1)))
        XCTAssertEqual(result, .confirmed)
        XCTAssertTrue(handle.isConfirmed)
        for kind in ["browse", "resolve", "addresses"] {
            for slot in driver.all(kind) {
                XCTAssertEqual(slot.cancelled, 1)
                XCTAssertTrue(slot.released)
            }
        }
    }

    private func add(
        _ browser: DesktopNearbyGatewayBrowser,
        driver: Driver,
        name: String,
        address: String,
        ttl: UInt32 = 30
    ) async throws
        -> Driver.Slot {
        let browse = try XCTUnwrap(driver.all("browse").last)
        await browse.emit(.service(.init(name: name, interface: 1), added: true))
        let resolver = try XCTUnwrap(driver.all("resolve").last)
        await resolver.emit(.resolved(host: "gateway.local.", port: 443, compatible: true))
        let addresses = try XCTUnwrap(driver.all("addresses").last)
        await addresses.emit(.address(address, port: 443, ttl: ttl, added: true, more: false))
        return addresses
    }

    func testSnapshotIsCachedTTLDoesNotRenewAndRemovalPreservesOtherEndpointOwner() async throws {
        let driver = Driver()
        let clock = Clock()
        let browser = ownedBrowser(driver: driver, now: { clock.now() })
        XCTAssertEqual(browser.snapshot().state, .unavailable)
        XCTAssertTrue(driver.all("browse").isEmpty)
        browser.start()
        browser.start()
        await browser.synchronized()
        XCTAssertEqual(driver.all("browse").count, 1)
        XCTAssertEqual(browser.snapshot().state, .finding)
        _ = try await add(browser, driver: driver, name: "One", address: "10.23.4.5", ttl: 60)
        _ = try await add(browser, driver: driver, name: "Two", address: "10.23.4.5")
        XCTAssertEqual(browser.snapshot().candidates.count, 1)
        let browse = try XCTUnwrap(driver.all("browse").first)
        await browse.emit(.service(.init(name: "One", interface: 1), added: false))
        XCTAssertEqual(browser.snapshot().candidates.count, 1)
        clock.advance(.seconds(10))
        XCTAssertEqual(browser.snapshot().candidates.first?.remainingMs, 20000)
        clock.advance(.seconds(20))
        XCTAssertTrue(browser.snapshot().candidates.isEmpty)
        XCTAssertEqual(browser.snapshot().state, .finding)
        await finish(browser, driver: driver)
    }

    func testForeignHostAndIncompatibleTXTNeverStartAddressResolution() async throws {
        let driver = Driver()
        let browser = ownedBrowser(driver: driver)
        browser.start()
        await browser.synchronized()
        let browse = try XCTUnwrap(driver.all("browse").first)
        for (index, host, compatible) in [(1, "gateway.example.test.", true), (2, "gateway.local.", false)] {
            await browse.emit(.service(.init(name: "Other\(index)", interface: 1), added: true))
            let resolver = try XCTUnwrap(driver.all("resolve").last)
            await resolver.emit(.resolved(host: host, port: 443, compatible: compatible))
        }
        XCTAssertTrue(driver.all("addresses").isEmpty)
        XCTAssertTrue(browser.snapshot().candidates.isEmpty)
        await finish(browser, driver: driver)
    }

    func testCapsResolversAndServicesAndRotatesBoundedCandidates() async throws {
        let driver = Driver()
        let clock = Clock()
        let browser = ownedBrowser(driver: driver, now: { clock.now() })
        browser.start()
        await browser.synchronized()
        let browse = try XCTUnwrap(driver.all("browse").first)
        for index in 0 ..< 24 {
            await browse.emit(.service(.init(name: "Queued\(index)", interface: 1), added: true))
        }
        XCTAssertEqual(driver.all("resolve").count, 2)
        // Initial completions admit the remaining bounded service set fairly.
        var pair: [Driver.Slot] = []
        for index in 0 ..< 16 {
            let resolver = try XCTUnwrap(driver.all("resolve").dropFirst(index).first)
            await resolver.emit(.resolved(host: "gateway.local.", port: 443, compatible: true))
            let addresses = try XCTUnwrap(driver.all("addresses").last)
            await addresses.emit(.address("10.23.4.\(index + 1)", port: 443, ttl: 30, added: true, more: false))
            pair.append(addresses)
            if index % 2 == 1 {
                clock.advance(.seconds(3))
                for current in pair {
                    await current.emit(.address("", port: 0, ttl: 0, added: false, more: false))
                }
                pair = []
            }
        }
        XCTAssertEqual(driver.all("resolve").count, 16)
        XCTAssertTrue(driver.all("addresses").allSatisfy { $0.cancelled == 1 })
        var interactive = Set<String>()
        var collector = Set<String>()
        for _ in 0 ..< 16 {
            let first = browser.snapshot()
            let second = browser.snapshot()
            XCTAssertEqual(first.candidates.count, 8)
            XCTAssertEqual(second.candidates.count, 8)
            interactive.formUnion(first.candidates.map(\.address))
            collector.formUnion(second.candidates.map(\.address))
            XCTAssertGreaterThan(second.sequence, first.sequence)
        }
        XCTAssertEqual(interactive.count, 16)
        XCTAssertEqual(collector.count, 16)
        await finish(browser, driver: driver)
    }

    func testAllFamiliesRemainEligibleThroughoutTheOriginalResolutionWindow() async throws {
        let driver = Driver()
        let clock = Clock()
        let browser = ownedBrowser(driver: driver, now: { clock.now() })
        browser.start()
        await browser.synchronized()
        let browse = try XCTUnwrap(driver.all("browse").first)
        await browse.emit(.service(.init(name: "Batch", interface: 1), added: true))
        let resolver = try XCTUnwrap(driver.all("resolve").last)
        await resolver.emit(.resolved(host: "GATEWAY.LOCAL.", port: 443, compatible: true))
        let addresses = try XCTUnwrap(driver.all("addresses").last)
        XCTAssertEqual(addresses.host, "gateway.local.")
        await addresses.emit(.address("fd12::4", port: 443, ttl: 30, added: true, more: true))
        await addresses.emit(.address("fd12::5", port: 443, ttl: 30, added: true, more: true))
        await addresses.emit(.address("fd12::4", port: 443, ttl: 0, added: false, more: false))
        XCTAssertEqual(browser.snapshot().candidates.map(\.address), ["fd12::5"])
        XCTAssertEqual(addresses.cancelled, 0)
        await addresses.emit(.address("10.23.4.6", port: 443, ttl: 30, added: true, more: false))
        await addresses.emit(.address("fd12::6", port: 443, ttl: 30, added: true, more: false))
        XCTAssertEqual(Set(browser.snapshot().candidates.map(\.address)), ["fd12::5", "10.23.4.6", "fd12::6"])
        clock.advance(.seconds(3))
        await addresses.emit(.address("fd12::7", port: 443, ttl: 30, added: true, more: false))
        XCTAssertEqual(addresses.cancelled, 1)
        XCTAssertFalse(browser.snapshot().candidates.contains { $0.address == "fd12::7" })
        await finish(browser, driver: driver)
    }

    func testNonPrivateFirstFamilyCannotHidePrivateSecondFamilyAndDeadlineKeepsValidAnswers() async throws {
        let driver = Driver()
        let clock = Clock()
        let browser = ownedBrowser(driver: driver, now: { clock.now() })
        browser.start()
        await browser.synchronized()
        let browse = try XCTUnwrap(driver.all("browse").first)
        await browse.emit(.service(.init(name: "Families", interface: 1), added: true))
        let resolver = try XCTUnwrap(driver.all("resolve").last)
        await resolver.emit(.resolved(host: "gateway.local.", port: 443, compatible: true))
        let addresses = try XCTUnwrap(driver.all("addresses").last)
        await addresses.emit(.address("fe80::4", port: 443, ttl: 30, added: true, more: false))
        XCTAssertEqual(addresses.cancelled, 0)
        XCTAssertTrue(browser.snapshot().candidates.isEmpty)
        await addresses.emit(.address("fd12::4", port: 443, ttl: 30, added: true, more: true))
        clock.advance(.seconds(3))
        await addresses.emit(.address("fd12::5", port: 443, ttl: 30, added: true, more: false))
        XCTAssertEqual(addresses.cancelled, 1)
        XCTAssertEqual(browser.snapshot().candidates.map(\.address), ["fd12::4"])
        XCTAssertEqual(browser.snapshot().candidates.first?.remainingMs, 27000)
        await finish(browser, driver: driver)
    }

    func testLateResolverCannotBeatItsDeadlineOrPublishTwice() async throws {
        let driver = Driver()
        let clock = Clock()
        let browser = ownedBrowser(driver: driver, now: { clock.now() })
        browser.start()
        await browser.synchronized()
        let browse = try XCTUnwrap(driver.all("browse").first)
        await browse.emit(.service(.init(name: "Late", interface: 1), added: true))
        let late = try XCTUnwrap(driver.all("resolve").last)
        clock.advance(.seconds(3))
        await late.emit(.resolved(host: "gateway.local.", port: 443, compatible: true))
        XCTAssertTrue(driver.all("addresses").isEmpty)
        let addresses = try await add(browser, driver: driver, name: "Current", address: "fd12::4")
        let current = try XCTUnwrap(driver.all("resolve").last)
        await current.emit(.resolved(host: "gateway.local.", port: 443, compatible: true))
        XCTAssertEqual(driver.all("addresses").count, 1)
        await current.emit(.failed(denied: true))
        XCTAssertEqual(browser.snapshot().state, .ready)
        await addresses.emit(.address("127.0.0.1", port: 443, ttl: 30, added: true, more: false))
        XCTAssertEqual(browser.snapshot().candidates.map(\.address), ["fd12::4"])
        await finish(browser, driver: driver)
    }

    func testDenialIsObservedNotEmptyAndRetryCannotReviveOldGeneration() async throws {
        let driver = Driver()
        let clock = Clock()
        let browser = ownedBrowser(driver: driver, now: { clock.now() })
        browser.start()
        await browser.synchronized()
        let old = try XCTUnwrap(driver.all("browse").first)
        XCTAssertEqual(browser.snapshot().state, .finding)
        await old.emit(.failed(denied: true))
        let denied = browser.snapshot()
        XCTAssertEqual(denied.state, .denied)
        XCTAssertTrue(denied.candidates.isEmpty)
        browser.requestRetry()
        await browser.synchronized()
        XCTAssertEqual(driver.all("browse").count, 1)
        clock.advance(.seconds(30))
        browser.requestRetry()
        await browser.synchronized()
        XCTAssertEqual(driver.all("browse").count, 2)
        XCTAssertNotEqual(browser.snapshot().generation, denied.generation)
        await old.emit(.service(.init(name: "Stale", interface: 1), added: true))
        await old.emit(.failed(denied: true))
        XCTAssertEqual(browser.snapshot().state, .finding)
        XCTAssertTrue(driver.all("resolve").isEmpty)
        await finish(browser, driver: driver)
    }

    func testImmediatePolicyDeniedSetupAndCloseBeforeStart() async {
        let denied = Driver()
        denied.denyBrowse = true
        let browser = ownedBrowser(driver: denied)
        browser.start()
        await browser.synchronized()
        XCTAssertEqual(browser.snapshot().state, .denied)
        await finish(browser, driver: denied)
        let untouched = Driver()
        let closed = ownedBrowser(driver: untouched)
        await finish(closed, driver: untouched)
        closed.start()
        closed.requestRetry()
        await closed.synchronized()
        XCTAssertTrue(untouched.all("browse").isEmpty)
    }

    func testPhysicalCompletionAfterAbsoluteDeadlineCannotBecomeConfirmedWhenTimerDeliveryIsDelayed() async {
        let entered = expectation(description: "setup entered")
        let registered = expectation(description: "join acquired its deadline")
        let release = DispatchSemaphore(value: 0)
        defer { release.signal() }
        let clock = Clock()
        let driver = Driver()
        driver.blockBrowse = { entered.fulfill()
            if release.wait(timeout: .now() + 5) == .timedOut {
                XCTFail("The test must explicitly release its blocked DNS setup before fixture cleanup")
            }
        }
        let browser = ownedBrowser(driver: driver, now: { clock.now() }, closeNow: { clock.now() })
        browser.start()
        await fulfillment(of: [entered], timeout: 1)
        let handle = browser.beginClose()
        let deadline = clock.now().advanced(by: .seconds(1))
        clock.onNextRead { registered.fulfill() }
        let pending = Task { await handle.join(until: deadline) }
        await fulfillment(of: [registered], timeout: 1)
        clock.advance(.seconds(2))
        release.signal()
        let joined = await pending.value
        XCTAssertEqual(joined, .blocked)
        let staleDeadline = await handle.join(until: deadline)
        XCTAssertEqual(staleDeadline, .blocked)
        let freshDeadline = await handle.join(until: clock.now().advanced(by: .seconds(1)))
        XCTAssertEqual(freshDeadline, .confirmed)
        XCTAssertTrue(handle.isConfirmed)
        let exactDeadline = await handle.join(until: clock.now())
        XCTAssertEqual(exactDeadline, .blocked)
    }

    func testBlockedCSetupCannotBlockSnapshotLogicalCloseOrCancellableJoin() async throws {
        let entered = expectation(description: "owned setup entered")
        let release = DispatchSemaphore(value: 0)
        defer { release.signal() }
        let observation = DesktopOwnedUIObservation(.blockedDNS)
        let driver = Driver()
        driver.blockBrowse = {
            observation.record(.dnsFixture, .entered)
            entered.fulfill()
            if release.wait(timeout: .now() + 5) == .timedOut {
                observation.record(.automaticRelease, .entered)
                XCTFail("The test must explicitly release its blocked DNS setup before fixture cleanup")
            }
            observation.record(.dnsFixture, .returned)
        }
        let browser = ownedBrowser(driver: driver, observation: observation)
        let token = observation.begin(.blockedDNS)
        browser.start()
        observation.record(.fulfillment, .entered)
        await fulfillment(of: [entered], timeout: 1)
        observation.record(.fulfillment, .returned)
        observation.record(.snapshot, .entered)
        let before = browser.snapshot()
        observation.record(.snapshot, .returned)
        observation.record(.logicalClose, .entered)
        let handle = browser.beginClose()
        XCTAssertTrue(handle === browser.beginClose())
        observation.record(.logicalClose, .returned)
        observation.record(.snapshot, .entered)
        XCTAssertEqual(browser.snapshot().state, .unavailable)
        XCTAssertNotEqual(browser.snapshot().generation, before.generation)
        observation.record(.snapshot, .returned)
        observation.record(.futureJoin, .entered)
        let blocked = await handle.join(until: .now.advanced(by: .milliseconds(10)))
        observation.record(.futureJoin, .returned)
        XCTAssertEqual(blocked, .blocked)
        XCTAssertFalse(handle.isConfirmed)
        observation.record(.cancellation, .entered)
        let cancelled = Task { await handle.join(until: .now.advanced(by: .seconds(1))) }
        cancelled.cancel()
        let cancelledResult = await cancelled.value
        observation.record(.cancellation, .returned)
        XCTAssertEqual(cancelledResult, .blocked)
        observation.record(.explicitRelease, .entered)
        release.signal()
        observation.record(.explicitRelease, .returned)
        observation.end(token)
        let diagnosticJoined = await observation.close()
        XCTAssertTrue(diagnosticJoined, "Diagnostic cleanup must be confirmed before fixture disposal")
        // The teardown retains this exact cohort if the diagnostic child could not join.
        guard diagnosticJoined else { return }
        observation.record(.physicalFinish, .entered)
        await finish(browser, driver: driver)
        observation.record(.physicalFinish, .returned)
        let stale = try XCTUnwrap(driver.all("browse").first)
        await stale.emit(.service(.init(name: "TooLate", interface: 1), added: true))
        XCTAssertTrue(browser.snapshot().candidates.isEmpty)
        XCTAssertTrue(driver.all("resolve").isEmpty)
    }
}
