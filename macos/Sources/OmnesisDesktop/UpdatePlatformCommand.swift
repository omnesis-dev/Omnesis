// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Darwin
import Foundation

enum DesktopUpdatePlatformCommand {
    @discardableResult static func run(_ executable: String, _ arguments: [String], home: URL) throws -> Data {
        try Task.checkCancellation()
        let process = Process()
        let pipe = Pipe()
        process.executableURL = URL(fileURLWithPath: executable)
        process.arguments = arguments
        process.environment = ["HOME": home.path, "PATH": "/usr/bin:/bin:/usr/sbin:/sbin", "LANG": "en_US.UTF-8"]
        process.standardOutput = pipe
        process.standardError = FileHandle.nullDevice
        let timeout = DispatchWorkItem { if process.isRunning { process.terminate() } }
        let forcedTimeout = DispatchWorkItem { if process.isRunning { Darwin.kill(process.processIdentifier, SIGKILL) } }
        try process.run()
        DispatchQueue.global().asyncAfter(deadline: .now() + 120, execute: timeout)
        DispatchQueue.global().asyncAfter(deadline: .now() + 125, execute: forcedTimeout)
        defer { timeout.cancel()
            forcedTimeout.cancel()
            try? pipe.fileHandleForReading.close()
        }
        var output = Data()
        while let chunk = try pipe.fileHandleForReading.read(upToCount: 65536), !chunk.isEmpty {
            output.append(chunk)
            if output.count > 1024 * 1024 { process.terminate()
                process.waitUntilExit()
                throw DesktopUpdateInstaller.Failure.untrusted
            }
        }
        process.waitUntilExit()
        try Task.checkCancellation()
        guard process.terminationStatus == 0 else { throw DesktopUpdateInstaller.Failure.untrusted }
        return output
    }
}
