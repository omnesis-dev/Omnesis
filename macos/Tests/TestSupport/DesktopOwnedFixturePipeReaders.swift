// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Darwin
import Foundation
import XCTest

/// Only the stdout/stderr Pipes of one owned test invocation; never adopts an arbitrary descriptor.
final class DesktopOwnedFixturePipeReaders: @unchecked Sendable {
    enum Stream: Sendable { case output, errors }
    enum Failure: Error { case configuration(Int32), read(Int32), retirementUnconfirmed, missingEOF }

    private let output: Reader
    private let errors: Reader
    private var started = false
    private var retiring = false

    init(
        output: Pipe, errors: Pipe,
        consumeOutput: @escaping @Sendable (Data) -> Void,
        consumeErrors: @escaping @Sendable (Data) -> Void,
        beforeRead: (@Sendable (Stream) -> Void)? = nil
    ) throws {
        // Complete checked configuration before either asynchronous reader exists.
        for pipe in [output, errors] {
            let descriptor = pipe.fileHandleForReading.fileDescriptor
            let flags = fcntl(descriptor, F_GETFL)
            guard flags >= 0, fcntl(descriptor, F_SETFL, flags | O_NONBLOCK) == 0 else {
                throw Failure.configuration(errno)
            }
            let configured = fcntl(descriptor, F_GETFL)
            guard configured >= 0, configured & O_NONBLOCK != 0,
                  configured & ~O_NONBLOCK == flags & ~O_NONBLOCK else { throw Failure.configuration(errno) }
        }
        self.output = Reader(pipe: output, consume: consumeOutput, beforeRead: { beforeRead?(.output) })
        self.errors = Reader(pipe: errors, consume: consumeErrors, beforeRead: { beforeRead?(.errors) })
    }

    /// Invocation-owner methods are serialized; only Reader's queue and receipt state are concurrent.
    func start() throws {
        guard !retiring else { throw Failure.retirementUnconfirmed }
        guard !started else { return }
        started = true
        output.start()
        errors.start()
    }

    func requestCancellation() {
        retiring = true
        output.requestCancellation()
        errors.requestCancellation()
    }

    func join(until deadline: DispatchTime, requireEOF: Bool = false) throws {
        // Both readers share the caller's one absolute deadline, never a renewed per-reader budget.
        var failure: Error?
        for reader in [output, errors] {
            do { try reader.join(until: deadline, requireEOF: requireEOF) }
            catch { if failure == nil { failure = error } }
        }
        if let failure { throw failure }
    }

    func retireAfterEOF() throws {
        retiring = true
        // Backend preserves its original unbounded physical wait/EOF policy, not a new hard SLA.
        try join(until: .distantFuture, requireEOF: true)
    }

    private final class Reader: @unchecked Sendable {
        private let pipe: Pipe
        private let consume: @Sendable (Data) -> Void
        private let beforeRead: @Sendable () -> Void
        private let queue = DispatchQueue(label: "dev.omnesis.test.owned-pipe-reader")
        private let finished = DispatchGroup()
        private let lock = NSLock()
        private var source: DispatchSourceRead?
        private var failure: Error?
        private var eof = false
        private var closed = false

        init(pipe: Pipe, consume: @escaping @Sendable (Data) -> Void, beforeRead: @escaping @Sendable () -> Void) {
            self.pipe = pipe
            self.consume = consume
            self.beforeRead = beforeRead
        }

        func start() {
            let source = DispatchSource.makeReadSource(fileDescriptor: pipe.fileHandleForReading.fileDescriptor, queue: queue)
            self.source = source
            finished.enter()
            source.setEventHandler { [weak self] in self?.receive() }
            source.setCancelHandler { [weak self] in self?.closeAfterCancellation() }
            source.resume()
        }

        func requestCancellation() {
            source?.cancel()
        }

        private func receive() {
            guard let source, !source.isCancelled else { return }
            beforeRead()
            var bytes = [UInt8](repeating: 0, count: 4096)
            // Finite work and a cancellation check per read let the serial cancellation handler run.
            for _ in 0 ..< 16 {
                if source.isCancelled { return }
                let count = bytes.withUnsafeMutableBytes {
                    Darwin.read(pipe.fileHandleForReading.fileDescriptor, $0.baseAddress, $0.count)
                }
                if count > 0 { consume(Data(bytes.prefix(count)))
                    continue
                }
                if count == 0 {
                    lock.lock()
                    eof = true
                    lock.unlock()
                    source.cancel()
                    return
                }
                let code = errno
                if code == EINTR { continue }
                if code == EAGAIN || code == EWOULDBLOCK { return }
                lock.lock()
                failure = Failure.read(code)
                lock.unlock()
                source.cancel()
                return
            }
        }

        private func closeAfterCancellation() {
            // Dispatch guarantees all event work has returned and the source has released this FD.
            do { try pipe.fileHandleForReading.close() }
            catch {
                lock.lock()
                if failure == nil { failure = error }
                lock.unlock()
                finished.leave()
                return
            }
            lock.lock()
            closed = true
            lock.unlock()
            finished.leave()
        }

        func join(until deadline: DispatchTime, requireEOF: Bool) throws {
            if source == nil {
                // No source was ever activated for a refused/pre-launch invocation.
                lock.lock()
                defer { lock.unlock() }
                if !closed { try pipe.fileHandleForReading.close()
                    closed = true
                }
                return
            }
            guard finished.wait(timeout: deadline) == .success else { throw Failure.retirementUnconfirmed }
            lock.lock()
            defer { lock.unlock() }
            if let failure { throw failure }
            guard closed else { throw Failure.retirementUnconfirmed }
            if requireEOF, !eof { throw Failure.missingEOF }
        }
    }
}

final class DesktopOwnedFixturePipeReadersTests: XCTestCase {
    private final class Count: @unchecked Sendable {
        private let lock = NSLock()
        private var bytes = Data()
        func append(_ data: Data) {
            lock.lock()
            bytes.append(data)
            lock.unlock()
        }

        var value: Data {
            lock.lock()
            defer { lock.unlock() }
            return bytes
        }
    }

    func testCancellationJoinsAnAdmittedHandlerBeforeCloseAndRefusesItsLateRead() throws {
        let output = Pipe(), errors = Pipe(), consumed = Count()
        let descriptor = output.fileHandleForReading.fileDescriptor
        let entered = DispatchSemaphore(value: 0), release = DispatchSemaphore(value: 0)
        let readers = try DesktopOwnedFixturePipeReaders(
            output: output, errors: errors, consumeOutput: { consumed.append($0) }, consumeErrors: { _ in },
            beforeRead: { stream in
                if case .output = stream { entered.signal()
                    release.wait()
                }
            }
        )
        defer {
            release.signal()
            readers.requestCancellation()
            // The test itself must physically join even if an earlier assertion failed.
            try? readers.join(until: .distantFuture)
            try? output.fileHandleForWriting.close()
            try? errors.fileHandleForWriting.close()
        }
        try readers.start()
        try output.fileHandleForWriting.write(contentsOf: Data("fixture bytes".utf8))
        guard entered.wait(timeout: .now() + 2) == .success else {
            XCTFail("The owned reader did not enter the synchronization gate")
            return
        }
        readers.requestCancellation()
        XCTAssertThrowsError(try readers.join(until: .now()))
        XCTAssertGreaterThanOrEqual(fcntl(descriptor, F_GETFL), 0)
        release.signal()
        try readers.join(until: .now() + 2)
        XCTAssertEqual(consumed.value, Data(), "An admitted handler must recheck cancellation before touching its descriptor")
        XCTAssertThrowsError(try readers.start(), "Retired readers cannot be admitted again")
        try readers.join(until: .now())
    }

    func testRealEOFRetiresOnlyAfterBufferedBytesAreConsumed() throws {
        let output = Pipe(), errors = Pipe(), consumed = Count()
        let readers = try DesktopOwnedFixturePipeReaders(
            output: output, errors: errors, consumeOutput: { consumed.append($0) }, consumeErrors: { _ in }
        )
        defer { readers.requestCancellation()
            try? readers.join(until: .distantFuture)
        }
        try readers.start()
        let bytes = Data("invented pipe fixture".utf8)
        try output.fileHandleForWriting.write(contentsOf: bytes)
        try output.fileHandleForWriting.close()
        try errors.fileHandleForWriting.close()
        try readers.join(until: .now() + 2, requireEOF: true)
        XCTAssertEqual(consumed.value, bytes)
        try readers.join(until: .now(), requireEOF: true)
    }
}
