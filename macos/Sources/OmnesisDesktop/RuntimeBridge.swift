// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import DesktopCore
import Foundation

@MainActor
final class RuntimeBridge {
    typealias PreparedRuntime = (URL, DesktopRuntimeUsageLease)
    typealias Preparation = @Sendable (URL) async throws -> PreparedRuntime
    var onEnvelope: ((BridgeEnvelope) -> Void)?
    var onFailure: ((String) -> Void)?
    private(set) var selectedRuntime: URL?
    var runtimeEpoch: String? {
        selectedRuntime?.lastPathComponent
    }

    private var process: Process?
    private var input: FileHandle?
    private var reader: Task<Void, Never>?
    /// Native presentation remains a code consumer even after its bridge exits.
    private var usageLease: DesktopRuntimeUsageLease?
    private let preparationOverride: Preparation?
    private var preparationTask: Task<PreparedRuntime, Error>?

    private var launching = false
    private var launchEpoch = UUID()

    init(preparation: Preparation? = nil) {
        preparationOverride = preparation
    }

    func start() async throws {
        guard process == nil else { return }
        guard !launching else { return }
        launching = true
        let epoch = launchEpoch
        defer { launching = false
            preparationTask = nil
        }
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
        if preparationOverride == nil { try await DesktopBackgroundObserver.ensureRunning(appBundle: app) }
        try Task.checkCancellation()
        guard epoch == launchEpoch else { throw CancellationError() }
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
        child.terminationHandler = { [weak self] finished in
            Task { @MainActor [weak self] in
                guard let self, self.process === finished else { return }
                self.process = nil
                self.input = nil
                self.reader?.cancel()
                self.onFailure?("Omnesis lost its background connection. Reopen the app to reconnect. Your library stays on disk.")
            }
        }
        try child.run()
        selectedRuntime = runtime
        process = child
        input = outgoing.fileHandleForWriting
        let handle = incoming.fileHandleForReading
        reader = Task { [weak self] in
            do {
                var buffer = JSONLineBuffer()
                for try await byte in handle.bytes {
                    try Task.checkCancellation()
                    for line in try buffer.append(Data([byte])) {
                        let envelope = try JSONDecoder().decode(BridgeEnvelope.self, from: line)
                        self?.onEnvelope?(envelope)
                    }
                }
            } catch is CancellationError {
                return
            } catch {
                self?.disconnect()
                self?.onFailure?("Omnesis could not read its background service. Try reconnecting, or quit and reopen the app.")
            }
        }
    }

    @discardableResult
    func send(_ command: String, params: [String: BridgeValue] = [:]) throws -> String {
        guard let input, process?.isRunning == true else { throw BridgeLaunchError.notRunning }
        let request = BridgeRequest(command: command, params: params)
        var data = try JSONEncoder().encode(request)
        data.append(10)
        try input.write(contentsOf: data)
        return request.id
    }

    func disconnect() {
        launchEpoch = UUID()
        preparationTask?.cancel()
        reader?.cancel()
        reader = nil
        try? input?.close()
        input = nil
        // Closing stdin lets the bridge perform its own graceful teardown.
        process?.terminationHandler = nil
        process = nil
    }
}

enum BridgeLaunchError: LocalizedError {
    case missingRuntime, notRunning
    var errorDescription: String? {
        switch self {
        case .missingRuntime: "This copy of Omnesis is missing its background service. Install the complete Omnesis app to continue."
        case .notRunning: "Omnesis is reconnecting to its background service. Try again in a moment."
        }
    }
}
