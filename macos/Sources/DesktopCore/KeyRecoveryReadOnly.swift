// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Darwin
import Foundation

/// Read-only compatibility with the ordinary reader's User-domain Keychain and existing ACL.
/// The exact DATA SH description is inherited at FD7, including if this parent is killed.
enum DesktopKeyRecoveryReadOnly {
    struct PhysicalOutcome {
        enum Failure: Equatable { case none, deadline, read, join, oversize }
        let failure: Failure
        let failureErrno: Int32?
        let joined: Bool
        let exitCode: Int?
        let signal: Int32?
        let termAttempted: Bool
        let killAttempted: Bool
        let stdoutBytes: Int

        var summary: String {
            "KEY_RECOVERY_READ_PHYSICAL failure=\(failure) errno=\(failureErrno.map(String.init) ?? "none") "
                + "joined=\(joined) exit=\(exitCode.map(String.init) ?? "none") signal=\(signal.map(String.init) ?? "none") "
                + "termAttempted=\(termAttempted) killAttempted=\(killAttempted) stdoutBytes=\(stdoutBytes)"
        }
    }

    struct Result { let code: Int
        let bytes: Data
        let physical: PhysicalOutcome
    }

    static func arguments(account: String, scope: DesktopDataUsageLease.Scope, secret: Bool) throws -> [String] {
        guard DesktopDataUsageLease.isKeychainRead(scope, account: account) else {
            throw DesktopKeyRecoveryAuthority.Failure.invalidRequest
        }
        return ["find-generic-password", "-a", account, "-s", scope.secretService] + (secret ? ["-w"] : [])
    }

    static func run(account: String, scope: DesktopDataUsageLease.Scope, secret: Bool, dataDescriptor: Int32) throws -> Result {
        let output = Pipe()
        defer { try? output.fileHandleForReading.close()
            try? output.fileHandleForWriting.close()
        }
        let read = output.fileHandleForReading.fileDescriptor, write = output.fileHandleForWriting.fileDescriptor
        let null = Darwin.open("/dev/null", O_RDWR | O_CLOEXEC)
        guard null >= 0 else { throw DesktopKeyRecoveryAuthority.Failure.keychainRefused }
        defer { Darwin.close(null) }
        guard fcntl(read, F_SETFL, O_NONBLOCK) == 0, fcntl(read, F_SETFD, FD_CLOEXEC) == 0,
              fcntl(write, F_SETFD, FD_CLOEXEC) == 0 else { throw DesktopKeyRecoveryAuthority.Failure.keychainRefused }
        var actions: posix_spawn_file_actions_t?
        guard posix_spawn_file_actions_init(&actions) == 0 else { throw DesktopKeyRecoveryAuthority.Failure.keychainRefused }
        defer { posix_spawn_file_actions_destroy(&actions) }
        for (source, destination) in [(null, Int32(0)), (secret ? write : null, Int32(1)), (null, Int32(2)), (dataDescriptor, Int32(7))] {
            guard posix_spawn_file_actions_adddup2(&actions, source, destination) == 0 else {
                throw DesktopKeyRecoveryAuthority.Failure.keychainRefused
            }
        }
        let command = "/usr/bin/security"
        let strings = try [command] + arguments(account: account, scope: scope, secret: secret)
        let environment = [
            "HOME=" + FileManager.default.homeDirectoryForCurrentUser.path,
            "PATH=/usr/bin:/bin:/usr/sbin:/sbin",
            "LANG=en_US.UTF-8",
        ]
        let argv = strings.map { strdup($0) } + [nil]
        let env = environment.map { strdup($0) } + [nil]
        defer { argv.forEach { free($0) }
            env.forEach { free($0) }
        }
        guard argv.dropLast().allSatisfy({ $0 != nil }), env.dropLast().allSatisfy({ $0 != nil }) else {
            throw DesktopKeyRecoveryAuthority.Failure.keychainRefused
        }
        var pid: pid_t = 0
        let launched = argv.withUnsafeBufferPointer { args in env.withUnsafeBufferPointer { variables in
            posix_spawn(&pid, command, &actions, nil, args.baseAddress!, variables.baseAddress!)
        } }
        guard launched == 0, pid > 1 else { throw DesktopKeyRecoveryAuthority.Failure.keychainRefused }
        try? output.fileHandleForWriting.close()
        let began = ContinuousClock.now
        var bytes = Data(), failed = false, terminated = false, killed = false
        var physicalFailure = PhysicalOutcome.Failure.none
        var failureErrno: Int32?
        var didJoin = false, stdoutBytes = 0
        func record(_ failure: PhysicalOutcome.Failure, code: Int32? = nil) {
            if physicalFailure == .none { physicalFailure = failure
                failureErrno = code
            }
        }
        var status: Int32 = 0, buffer = [UInt8](repeating: 0, count: 512)
        while true {
            let count = Darwin.read(read, &buffer, buffer.count)
            if count > 0 {
                stdoutBytes = min(4097, stdoutBytes + count)
                if !failed {
                    bytes.append(contentsOf: buffer.prefix(count))
                    if bytes.count > 4096 { record(.oversize)
                        failed = true
                    }
                }
            } else if count < 0, errno != EAGAIN, errno != EINTR { record(.read, code: errno)
                failed = true
            }
            let joined = waitpid(pid, &status, WNOHANG)
            if joined == pid { didJoin = true
                break
            }
            if joined < 0, errno != EINTR {
                // An unexpected join failure cannot certify a successful read.
                record(.join, code: errno)
                failed = true
                break
            }
            let elapsed = began.duration(to: .now)
            if !terminated, failed || elapsed >= .seconds(5) {
                record(.deadline)
                failed = true
                terminated = true
                _ = Darwin.kill(pid, SIGTERM)
            }
            if !killed, elapsed >= .seconds(6) { failed = true
                killed = true
                _ = Darwin.kill(pid, SIGKILL)
            }
            usleep(10000)
        }
        while !failed {
            let count = Darwin.read(read, &buffer, buffer.count)
            if count == 0 { break }
            if count < 0 { if errno == EINTR { continue }
                record(.read, code: errno)
                failed = true
                break
            }
            stdoutBytes = min(4097, stdoutBytes + count)
            bytes.append(contentsOf: buffer.prefix(count))
            if bytes.count > 4096 { record(.oversize)
                failed = true
            }
        }
        let physical = PhysicalOutcome(
            failure: physicalFailure, failureErrno: failureErrno, joined: didJoin,
            exitCode: didJoin && status & 0x7F == 0 ? Int((status >> 8) & 0xFF) : nil,
            signal: didJoin && status & 0x7F != 0 ? status & 0x7F : nil,
            termAttempted: terminated, killAttempted: killed, stdoutBytes: stdoutBytes
        )
        guard !failed, status & 0x7F == 0 else { return .init(code: 1, bytes: Data(), physical: physical) }
        let code = Int((status >> 8) & 0xFF)
        // security prints one terminating newline for a password read.
        if code == 0, secret, bytes.last == 10 { bytes.removeLast() }
        return .init(code: code == 0 || code == 44 ? code : 1, bytes: code == 0 ? bytes : Data(), physical: physical)
    }
}
