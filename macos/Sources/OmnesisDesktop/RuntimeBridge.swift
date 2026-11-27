// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Darwin
import DesktopCore
import Foundation

@MainActor
final class RuntimeBridge {
    struct Termination: Equatable, Sendable {
        let status: Int32
        let exitedNormally: Bool
        var clean: Bool {
            exitedNormally && status == 0
        }
    }

    private(set) var lastTermination: Termination?
    typealias PreparedRuntime = (URL, DesktopRuntimeUsageLease)
    typealias Preparation = @Sendable (URL) async throws -> PreparedRuntime
    typealias InputClosure = @MainActor (FileHandle) throws -> Void
    var onEnvelope: ((BridgeEnvelope) -> Void)?
    var onFailure: ((String) -> Void)?
    var onApplicationOwnership: ((DesktopBackgroundApplicationOrigin.Evidence) -> Void)?
    var onStartupBlocked: ((DesktopBackgroundObserver.StartupBlock?) -> Void)?
    private(set) var selectedRuntime: URL?
    var runtimeEpoch: String? {
        selectedRuntime?.lastPathComponent
    }

    @MainActor
    private final class LaunchCompletion {
        private var finished = false
        private var waiters: [CheckedContinuation<Void, Never>] = []
        func wait() async {
            if finished { return }
            await withCheckedContinuation { waiters.append($0) }
        }

        func finish() {
            finished = true
            let pending = waiters
            waiters.removeAll()
            for waiter in pending {
                waiter.resume()
            }
        }
    }

    private final class ExitReceipt: @unchecked Sendable {
        typealias Value = Termination
        private let lock = NSLock()
        private var terminal: Value?
        private var waiters: [CheckedContinuation<Value, Never>] = []
        func finish(_ value: Value) {
            let pending: [CheckedContinuation<Value, Never>] = lock.withLock {
                guard terminal == nil else { return [] }
                terminal = value
                let pending = waiters
                waiters.removeAll()
                return pending
            }
            for waiter in pending {
                waiter.resume(returning: value)
            }
        }

        func wait() async -> Value {
            await withCheckedContinuation { waiter in
                lock.lock()
                if let terminal { lock.unlock()
                    waiter.resume(returning: terminal)
                } else { waiters.append(waiter)
                    lock.unlock()
                }
            }
        }
    }

    @MainActor
    private final class Session {
        let process: Process
        let incoming: Pipe
        let outgoing: Pipe
        let exit = ExitReceipt()
        let close: InputClosure
        var reader: Task<Void, Never>?
        var active = true
        var reportedFailure = false
        var inputCloseAttempted = false
        var inputCloseError: Error?
        init(process: Process, incoming: Pipe, outgoing: Pipe, close: @escaping InputClosure) {
            self.close = close
            self.process = process
            self.incoming = incoming
            self.outgoing = outgoing
        }

        func closeInput() {
            guard !inputCloseAttempted else { return }
            inputCloseAttempted = true
            do { try close(outgoing.fileHandleForWriting) }
            catch { inputCloseError = error }
        }
    }

    private var session: Session?
    private var drainTask: Task<Void, Error>?
    private var launchCompletion: LaunchCompletion?
    /// Native presentation remains a code consumer even after its bridge exits.
    private var usageLease: DesktopRuntimeUsageLease?
    private let preparationOverride: Preparation?
    private let beforeReading: (@MainActor () async -> Void)?
    private let inputClosure: InputClosure
    private var preparationTask: Task<PreparedRuntime, Error>?

    private var launchEpoch = UUID()

    init(
        preparation: Preparation? = nil,
        beforeReading: (@MainActor () async -> Void)? = nil,
        inputClosure: @escaping InputClosure = { try $0.close() }
    ) {
        self.inputClosure = inputClosure
        preparationOverride = preparation
        self.beforeReading = beforeReading
    }

    func start() async throws {
        guard drainTask == nil else { throw BridgeLaunchError.draining }
        guard launchCompletion == nil else { throw BridgeLaunchError.starting }
        try Task.checkCancellation()
        let completion = LaunchCompletion()
        launchCompletion = completion
        defer {
            if launchCompletion === completion { launchCompletion = nil
                preparationTask = nil
            }
            completion.finish()
        }
        if let session {
            // Recovery keeps its DATA-free controller. Retry must independently authenticate
            // the helper again; an ordinary portable status cannot clear this block.
            guard preparationOverride == nil, let runtime = selectedRuntime else { return }
            let checking = launchEpoch
            do {
                try await DesktopBackgroundObserver
                    .ensureRunning(appBundle: Bundle.main.bundleURL, runtime: runtime) { [weak self] evidence in
                        guard self?.launchEpoch == checking else { return }
                        self?.onApplicationOwnership?(evidence)
                    }
                try Task.checkCancellation()
                guard checking == launchEpoch, session.process.isRunning else { throw CancellationError() }
                onStartupBlocked?(nil)
            } catch let blocked as DesktopBackgroundObserver.StartupBlock {
                try Task.checkCancellation()
                guard checking == launchEpoch, session.process.isRunning else { throw CancellationError() }
                onStartupBlocked?(blocked)
                throw blocked
            }
            return
        }
        let epoch = launchEpoch
        let app = Bundle.main.bundleURL
        let override = preparationOverride
        let task = Task.detached(priority: .userInitiated) {
            if let override { return try await override(app) }
            let runtime = try DesktopRuntimeBootstrap.prepare(appBundle: app)
            try Task.checkCancellation()
            let lease = try DesktopRuntimeUsageLease.acquire(runtime: runtime)
            if let id = ProcessInfo.processInfo.environment[DesktopApplicationLaunchReservation.environmentKey],
               Bundle.main.bundleIdentifier == "dev.omnesis.desktop" {
                try DesktopApplicationLaunchReservation.acknowledge(id: id, application: app, runtime: runtime, lease: lease)
            }
            return (runtime, lease)
        }
        preparationTask = task
        let prepared = try await withTaskCancellationHandler {
            try await task.value
        } onCancel: { task.cancel() }
        try Task.checkCancellation()
        guard epoch == launchEpoch else { throw CancellationError() }
        let runtime = prepared.0
        usageLease = prepared.1
        var nativeBlock: DesktopBackgroundObserver.StartupBlock?
        if preparationOverride == nil {
            do {
                try await DesktopBackgroundObserver.ensureRunning(appBundle: app, runtime: runtime) { [weak self] evidence in
                    guard self?.launchEpoch == epoch else { return }
                    self?.onApplicationOwnership?(evidence)
                }
            } catch let blocked as DesktopBackgroundObserver.StartupBlock {
                try Task.checkCancellation()
                guard epoch == launchEpoch else { throw CancellationError() }
                onStartupBlocked?(blocked)
                guard blocked == .ownerMismatch || blocked == .originRequired else { throw blocked }
                nativeBlock = blocked
            }
        }
        try Task.checkCancellation()
        guard epoch == launchEpoch else { throw CancellationError() }
        if preparationOverride == nil { onStartupBlocked?(nativeBlock) }
        let executable = runtime.appendingPathComponent("runtime-exec")
        let script = runtime.appendingPathComponent("packages/cli/dist/index.js")
        guard FileManager.default.isExecutableFile(atPath: executable.path),
              FileManager.default.fileExists(atPath: script.path) else { throw BridgeLaunchError.missingRuntime }
        let child = Process()
        let incoming = Pipe()
        let outgoing = Pipe()
        child.executableURL = executable
        child.arguments = ["--node", script.path, "desktop", "bridge"]
        child.currentDirectoryURL = runtime
        child.environment = DesktopRuntimeEnvironment.child(parent: ProcessInfo.processInfo.environment, runtime: runtime)
        child.standardInput = outgoing
        child.standardOutput = incoming
        // Runtime logs belong to its private log, never the JSON credential stream.
        child.standardError = FileHandle.nullDevice
        let owned = Session(process: child, incoming: incoming, outgoing: outgoing, close: inputClosure)
        session = owned
        child.terminationHandler = { [weak self, weak owned] finished in
            let status = finished.terminationStatus
            let exitedNormally = finished.terminationReason == .exit
            Task { @MainActor [weak self, weak owned] in
                let termination = Termination(status: status, exitedNormally: exitedNormally)
                guard let owned else { return }
                if let self, self.session === owned {
                    self.lastTermination = termination
                    self.fail(owned, message: "Omnesis lost its background connection. Your library stays on disk.")
                }
                owned.exit.finish(termination)
            }
        }
        do {
            // A live child can close stdin; keep broken-pipe handling local to this writer.
            guard fcntl(outgoing.fileHandleForWriting.fileDescriptor, F_SETNOSIGPIPE, 1) == 0 else {
                throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO)
            }
            try child.run()
        } catch {
            owned.active = false
            child.terminationHandler = nil
            var closeFailure: Error?
            for handle in [
                incoming.fileHandleForReading,
                incoming.fileHandleForWriting,
                outgoing.fileHandleForReading,
                outgoing.fileHandleForWriting,
            ] {
                do { try handle.close() } catch { closeFailure = closeFailure ?? error }
            }
            if closeFailure != nil {
                drainTask = Task { throw BridgeLaunchError.cleanupUnconfirmed }
            } else if session === owned { session = nil }
            throw error
        }
        selectedRuntime = runtime
        let handle = incoming.fileHandleForReading
        let beforeReading = beforeReading
        owned.reader = Task { [weak self, owned] in
            await beforeReading?()
            do {
                var buffer = JSONLineBuffer()
                for try await byte in handle.bytes {
                    guard owned.active else { continue }
                    do {
                        for line in try buffer.append(Data([byte])) {
                            let envelope = try JSONDecoder().decode(BridgeEnvelope.self, from: line)
                            guard let self, self.session === owned, owned.active else { continue }
                            self.onEnvelope?(envelope)
                        }
                    } catch {
                        guard let self, self.session === owned else { return }
                        self.fail(
                            owned,
                            message: "Omnesis could not read its background service. Check the connection status before trying again."
                        )
                        // Continue draining revoked bytes so portable shutdown cannot block on stdout.
                    }
                }
                guard let self, self.session === owned else { return }
                self.fail(owned, message: "Omnesis lost its background connection. Your library stays on disk.")
            } catch {
                guard let self, self.session === owned else { return }
                self.fail(owned, message: "Omnesis could not read its background service. Check the connection status before trying again.")
            }
        }
    }

    private func fail(_ owned: Session, message: String) {
        guard owned.active, !owned.reportedFailure else { return }
        owned.reportedFailure = true
        disconnect()
        onFailure?(message)
    }

    @discardableResult
    func send(_ command: String, params: [String: BridgeValue] = [:]) throws -> String {
        guard drainTask == nil, let session, session.active, session.process.isRunning else { throw BridgeLaunchError.notRunning }
        let input = session.outgoing.fileHandleForWriting
        let request = BridgeRequest(command: command, params: params)
        var data = try JSONEncoder().encode(request)
        data.append(10)
        do { try input.write(contentsOf: data) }
        catch {
            let failure = BridgeWriteError(underlying: error)
            fail(session, message: failure.localizedDescription)
            throw failure
        }
        return request.id
    }

    /// Revokes publication immediately; the exact owner remains retained until confirmed drain.
    func disconnect() {
        launchEpoch = UUID()
        preparationTask?.cancel()
        guard drainTask == nil else { return }
        let owned = session
        let launching = launchCompletion
        owned?.active = false
        owned?.closeInput()
        drainTask = Task { [self, owned, launching] in
            await launching?.wait()
            if let owned {
                let exit = await owned.exit.wait()
                await owned.reader?.value
                owned.reader = nil
                // The reader has returned; no callback can access this handle after closure.
                do { try owned.incoming.fileHandleForReading.close() }
                catch { throw BridgeLaunchError.cleanupUnconfirmed }
                owned.process.terminationHandler = nil
                lastTermination = exit
                // Exact physical retirement is distinct from successful portable teardown.
                // Any next start must repeat preparation and all native/portable authority checks.
                guard owned.inputCloseError == nil else { throw BridgeLaunchError.cleanupUnconfirmed }
            }
            if session === owned { session = nil }
            drainTask = nil
        }
    }

    /// Cancellation of a caller does not cancel the shared physical drain. It waits, then throws.
    func disconnectAndJoin() async throws {
        disconnect()
        let draining = drainTask
        try await draining?.value
        try Task.checkCancellation()
    }
}

enum BridgeLaunchError: LocalizedError {
    case missingRuntime, notRunning, starting, draining, cleanupUnconfirmed
    var errorDescription: String? {
        switch self {
        case .missingRuntime: "This copy of Omnesis is missing its background service. Install the complete Omnesis app to continue."
        case .starting: "Omnesis is still preparing its background connection."
        case .draining: "Omnesis has not confirmed that its previous background connection finished. Another connection was not started."
        case .cleanupUnconfirmed: "Omnesis could not confirm that its background connection finished. Another connection was not started."
        case .notRunning: "Omnesis is reconnecting to its background service. Try again in a moment."
        }
    }
}

struct BridgeWriteError: LocalizedError {
    let underlying: Error
    var errorDescription: String? {
        "Omnesis could not write to its background service. Check the connection status before trying again."
    }
}
