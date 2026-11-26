// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Darwin
import DesktopCore
import Foundation

@main
struct RuntimeExecMain {
    @MainActor
    static func main() {
        do {
            // Snapshot reserved DATA descriptor before this process opens any of its own resources.
            // Keep main synchronous: async-runtime initialization must not create a misleading fd7.
            let fixed = [
                "--key-recovery",
                "--background-start",
                "--background-daemon",
                "--background-retire",
                "--verify-background-owner",
                "--verify-background-retirement",
                "--background-binding",
                "--background-rebind",
            ]
            if let first = CommandLine.arguments.dropFirst().first, fixed.contains(first) {
                errno = 0
                let inherited = fcntl(DesktopDataUsageLease.inheritedDescriptor, F_GETFD)
                guard inherited < 0, errno == EBADF else { throw DesktopDataUsageLease.Failure.missingAuthority }
            }
            guard let ownExecutable = Bundle.main.executableURL else { throw DesktopRuntimeUsageLease.Failure.invalidPayload }
            let executable = try URL(fileURLWithPath: DesktopCanonicalPath.resolve(ownExecutable.path))
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
            if arguments.first == "--key-recovery", arguments.count == 2 {
                guard lease.requiresDataUsage, environment["OMNESIS_DESKTOP_DATA_CONTEXT"] == nil else {
                    throw DesktopDataUsageLease.Failure.missingAuthority
                }
                let recovery = try DesktopKeyRecoveryAuthority.decode(arguments[1])
                let held = try DesktopDataUsageLease.acquireKeyRecovery(recovery, epoch: runtime.lastPathComponent)
                let parent = try DesktopKeyRecoveryKeychain.validateParent(runtime: runtime)
                try DesktopKeyRecoveryKeychain.validatePrivateChannel(STDOUT_FILENO)
                let input = try DesktopKeyRecoveryKeychain.readInput(parent: parent)
                let reply = try DesktopKeyRecoveryKeychain.perform(
                    input: input,
                    context: recovery,
                    epoch: runtime.lastPathComponent,
                    lease: held
                )
                var bytes = try JSONEncoder().encode(reply)
                guard bytes.count <= 8192 else { throw DesktopKeyRecoveryAuthority.Failure.invalidRequest }
                try DesktopKeyRecoveryKeychain.validatePrivateChannel(STDOUT_FILENO)
                bytes.append(10)
                try FileHandle.standardOutput.write(contentsOf: bytes)
                withExtendedLifetime((lease, held)) { exit(0) }
            }
            if ["--background-binding", "--background-rebind"].contains(arguments.first ?? ""), arguments.count == 2 {
                guard lease.requiresDataUsage,
                      environment["OMNESIS_DESKTOP_DATA_CONTEXT"] == nil else { throw DesktopDataUsageLease.Failure.missingAuthority }
                let replacing = arguments[0] == "--background-rebind"
                let selected = try DesktopBackgroundRebind.decode(arguments[1], replacing: replacing)
                if replacing {
                    Task { @MainActor in
                        do {
                            try await DesktopBackgroundRebind.perform(selected, runtime: runtime)
                            withExtendedLifetime(lease) { exit(0) }
                        } catch { fail(error) }
                    }
                    dispatchMain()
                } else {
                    var bytes = try JSONEncoder().encode(DesktopBackgroundRebind.query(selected.target, runtime: runtime))
                    guard bytes.count <= 4095 else { throw DesktopDataUsageLease.Failure.invalidScope }
                    bytes.append(10)
                    try FileHandle.standardOutput.write(contentsOf: bytes)
                }
                withExtendedLifetime(lease) { exit(0) }
            }
            if arguments.first == "--background-start", arguments.count == 2 {
                guard lease.requiresDataUsage, environment["OMNESIS_DESKTOP_DATA_CONTEXT"] == nil else {
                    throw DesktopDataUsageLease.Failure.missingAuthority
                }
                let descriptor = try DesktopBackgroundDaemonAuthority.decode(arguments[1], requiresNonce: false)
                let profile = try DesktopBackgroundManagedProfile.matching(descriptor.scope.dataScope)
                try profile.validateIdentity()
                guard descriptor.epoch == runtime.lastPathComponent else { throw DesktopDataUsageLease.Failure.invalidScope }
                let request = DesktopBackgroundLaunchProtocol.Request(
                    action: .ensureDaemon,
                    binding: profile.binding,
                    expectedEpoch: descriptor.epoch,
                    activation: descriptor.activation
                )
                let reply = try DesktopBackgroundControlClient.exchange(request)
                guard reply.state == .daemonOwned, reply.daemonPid != nil else { throw DesktopDataUsageLease.Failure.blocked }
                withExtendedLifetime(lease) { exit(0) }
            }
            if ["--verify-background-owner", "--verify-background-retirement"].contains(arguments.first ?? ""), arguments.count == 2 {
                guard lease.requiresDataUsage else { throw DesktopDataUsageLease.Failure.missingAuthority }
                try DesktopBackgroundDaemonAuthority.verifyOwner(
                    arguments[1],
                    runtime: runtime,
                    environment: environment,
                    retirement: arguments.first == "--verify-background-retirement"
                )
                withExtendedLifetime(lease) { exit(0) }
            }
            if ["--background-daemon", "--background-retire"].contains(arguments.first ?? ""), arguments.count == 2 {
                let descriptor = try DesktopBackgroundDaemonAuthority.decode(arguments[1], requiresNonce: true)
                let invocation = try DesktopBackgroundDaemonAuthority.invocation(
                    encoded: arguments[1],
                    runtime: runtime,
                    lease: lease,
                    environment: environment,
                    retirement: arguments.first == "--background-retire"
                )
                environment = DesktopRuntimeEnvironment.child(parent: environment, runtime: runtime)
                environment["OMNESIS_CONFIG_DIR"] = descriptor.scope.configDir
                environment["OMNESIS_SERVICE_INSTANCE"] = descriptor.scope.instance
                environment["OMNESIS_SECRET_SERVICE"] = descriptor.scope.secretService
                environment["OMNESIS_SECRET_STORE"] = "macos-keychain"
                environment["OMNESIS_DESKTOP_MANAGED"] = "1"
                environment["OMNESIS_REQUIRE_ENCRYPTED_STORAGE"] = "1"
                try withExtendedLifetime(lease) { try lease.execute(invocation, environment: environment) }
            }
            if ["--gc-reserve", "--gc-reserve-cancel"].contains(arguments.first ?? ""), arguments.count == 3 {
                guard lease.requiresDataUsage else { throw DesktopDataUsageLease.Failure.missingAuthority }
                let scope = try DesktopDataUsageLease.decodeScope(arguments[2])
                if arguments[0] == "--gc-reserve" {
                    try DesktopSnapshotGcLease.reserve(scope: scope, operationId: arguments[1], runtime: runtime)
                } else {
                    try DesktopSnapshotGcLease.cancel(scope: scope, operationId: arguments[1], runtime: runtime)
                }
                withExtendedLifetime(lease) { exit(0) }
            }
            if arguments.first == "--gc-snapshot", arguments.count == 3 {
                guard lease.requiresDataUsage else { throw DesktopDataUsageLease.Failure.missingAuthority }
                let scope = try DesktopDataUsageLease.decodeScope(arguments[2])
                let reclamation = try DesktopSnapshotGcLease.acquire(scope: scope, operationId: arguments[1], runtime: runtime)
                environment = try reclamation.prepareEnvironment(environment)
                environment["OMNESIS_CONFIG_DIR"] = scope.configDir
                environment["OMNESIS_SERVICE_INSTANCE"] = scope.instance
                environment["OMNESIS_SECRET_SERVICE"] = scope.secretService
                environment["OMNESIS_SECRET_STORE"] = "macos-keychain"
                environment["OMNESIS_DESKTOP_MANAGED"] = "1"
                let invocation = try lease.invocation(arguments: [
                    "--node", runtime.appendingPathComponent("packages/cli/dist/desktop/snapshot-retention-host.js").path,
                    "--perform", arguments[1],
                ])
                try withExtendedLifetime(reclamation) { try lease.execute(invocation, environment: environment) }
            }
            var catalogNonce: String?
            if arguments.first == "--catalog-discovery" {
                guard lease.requiresDataUsage, arguments.count >= 5 else { throw DesktopDataUsageLease.Failure.missingAuthority }
                catalogNonce = arguments[1]
                arguments.removeFirst(2)
            }
            var catalogLease: DesktopDataUsageLease.CatalogDiscovery?
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
                } else if normalized.count >= 4, Array(normalized.prefix(3)) == controller, normalized[3] == "daemon" {
                    // A packaged daemon must originate from the fixed signed-helper mode above.
                    throw DesktopDataUsageLease.Failure.missingAuthority
                } else if normalized.count >= 4, Array(normalized.prefix(3)) == controller, normalized[3] == "bridge" {
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
            if let catalogNonce {
                guard let dataLease, ["--external", "--exec"].contains(arguments.first ?? "") else {
                    throw DesktopDataUsageLease.Failure.missingAuthority
                }
                catalogLease = try dataLease.acquireCatalogDiscovery(nonce: catalogNonce, epoch: runtime.lastPathComponent)
                try catalogLease?.inheritAcrossExec()
            }
            if let dataLease { environment = try dataLease.prepareEnvironment(environment) }
            try legacyData?.inheritAcrossExec()
            // Node-compatible default supports unmodified third-party spawn(process.execPath, argv).
            let explicit = ["--node", "--exec", "--external"].contains(arguments.first ?? "")
            let invocation = try lease.invocation(arguments: explicit ? arguments : ["--node"] + arguments)
            try withExtendedLifetime((dataLease, legacyData, catalogLease)) { try lease.execute(invocation, environment: environment) }
        } catch { fail(error) }
    }

    private static func fail(_ error: Error) -> Never {
        let code = (error as? DesktopRuntimeUsageLease.Failure).map { String(describing: $0) } ??
            (error as? DesktopDataUsageLease.Failure).map { String(describing: $0) } ?? "nativeFailure"
        FileHandle.standardError.write(Data(("The managed runtime lease could not be established: " + code + "\n").utf8))
        exit(78)
    }
}
