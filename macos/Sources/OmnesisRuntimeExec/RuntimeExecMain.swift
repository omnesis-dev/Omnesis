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
            var arguments = Array(CommandLine.arguments.dropFirst())
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
            let runtime = executable.deletingLastPathComponent()
            var environment = ProcessInfo.processInfo.environment
            var dataLease: DesktopDataUsageLease?
            var legacyData: DesktopRuntimeUsageLease.LegacyDataReservation?
            if arguments.first == "--metadata-generation" {
                guard lease.requiresDataUsage, arguments.count == 9,
                      let scope = try DesktopDataUsageLease.consumerScope(environment: environment, arguments: arguments),
                      Array(arguments[2 ... 5]) == ["--external", "/usr/bin/security", "find-generic-password", "-a"],
                      arguments[7] == "-s" else { throw DesktopDataUsageLease.Failure.invalidScope }
                try DesktopDataUsageLease.validateKeychainMetadata(
                    scope,
                    account: arguments[6],
                    service: arguments[8],
                    proposedGeneration: arguments[1]
                )
                arguments.removeFirst(2)
            } else if arguments.first == "--data-exclusive", arguments.count == 4 {
                guard lease.requiresDataUsage else { throw DesktopDataUsageLease.Failure.missingAuthority }
                guard let purpose = DesktopDataUsageLease.Purpose(rawValue: arguments[1]) else {
                    throw DesktopDataUsageLease.Failure.invalidScope
                }
                let scope = try DesktopDataUsageLease.decodeScope(arguments[3])
                dataLease = try DesktopDataUsageLease.acquire(
                    scope: scope,
                    epoch: runtime.lastPathComponent,
                    purpose: purpose,
                    operationId: arguments[2]
                )
                legacyData = try DesktopRuntimeUsageLease.reserveLegacyDataConsumers(cache: runtime.deletingLastPathComponent())
                // Only this compiled host accepts an exclusive operation. Secrets arrive on stdin.
                arguments = ["--node", runtime.appendingPathComponent("packages/cli/dist/desktop/data-operation.js").path]
                environment["OMNESIS_CONFIG_DIR"] = scope.configDir
                environment["OMNESIS_SERVICE_INSTANCE"] = scope.instance
                environment["OMNESIS_SECRET_SERVICE"] = scope.secretService
                environment["OMNESIS_SECRET_STORE"] = "macos-keychain"
                environment["OMNESIS_DESKTOP_MANAGED"] = "1"
            } else if arguments.first == "--data-use", arguments.count >= 3 {
                let scope = try DesktopDataUsageLease.decodeScope(arguments[1])
                dataLease = try DesktopDataUsageLease.acquire(scope: scope, epoch: runtime.lastPathComponent)
                arguments.removeFirst(2)
            } else if arguments.first == "--data-inherit", arguments.count >= 5 {
                guard let purpose = DesktopDataUsageLease.Purpose(rawValue: arguments[1]) else {
                    throw DesktopDataUsageLease.Failure.invalidScope
                }
                let scope = try DesktopDataUsageLease.decodeScope(arguments[3])
                dataLease = try DesktopDataUsageLease.acquire(
                    scope: scope,
                    epoch: runtime.lastPathComponent,
                    purpose: purpose,
                    operationId: arguments[2],
                    inheriting: true
                )
                arguments.removeFirst(4)
            } else if lease.requiresDataUsage {
                // Controllers own no data-use lease; any other default launch needs a validated
                // scope. An SDK dropping its env cannot escape through process.execPath.
                let controller = ["--node", runtime.appendingPathComponent("packages/cli/dist/index.js").path, "desktop"]
                let normalized = arguments.first == "--node" ? arguments : ["--node"] + arguments
                if normalized == ["--node", "--version"] || normalized == ["--node", "--help"] ||
                    normalized == ["--node", runtime.appendingPathComponent("packages/cli/dist/index.js").path, "--version"] {
                    // Fixed version/help probes read code metadata, never a profile or arbitrary JS.
                } else if arguments == ["--external", "/usr/bin/security", "-h"] {
                    // Capability probe exposes no credential or persistent user state.
                } else if arguments.count == 7, Array(arguments.prefix(4)) == [
                    "--external",
                    "/usr/bin/security",
                    "find-generic-password",
                    "-a",
                ], arguments[5] == "-s" {
                    guard let scope = try DesktopDataUsageLease.consumerScope(environment: environment, arguments: arguments) else {
                        throw DesktopDataUsageLease.Failure.missingAuthority
                    }
                    try DesktopDataUsageLease.validateKeychainMetadata(scope, account: arguments[4], service: arguments[6])
                } else if normalized.count >= 4, Array(normalized.prefix(3)) == controller,
                          ["bridge", "daemon"].contains(normalized[3]) {
                    if environment.removeValue(forKey: "OMNESIS_DESKTOP_DATA_CONTEXT") != nil {
                        Darwin.close(DesktopDataUsageLease.inheritedDescriptor)
                    }
                } else {
                    guard let scope = try DesktopDataUsageLease.consumerScope(environment: environment, arguments: arguments) else {
                        throw DesktopDataUsageLease.Failure.missingAuthority
                    }
                    let keychainSetup = arguments.count >= 3 && Array(arguments.prefix(2)) == ["--external", "/usr/bin/security"] &&
                        ["find-generic-password", "add-generic-password"].contains(arguments[2]) &&
                        arguments.firstIndex(of: "-s").map { $0 + 1 < arguments.count && arguments[$0 + 1] == scope.secretService } == true
                    let keychainRead = arguments.count == 8 && Array(arguments.prefix(4)) == [
                        "--external",
                        "/usr/bin/security",
                        "find-generic-password",
                        "-a",
                    ] &&
                        arguments[5] == "-s" && arguments[6] == scope.secretService && arguments[7] == "-w" &&
                        DesktopDataUsageLease.isKeychainRead(scope, account: arguments[4])
                    dataLease = try DesktopDataUsageLease.acquire(
                        scope: scope,
                        epoch: runtime.lastPathComponent,
                        keychainSetup: keychainSetup,
                        keychainRead: keychainRead
                    )
                }
            }
            if let dataLease { environment = try dataLease.prepareEnvironment(environment) }
            try legacyData?.inheritAcrossExec()
            // Node-compatible default supports unmodified third-party spawn(process.execPath, argv).
            let explicit = ["--node", "--exec", "--external"].contains(arguments.first ?? "")
            let invocation = try lease.invocation(arguments: explicit ? arguments : ["--node"] + arguments)
            try withExtendedLifetime((dataLease, legacyData)) { try lease.execute(invocation, environment: environment) }
        } catch {
            let code = (error as? DesktopRuntimeUsageLease.Failure).map { String(describing: $0) } ??
                (error as? DesktopDataUsageLease.Failure).map { String(describing: $0) } ?? "nativeFailure"
            FileHandle.standardError.write(Data(("The managed runtime lease could not be established: " + code + "\n").utf8))
            exit(78)
        }
    }
}
