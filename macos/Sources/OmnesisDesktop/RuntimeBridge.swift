// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import DesktopCore
import Foundation

@MainActor
final class RuntimeBridge {
    var onEnvelope: ((BridgeEnvelope) -> Void)?
    var onFailure: ((String) -> Void)?
    private var process: Process?
    private var input: FileHandle?
    private var reader: Task<Void, Never>?

    private var launching = false
    private var launchEpoch = UUID()

    func start() async throws {
        guard process == nil else { return }
        guard !launching else { return }
        launching = true
        let epoch = launchEpoch
        defer { launching = false }
        let app = Bundle.main.bundleURL
        let runtime = try await Task.detached(priority: .userInitiated) {
            try DesktopRuntimeBootstrap.prepare(appBundle: app)
        }.value
        try Task.checkCancellation()
        guard epoch == launchEpoch else { throw CancellationError() }
        let executable = runtime.appendingPathComponent("node")
        let script = runtime.appendingPathComponent("packages/cli/dist/index.js")
        guard FileManager.default.isExecutableFile(atPath: executable.path),
              FileManager.default.fileExists(atPath: script.path) else { throw BridgeLaunchError.missingRuntime }
        let child = Process()
        let incoming = Pipe()
        let outgoing = Pipe()
        child.executableURL = executable
        child.arguments = [script.path, "desktop", "bridge"]
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
                self.onFailure?("Omnesis stopped. Open the app again to reconnect. Your library is kept safely on disk.")
            }
        }
        try child.run()
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
