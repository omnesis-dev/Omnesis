// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Darwin
import Foundation

/// One absent-only security command over private stdin. No caller-selected executable or command text.
enum DesktopKeyRecoveryWriteOnly {
    static let arguments = ["/usr/bin/security", "-q", "-i"]

    static func line(account: String, scope: DesktopDataUsageLease.Scope, value: Data, keychainPath: String) throws -> Data {
        guard scope.format == 1, scope.restoreActivation == nil,
              scope.secretService.range(of: "^dev\\.omnesis\\.desktop\\.[a-f0-9]{64}$", options: .regularExpression) != nil,
              DesktopDataUsageLease.isKeychainRead(scope, account: account),
              keychainPath.hasPrefix("/"), let text = String(data: value, encoding: .utf8) else {
            throw DesktopKeyRecoveryAuthority.Failure.invalidRequest
        }
        if account == "install-root-key-v1" {
            let prefix = "omn_root_v1_"
            guard text.hasPrefix(prefix) else { throw DesktopKeyRecoveryAuthority.Failure.invalidRequest }
            let encoded = String(text.dropFirst(prefix.count))
            guard encoded.range(of: "^[A-Za-z0-9_-]{43}$", options: .regularExpression) != nil,
                  let raw = Data(base64Encoded: encoded.replacingOccurrences(of: "-", with: "+")
                      .replacingOccurrences(of: "_", with: "/") + "="), raw.count == 32,
                  raw.base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_")
                  .replacingOccurrences(of: "=", with: "") == encoded else { throw DesktopKeyRecoveryAuthority.Failure.invalidRequest }
        } else if text != "required" { throw DesktopKeyRecoveryAuthority.Failure.invalidRequest }
        let fields = [
            "add-generic-password",
            "-a",
            account,
            "-s",
            scope.secretService,
            "-l",
            "Omnesis " + account,
            "-w",
            text,
            "-T",
            "/usr/bin/security",
            keychainPath,
        ]
        guard fields.allSatisfy({ !$0.unicodeScalars.contains(where: { $0.value < 32 || $0.value == 127 }) }) else {
            throw DesktopKeyRecoveryAuthority.Failure.invalidRequest
        }
        // security's split_line is not a shell. Escape its double-quoted/backslash grammar only.
        let quoted = fields
            .map { "\"" + $0.replacingOccurrences(of: "\\", with: "\\\\").replacingOccurrences(of: "\"", with: "\\\"") + "\"" }
            .joined(separator: " ")
        // Apple's fixed 4096-byte readline otherwise executes a truncated prefix.
        guard quoted.utf8.count <= 4094 else { throw DesktopKeyRecoveryAuthority.Failure.invalidRequest }
        return Data((quoted + "\n").utf8)
    }

    struct Child { let pid: pid_t
        let input: Int32
    }

    enum Write { case progress(Int), retry, failed }
    enum Wait { case running, joined(Int?, Int32?), uncertain }
    struct System {
        var write: (Int32, Data, Int) -> Write
        var wait: (pid_t) -> Wait
        var signal: (pid_t, Int32) -> Void
        var close: (Int32) -> Void
        var now: () -> TimeInterval
        var pause: () -> Void

        static var live: System {
            .init(
                write: { fd, bytes, offset in
                    let count = bytes.withUnsafeBytes { Darwin.write(fd, $0.baseAddress!.advanced(by: offset), bytes.count - offset) }
                    if count > 0 { return .progress(count) }
                    if count < 0, errno == EINTR || errno == EAGAIN { return .retry }
                    return .failed
                },
                wait: { pid in
                    var status: Int32 = 0
                    let result = waitpid(pid, &status, WNOHANG)
                    if result == pid {
                        let signal = status & 0x7F
                        return .joined(signal == 0 ? Int((status >> 8) & 0xFF) : nil, signal == 0 ? nil : signal)
                    }
                    return result < 0 && errno != EINTR ? .uncertain : .running
                },
                signal: { pid, signal in _ = Darwin.kill(pid, signal) },
                close: { _ = Darwin.close($0) },
                now: { ProcessInfo.processInfo.systemUptime },
                pause: { usleep(10000) }
            )
        }
    }

    struct Outcome {
        let joined: Bool
        let completeInput: Bool
        let exitCode: Int?
        let signal: Int32?
        let failed: Bool
        var success: Bool {
            joined && completeInput && exitCode == 0 && signal == nil && !failed
        }
    }

    static func run(
        account: String,
        scope: DesktopDataUsageLease.Scope,
        value: Data,
        keychainPath: String,
        dataDescriptor: Int32,
        validate: () throws -> Void
    ) throws
        -> Outcome {
        var bytes = try line(account: account, scope: scope, value: value, keychainPath: keychainPath)
        defer { bytes.resetBytes(in: 0 ..< bytes.count) }
        try validate()
        let child = try launch(dataDescriptor: dataDescriptor)
        return drive(child, bytes: bytes, validate: validate)
    }

    /// Fixed child only. Originals are CLOEXEC; every dup2 source is above all reserved destinations.
    static func launch(dataDescriptor: Int32) throws -> Child {
        var pipeFD: [Int32] = [-1, -1]
        guard pipe(&pipeFD) == 0 else { throw DesktopKeyRecoveryAuthority.Failure.keychainRefused }
        var input = pipeFD[1]
        defer { Darwin.close(pipeFD[0])
            if input >= 0 { Darwin.close(input) }
        }
        guard fcntl(pipeFD[0], F_SETFD, FD_CLOEXEC) == 0 else { throw DesktopKeyRecoveryAuthority.Failure.keychainRefused }
        try prepareWriter(input)
        let null = Darwin.open("/dev/null", O_RDWR | O_CLOEXEC)
        guard null >= 0 else { throw DesktopKeyRecoveryAuthority.Failure.keychainRefused }
        defer { Darwin.close(null) }
        var copies: [Int32] = []
        defer { copies.forEach { Darwin.close($0) } }
        for source in [pipeFD[0], null, dataDescriptor] {
            let duplicate = fcntl(source, F_DUPFD_CLOEXEC, 30)
            guard duplicate >= 30 else { throw DesktopKeyRecoveryAuthority.Failure.keychainRefused }
            copies.append(duplicate)
        }
        var actions: posix_spawn_file_actions_t?
        guard posix_spawn_file_actions_init(&actions) == 0 else { throw DesktopKeyRecoveryAuthority.Failure.keychainRefused }
        defer { posix_spawn_file_actions_destroy(&actions) }
        for (source, destination) in [(copies[0], Int32(0)), (copies[1], Int32(1)), (copies[1], Int32(2)), (copies[2], Int32(7))] {
            guard posix_spawn_file_actions_adddup2(&actions, source, destination) == 0 else {
                throw DesktopKeyRecoveryAuthority.Failure.keychainRefused
            }
        }
        let environment = [
            "HOME=" + FileManager.default.homeDirectoryForCurrentUser.path,
            "PATH=/usr/bin:/bin:/usr/sbin:/sbin",
            "LANG=en_US.UTF-8",
        ]
        let argv = arguments.map { strdup($0) } + [nil], env = environment.map { strdup($0) } + [nil]
        defer { argv.forEach { free($0) }
            env.forEach { free($0) }
        }
        guard argv.dropLast().allSatisfy({ $0 != nil }), env.dropLast().allSatisfy({ $0 != nil }) else {
            throw DesktopKeyRecoveryAuthority.Failure.keychainRefused
        }
        var pid: pid_t = 0
        let result = argv.withUnsafeBufferPointer { args in env.withUnsafeBufferPointer { vars in
            posix_spawn(&pid, "/usr/bin/security", &actions, nil, args.baseAddress!, vars.baseAddress!)
        } }
        guard result == 0, pid > 1 else { throw DesktopKeyRecoveryAuthority.Failure.keychainRefused }
        let writer = input
        input = -1
        return Child(pid: pid, input: writer)
    }

    static func prepareWriter(_ descriptor: Int32) throws {
        guard fcntl(descriptor, F_SETFD, FD_CLOEXEC) == 0,
              fcntl(descriptor, F_SETFL, O_NONBLOCK) == 0,
              fcntl(descriptor, F_SETNOSIGPIPE, 1) == 0 else { throw DesktopKeyRecoveryAuthority.Failure.keychainRefused }
    }

    /// Same drive loop for actual fixed child and deterministic short-write/deadline tests.
    static func drive(_ child: Child, bytes: Data, validate: () throws -> Void, system: System = .live) -> Outcome {
        let began = system.now()
        var offset = 0, failed = false, inputOpen = true, terminated = false, killed = false
        func closeInput() {
            if inputOpen { system.close(child.input)
                inputOpen = false
            }
        }
        defer { closeInput() }
        do { try validate() } catch { failed = true }
        while true {
            if system.now() - began >= 5 {
                failed = true
                closeInput()
                if !terminated {
                    terminated = true
                    system.signal(child.pid, SIGTERM)
                }
            }
            if !failed, offset < bytes.count {
                switch system.write(child.input, bytes, offset) {
                case .progress(let count):
                    if count > 0, count <= bytes.count - offset { offset += count } else { failed = true }
                case .retry: break
                case .failed: failed = true
                }
            }
            if failed || offset == bytes.count { closeInput() }
            switch system.wait(child.pid) {
            case .joined(let code, let signal):
                do { try validate() } catch { failed = true }
                return .init(
                    joined: true,
                    completeInput: !bytes.isEmpty && offset == bytes.count,
                    exitCode: code,
                    signal: signal,
                    failed: failed
                )
            case .uncertain:
                return .init(joined: false, completeInput: offset == bytes.count, exitCode: nil, signal: nil, failed: true)
            case .running: break
            }
            let elapsed = system.now() - began
            if !terminated, failed || elapsed >= 5 {
                failed = true
                closeInput()
                terminated = true
                system.signal(child.pid, SIGTERM)
            }
            if !killed, elapsed >= 6 { failed = true
                closeInput()
                killed = true
                system.signal(child.pid, SIGKILL)
            }
            system.pause()
        }
    }
}
