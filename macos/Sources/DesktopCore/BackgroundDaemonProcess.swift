// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Darwin
import Foundation

/// Owns one exact child and its lifetime writer. No PID records or unrelated processes are signaled.
public final class DesktopBackgroundDaemonProcess: @unchecked Sendable {
    public struct Ready: Codable, Equatable, Sendable {
        public let version: Int
        public let kind: String
        public let nonce: String
        public let pid: Int32
        public let epoch: String
        public let scope: DesktopBackgroundDaemonAuthority.Scope
    }

    public struct Exit: Sendable { public let code: Int32
        public let clean: Bool
    }

    public enum Failure: Error { case unavailable, invalidReady, timeout }
    private let child: Process
    private let lifetime: Pipe
    private let output: Pipe
    private let expected: DesktopBackgroundDaemonAuthority.Descriptor
    private let retirement: Bool
    private let pipeIdentity: DesktopBackgroundDaemonAuthority.PipeIdentity
    private let lock = NSLock()
    private var terminal: Exit?
    private var waiters: [CheckedContinuation<Exit, Never>] = []
    private var readiness: Task<Ready, Error>?
    private var exitCallback: (@Sendable (Exit) -> Void)?
    public var onExit: (@Sendable (Exit) -> Void)? {
        get { lock.lock()
            defer { lock.unlock() }
            return exitCallback
        }
        set {
            lock.lock()
            exitCallback = newValue
            let finished = terminal
            lock.unlock()
            if let finished { newValue?(finished) }
        }
    }

    public var pid: Int32 {
        child.processIdentifier
    }

    public var running: Bool {
        child.isRunning
    }

    public static func launch(runtime: URL, descriptor: String) throws -> DesktopBackgroundDaemonProcess {
        try launch(runtime: runtime, descriptor: descriptor, retirement: false)
    }

    public static func launchRetirement(runtime: URL, descriptor: String) throws -> DesktopBackgroundDaemonProcess {
        try launch(runtime: runtime, descriptor: descriptor, retirement: true)
    }

    private static func launch(runtime: URL, descriptor: String, retirement: Bool) throws -> DesktopBackgroundDaemonProcess {
        let child = Process()
        child.executableURL = runtime.appendingPathComponent("runtime-exec")
        child.arguments = [retirement ? "--background-retire" : "--background-daemon", descriptor]
        child.currentDirectoryURL = runtime
        child.environment = DesktopRuntimeEnvironment.child(parent: ProcessInfo.processInfo.environment, runtime: runtime)
        return try DesktopBackgroundDaemonProcess(
            process: child,
            descriptor: DesktopBackgroundDaemonAuthority.decode(descriptor, requiresNonce: true),
            retirement: retirement
        )
    }

    init(process: Process, descriptor: DesktopBackgroundDaemonAuthority.Descriptor, retirement: Bool = false) throws {
        child = process
        expected = descriptor
        self.retirement = retirement
        lifetime = Pipe()
        output = Pipe()
        var identity = stat()
        guard fstat(lifetime.fileHandleForReading.fileDescriptor, &identity) == 0,
              identity.st_mode & S_IFMT == S_IFIFO else { throw Failure.unavailable }
        pipeIdentity = .init(device: String(UInt64(bitPattern: Int64(identity.st_dev))), inode: String(identity.st_ino))
        guard fcntl(lifetime.fileHandleForWriting.fileDescriptor, F_SETFD, FD_CLOEXEC) == 0,
              fcntl(output.fileHandleForReading.fileDescriptor, F_SETFL, O_NONBLOCK) == 0 else { throw Failure.unavailable }
        child.standardInput = lifetime
        child.standardOutput = output
        child.standardError = FileHandle.nullDevice
        child.terminationHandler = { [weak self] process in
            self?.finished(Exit(
                code: process.terminationStatus,
                clean: process.terminationReason == .exit && process.terminationStatus == 0
            ))
        }
        try child.run()
        try? lifetime.fileHandleForReading.close()
        try? output.fileHandleForWriting.close()
    }

    var ownedRecord: DesktopBackgroundDaemonAuthority.Owner {
        .init(
            format: 1,
            scope: expected.scope,
            epoch: expected.epoch,
            nonce: expected.nonce ?? "",
            helperPid: getpid(),
            daemonPid: pid,
            pipe: pipeIdentity
        )
    }

    public func matchesOwner(_ owner: DesktopBackgroundDaemonAuthority.Owner, retirement: Bool) -> Bool {
        running && self.retirement == retirement && owner.format == 1 && owner.helperPid == getpid() && owner.daemonPid == pid &&
            owner.nonce == expected.nonce && owner.scope == expected.scope && owner.epoch == expected.epoch && owner.pipe == pipeIdentity
    }

    public func ready() async throws -> Ready {
        let task = readinessTask()
        return try await withTaskCancellationHandler(operation: { try await task.value }, onCancel: { task.cancel() })
    }

    private func readinessTask() -> Task<Ready, Error> {
        lock.lock()
        defer { lock.unlock() }
        if let readiness { return readiness }
        let task = Task.detached(priority: .utility) { [self] in
            defer { try? output.fileHandleForReading.close() }
            let deadline = ContinuousClock.now.advanced(by: .seconds(70))
            var bytes = Data()
            var buffer = [UInt8](repeating: 0, count: 1024)
            let fd = output.fileHandleForReading.fileDescriptor
            while ContinuousClock.now < deadline {
                try Task.checkCancellation()
                var item = pollfd(fd: fd, events: Int16(POLLIN), revents: 0)
                let polled = Darwin.poll(&item, 1, 50)
                if polled < 0 { if errno == EINTR { continue }
                    throw Failure.unavailable
                }
                if polled == 0 { continue }
                let count = Darwin.read(fd, &buffer, buffer.count)
                if count < 0 { if errno == EAGAIN || errno == EINTR { continue }
                    throw Failure.unavailable
                }
                guard count > 0 else { throw Failure.invalidReady }
                bytes.append(contentsOf: buffer.prefix(count))
                guard bytes.count <= 4096 else { throw Failure.invalidReady }
                if let newline = bytes.firstIndex(of: 10) {
                    guard newline == bytes.index(before: bytes.endIndex),
                          let object = try JSONSerialization.jsonObject(with: bytes) as? [String: Any],
                          Set(object.keys) == ["version", "kind", "nonce", "pid", "epoch", "scope"],
                          let scope = object["scope"] as? [String: Any], Set(scope.keys) == [
                              "format",
                              "configDir",
                              "instance",
                              "secretService",
                          ] else { throw Failure.invalidReady }
                    let ready = try JSONDecoder().decode(Ready.self, from: bytes)
                    guard ready.version == 1, ready.kind == "desktop-daemon-ready", ready.nonce == expected.nonce,
                          ready.pid == pid, ready.epoch == expected.epoch, ready.scope == expected.scope,
                          child.isRunning else { throw Failure.invalidReady }
                    return ready
                }
            }
            throw Failure.timeout
        }
        readiness = task
        return task
    }

    public func waitForExit() async -> Exit {
        await withCheckedContinuation { continuation in
            lock.lock()
            if let terminal { lock.unlock()
                continuation.resume(returning: terminal)
            } else { waiters.append(continuation)
                lock.unlock()
            }
        }
    }

    public func requestDrain() {
        try? lifetime.fileHandleForWriting.close()
    }

    public func stopAndJoin() async -> Exit {
        requestDrain()
        if child.isRunning { child.terminate() }
        let escalation = Task { [self] in
            do { try await Task.sleep(for: .seconds(75)) } catch { return }
            if child.isRunning { _ = Darwin.kill(pid, SIGKILL) }
        }
        let exit = await waitForExit()
        escalation.cancel()
        return exit
    }

    private func finished(_ value: Exit) {
        lock.lock()
        guard terminal == nil else { lock.unlock()
            return
        }
        terminal = value
        let callbacks = waiters
        waiters.removeAll()
        let notify = exitCallback
        lock.unlock()
        try? lifetime.fileHandleForWriting.close()
        for callback in callbacks {
            callback.resume(returning: value)
        }
        notify?(value)
    }

    deinit { try? lifetime.fileHandleForWriting.close() }
}
