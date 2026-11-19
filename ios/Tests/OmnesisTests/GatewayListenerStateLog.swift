// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

#if os(macOS)
import Foundation

/// What the live listeners in a proxy test did, for a failure message.
///
/// A recovering listener that never reports listening has either been refused by the operating
/// system (for example `EADDRINUSE` while another socket holds the session port) or has not
/// reported ready at all. The events and the port's holders tell those cases apart.
final class GatewayListenerStateLog: @unchecked Sendable {
    private let lock = NSLock()
    private let start = ContinuousClock.now
    private var events: [String] = []

    func record(_ event: String) {
        let elapsed = ContinuousClock.now - start
        lock.withLock { events.append("+\(elapsed) \(event)") }
    }

    var text: String {
        lock.withLock { events.isEmpty ? "(no listener events)" : events.joined(separator: "\n") }
    }

    /// The listener events followed by every socket on `port`, for an assertion message.
    func report(port: UInt16) -> String {
        "listener events:\n\(text)\nsockets on port \(port):\n\(Self.holders(of: port))"
    }

    private static func holders(of port: UInt16) -> String {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/sbin/lsof")
        process.arguments = ["-nP", "-iTCP:\(port)"]
        let output = Pipe()
        process.standardOutput = output
        process.standardError = output
        do { try process.run() } catch { return "lsof could not run: \(error)" }
        let data = output.fileHandleForReading.readDataToEndOfFile()
        process.waitUntilExit()
        let text = String(data: data, encoding: .utf8) ?? ""
        return text.isEmpty ? "(none)" : text
    }
}
#endif
