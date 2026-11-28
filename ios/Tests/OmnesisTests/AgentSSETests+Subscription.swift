// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

@testable import Omnesis
import XCTest

@available(iOS 17.0, *)
extension AgentSSETests {
    func testOwnedSubscriptionJoinsNaturalEOFAndPreservesResumeHeader() async throws {
        StubSSEProtocol.reset()
        StubSSEProtocol.body = Data("id: 11\ndata: {\"type\":\"agent.resync\",\"payload\":{}}\n\n".utf8)
        let subscription = makeStubClient().eventSubscription(lastEventId: "10")
        var items: [AgentStreamItem] = []
        do { for try await item in subscription.stream {
            items.append(item)
        } } catch { subscription.cancel()
            await subscription.join()
            throw error
        }
        await subscription.join()
        subscription.cancel()
        await subscription.join()
        XCTAssertEqual(StubSSEProtocol.lastEventIdHeader, "10")
        XCTAssertEqual(items.map(\.id), ["11"])
        guard let first = items.first, case .resync = first.event else { return XCTFail("Expected the actual decoded event") }
    }

    func testOwnedSubscriptionJoinsProducerError() async {
        StubSSEProtocol.reset()
        StubSSEProtocol.status = 401
        let subscription = makeStubClient().eventSubscription()
        var refused = false
        do { for try await _ in subscription.stream {
            XCTFail("A refused connection cannot emit events")
        } } catch GatewayClient.Error.unauthorized {
            refused = true
        } catch {
            XCTFail("Unexpected fixed fixture error category")
        }
        subscription.cancel()
        await subscription.join()
        XCTAssertTrue(refused)
    }

    func testEarlyCancellationRetainsAndJoinsBothExactTaskBodies() async {
        let lifetime = AgentEventLifetime()
        let producerGate = SSELifetimeGate(), watchdogGate = SSELifetimeGate()
        let producerEntered = expectation(description: "owned producer entered")
        let watchdogEntered = expectation(description: "owned watchdog entered")
        let producer = Task { producerEntered.fulfill()
            await producerGate.hold()
        }
        let watchdog = Task { watchdogEntered.fulfill()
            await watchdogGate.hold()
        }
        lifetime.cancel() // Termination can precede synchronous handle installation.
        lifetime.install(producer: producer, watchdog: watchdog)
        await fulfillment(of: [producerEntered, watchdogEntered], timeout: 5)
        let joining = expectation(description: "join caller entered")
        let receipt = SSELifetimeReceipt()
        let secondReceipt = SSELifetimeReceipt()
        let secondWaiter = Task { await lifetime.join()
            await secondReceipt.finish()
        }
        let waiter = Task { joining.fulfill()
            await lifetime.join()
            await receipt.finish()
        }
        await fulfillment(of: [joining], timeout: 5)
        waiter.cancel() // A canceled waiter still owes the same two joins.
        let prematurelyJoined = await receipt.finished
        XCTAssertFalse(prematurelyJoined)
        await producerGate.release()
        await producer.value
        let joinedWithWatchdogHeld = await receipt.finished
        XCTAssertFalse(joinedWithWatchdogHeld)
        let secondJoinedWithWatchdogHeld = await secondReceipt.finished
        XCTAssertFalse(secondJoinedWithWatchdogHeld)
        await watchdogGate.release()
        await waiter.value
        await secondWaiter.value
        await lifetime.join()
        let complete = await receipt.finished
        let producerCancelled = await producerGate.wasCancelled
        let watchdogCancelled = await watchdogGate.wasCancelled
        XCTAssertTrue(complete)
        let secondComplete = await secondReceipt.finished
        XCTAssertTrue(secondComplete)
        XCTAssertTrue(producerCancelled)
        XCTAssertTrue(watchdogCancelled)
    }
}

private actor SSELifetimeGate {
    private var released = false
    private var continuation: CheckedContinuation<Void, Never>?
    private(set) var wasCancelled = false

    func hold() async {
        if !released { await withCheckedContinuation { continuation = $0 } }
        wasCancelled = Task.isCancelled
    }

    func release() {
        released = true
        continuation?.resume()
        continuation = nil
    }
}

private actor SSELifetimeReceipt {
    private(set) var finished = false
    func finish() {
        finished = true
    }
}
