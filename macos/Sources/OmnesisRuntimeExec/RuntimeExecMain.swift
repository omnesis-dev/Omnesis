// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Darwin
import DesktopCore
import Foundation

@main
struct RuntimeExecMain {
    static func main() {
        do {
            guard let executable = Bundle.main.executableURL else { throw DesktopRuntimeUsageLease.Failure.invalidPayload }
            let lease = try DesktopRuntimeUsageLease.acquire(runtime: executable.deletingLastPathComponent())
            let arguments = Array(CommandLine.arguments.dropFirst())
            if arguments.first == "--gc-probe", arguments.count == 2 {
                let runtime = executable.deletingLastPathComponent()
                let eligible = try DesktopRuntimeUsageLease.withReclaimableEpoch(
                    cache: runtime.deletingLastPathComponent(),
                    epoch: arguments[1],
                    currentEpoch: runtime.lastPathComponent
                ) { _ in true }
                withExtendedLifetime(lease) { exit(eligible == true ? 0 : 3) }
            }
            if arguments.first == "--gc-remove", arguments.count == 2 {
                let runtime = executable.deletingLastPathComponent()
                let removed = try DesktopRuntimeUsageLease.removeReclaimableRuntime(
                    cache: runtime.deletingLastPathComponent(),
                    epoch: arguments[1],
                    currentEpoch: runtime.lastPathComponent
                )
                withExtendedLifetime(lease) { exit(removed ? 0 : 3) }
            }
            // Node-compatible default supports unmodified third-party spawn(process.execPath, argv).
            let explicit = ["--node", "--exec", "--external"].contains(arguments.first ?? "")
            let invocation = try lease.invocation(arguments: explicit ? arguments : ["--node"] + arguments)
            try lease.execute(invocation, environment: ProcessInfo.processInfo.environment)
        } catch {
            let code = (error as? DesktopRuntimeUsageLease.Failure).map { String(describing: $0) } ?? "nativeFailure"
            FileHandle.standardError.write(Data(("The managed runtime lease could not be established: " + code + "\n").utf8))
            exit(78)
        }
    }
}
