// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Darwin
import Foundation

public struct DesktopMacServerPowerObservation: Equatable, Sendable {
    public enum Status: Equatable, Sendable { case ready, sleepEnabled, onBattery, unavailable }
    public let status: Status
    public let laptop: Bool

    public init(status: Status, laptop: Bool = false) {
        self.status = status
        self.laptop = laptop
    }

    /// The persisted system idle-sleep policy is distinct from display sleep or temporary assertions.
    public static func parse(custom: String, battery: String) -> Self {
        var section: String?
        var acBlocks = 0
        var sleepValues: [Int] = []
        var laptop = false
        for line in custom.split(separator: "\n") {
            let text = line.trimmingCharacters(in: .whitespaces)
            if text.hasSuffix(":") {
                section = String(text.dropLast())
                if section == "AC Power" { acBlocks += 1 }
                if section == "Battery Power" { laptop = true }
                continue
            }
            guard section == "AC Power" else { continue }
            let words = text.split(whereSeparator: \.isWhitespace)
            guard words.first == "sleep" else { continue }
            guard words.count == 2, !words[1].isEmpty,
                  words[1].utf8.allSatisfy({ $0 >= 48 && $0 <= 57 }), let minutes = Int(words[1]) else {
                return Self(status: .unavailable, laptop: laptop)
            }
            sleepValues.append(minutes)
        }
        let headers = battery.split(separator: "\n").map { $0.trimmingCharacters(in: .whitespaces) }
            .filter { $0.hasPrefix("Now drawing from ") }
        guard acBlocks == 1, sleepValues.count == 1, headers.count == 1,
              let first = battery.split(separator: "\n").first?.trimmingCharacters(in: .whitespaces),
              first == "Now drawing from 'AC Power'" || first == "Now drawing from 'Battery Power'"
        else { return Self(status: .unavailable, laptop: laptop) }
        if first == "Now drawing from 'Battery Power'" { return Self(status: .onBattery, laptop: true) }
        return Self(status: sleepValues[0] == 0 ? .ready : .sleepEnabled, laptop: laptop)
    }
}

public enum DesktopMacServerPowerInspector {
    public static func check() async -> DesktopMacServerPowerObservation {
        let work = Task.detached(priority: .utility) {
            do {
                try Task.checkCancellation()
                let custom = try read(["-g", "custom"])
                try Task.checkCancellation()
                let battery = try read(["-g", "batt"])
                try Task.checkCancellation()
                return DesktopMacServerPowerObservation.parse(custom: custom, battery: battery)
            } catch { return DesktopMacServerPowerObservation(status: .unavailable) }
        }
        return await withTaskCancellationHandler(operation: { await work.value }, onCancel: { work.cancel() })
    }

    private enum Failure: Error { case unavailable }
    private final class Deadline: @unchecked Sendable {
        private let lock = NSLock()
        private var expired = false
        func expire() {
            lock.lock()
            expired = true
            lock.unlock()
        }

        var exceeded: Bool {
            lock.lock()
            defer { lock.unlock() }
            return expired
        }
    }

    /// Fixed read-only system commands. No shell, settings writes, privileges or user paths.
    static func read(
        _ arguments: [String],
        executable: URL = URL(fileURLWithPath: "/usr/bin/pmset"),
        timeout: TimeInterval = 3,
        killAfter: TimeInterval = 4
    ) throws
        -> String {
        let process = Process()
        process.executableURL = executable
        process.arguments = arguments
        process.standardInput = FileHandle.nullDevice
        process.environment = ["PATH": "/usr/bin:/bin:/usr/sbin:/sbin", "LC_ALL": "C", "LANG": "C"]
        let pipe = Pipe()
        process.standardOutput = pipe
        process.standardError = FileHandle.nullDevice
        let deadline = Deadline()
        let started = ContinuousClock.now
        try process.run()
        let stopWatchdog = DispatchSemaphore(value: 0)
        let watchdogFinished = DispatchSemaphore(value: 0)
        // FileHandle monitoring can occupy shared dispatch workers. The owned
        // deadline must remain able to terminate a child even under that load.
        let watchdog = Thread {
            defer { watchdogFinished.signal() }
            guard stopWatchdog.wait(timeout: .now() + timeout) == .timedOut else { return }
            deadline.expire()
            if process.isRunning { process.terminate() }
            guard stopWatchdog.wait(timeout: .now() + max(0, killAfter - timeout)) == .timedOut else { return }
            if process.isRunning { Darwin.kill(process.processIdentifier, SIGKILL) }
        }
        watchdog.name = "Omnesis power check deadline"
        watchdog.qualityOfService = .utility
        watchdog.start()
        defer {
            if process.isRunning { process.terminate()
                process.waitUntilExit()
            }
            stopWatchdog.signal()
            watchdogFinished.wait()
            try? pipe.fileHandleForReading.close()
        }
        var output = Data()
        while let chunk = try pipe.fileHandleForReading.read(upToCount: 4096), !chunk.isEmpty {
            output.append(chunk)
            if output.count > 32768 {
                process.terminate()
                process.waitUntilExit()
                throw Failure.unavailable
            }
        }
        process.waitUntilExit()
        guard !deadline.exceeded, started.duration(to: .now) < .seconds(timeout), process.terminationStatus == 0,
              let text = String(data: output, encoding: .utf8) else { throw Failure.unavailable }
        return text
    }
}
