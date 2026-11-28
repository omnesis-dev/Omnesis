// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

@testable import DesktopCore
import dnssd
import Foundation
import XCTest

final class NearbyGatewayDNSTests: XCTestCase {
    private final class Counts: @unchecked Sendable {
        let lock = NSLock()
        var scheduled = 0
        var deallocated = 0
        var released = 0
        func values() -> [Int] {
            lock.withLock { [scheduled, deallocated, released] }
        }
    }

    func testProductionReferenceOwnsContextThroughSetupAndDeallocatesExactlyOnceOnQueue() async throws {
        let queue = DispatchQueue(label: "nearby-dns-owned-reference")
        let counts = Counts()
        let pointer = try XCTUnwrap(OpaquePointer(bitPattern: 1))
        let driver = SystemNearbyGatewayDNS(calls: .init(schedule: { ref, actualQueue in
            dispatchPrecondition(condition: .onQueue(queue))
            XCTAssertEqual(ref, pointer)
            XCTAssertTrue(actualQueue === queue)
            counts.lock.withLock { counts.scheduled += 1 }
            return DNSServiceErrorType(kDNSServiceErr_NoError)
        }, deallocate: { ref in
            dispatchPrecondition(condition: .onQueue(queue))
            XCTAssertEqual(ref, pointer)
            counts.lock.withLock { counts.deallocated += 1 }
        }), contextReleased: { counts.lock.withLock { counts.released += 1 } })
        let result: Result<Void, Error> = await withCheckedContinuation { continuation in
            queue.async {
                do {
                    let reference = try driver.create(on: queue, receive: { _ in }) { output, context in
                        XCTAssertEqual(counts.values(), [0, 0, 0])
                        XCTAssertNotEqual(UInt(bitPattern: context), 0)
                        output.pointee = pointer
                        return DNSServiceErrorType(kDNSServiceErr_NoError)
                    }
                    reference.cancel()
                    reference.cancel()
                    XCTAssertEqual(counts.values(), [1, 1, 0])
                    queue.async { continuation.resume(returning: .success(())) }
                } catch { continuation.resume(returning: .failure(error)) }
            }
        }
        try result.get()
        XCTAssertEqual(counts.values(), [1, 1, 1])
    }

    func testPublicDNSNameIsRejectedBeforeAnySystemSetup() async {
        let queue = DispatchQueue(label: "nearby-dns-local-only")
        let counts = Counts()
        let driver = SystemNearbyGatewayDNS(calls: .init(schedule: { _, _ in
            counts.lock.withLock { counts.scheduled += 1 }
            return DNSServiceErrorType(kDNSServiceErr_NoError)
        }, deallocate: { _ in counts.lock.withLock { counts.deallocated += 1 } }), contextReleased: {
            counts.lock.withLock { counts.released += 1 }
        })
        await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
            queue.async {
                do {
                    let unexpected = try driver.addresses("gateway.example.test.", port: 443, interface: 1, on: queue, receive: { _ in })
                    unexpected.cancel()
                    XCTFail("A public DNS name must be refused before system setup")
                } catch { /* The public-name boundary must refuse setup. */ }
                queue.async { continuation.resume() }
            }
        }
        XCTAssertEqual(counts.values(), [0, 0, 0])
    }

    func testProductionSetupAndScheduleFailuresReleaseOnlyTheirOwnContextAndReference() async throws {
        for failsScheduling in [false, true] {
            let queue = DispatchQueue(label: "nearby-dns-refusal")
            let counts = Counts()
            let pointer = try XCTUnwrap(OpaquePointer(bitPattern: 1))
            let driver = SystemNearbyGatewayDNS(calls: .init(schedule: { _, _ in
                counts.lock.withLock { counts.scheduled += 1 }
                return DNSServiceErrorType(kDNSServiceErr_PolicyDenied)
            }, deallocate: { ref in
                dispatchPrecondition(condition: .onQueue(queue))
                XCTAssertEqual(ref, pointer)
                counts.lock.withLock { counts.deallocated += 1 }
            }), contextReleased: { counts.lock.withLock { counts.released += 1 } })
            await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
                queue.async {
                    do {
                        let unexpected = try driver.create(on: queue, receive: { _ in }) { output, _ in
                            output.pointee = pointer
                            return DNSServiceErrorType(failsScheduling ? kDNSServiceErr_NoError : kDNSServiceErr_PolicyDenied)
                        }
                        unexpected.cancel()
                        XCTFail("Setup or scheduling refusal must throw")
                    } catch { XCTAssertEqual((error as? NearbyGatewayDNSFailure)?.denied, true) }
                    queue.async { continuation.resume() }
                }
            }
            XCTAssertEqual(counts.values(), [failsScheduling ? 1 : 0, 1, 1])
        }
    }
}
