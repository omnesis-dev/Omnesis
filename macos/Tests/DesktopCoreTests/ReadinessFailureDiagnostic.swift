// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Darwin
import DesktopCore
import Foundation

/// One post-failure observation per test process; it never grants extra readiness time.
enum DesktopReadinessFailureDiagnostic {
    struct Target: Sendable {
        let identity: DesktopBackgroundProcessIdentity
        let node: String

        /// The caller must have adopted this exact child from live kernel parent/UID/image/birth evidence.
        init(identity: DesktopBackgroundProcessIdentity, node: URL) {
            self.identity = identity
            self.node = node.path
        }

        init?(process: Process, runtime: URL) {
            guard let identity = try? DesktopBackgroundProcessIdentity.read(process.processIdentifier) else { return nil }
            self.identity = identity
            node = runtime.appendingPathComponent("node").path
        }
    }

    private struct Snapshot {
        var identityMatches = false
        var nodeImage = false
        var taskRead = false
        var userTime: UInt64 = 0
        var systemTime: UInt64 = 0
        var taskThreads: Int32 = 0
        var listRead = false
        var listed = 0
        var running = 0
        var stopped = 0
        var waiting = 0
        var uninterruptible = 0
        var halted = 0
        var readFailures = 0
        var unknownStates = 0

        var summary: String {
            "identity=\(identityMatches),node=\(nodeImage),taskRead=\(taskRead),taskThreads=\(taskThreads),listRead=\(listRead),listed=\(listed),running=\(running),stopped=\(stopped),waiting=\(waiting),uninterruptible=\(uninterruptible),halted=\(halted),readFailures=\(readFailures),unknownStates=\(unknownStates)"
        }
    }

    struct LiveObservationBudget {
        private(set) var spent = false
        mutating func claim(eligible: Bool) -> Bool {
            guard eligible, !spent else { return false }
            spent = true
            return true
        }
    }

    @MainActor private static var budget = LiveObservationBudget()

    @MainActor
    static func collect(target: Target?, captureReady: @Sendable () -> Bool) async -> String {
        guard !budget.spent else { return "postFailureSample=false" }
        guard let target else { return "postFailureSample=false,targetEligible=false" }
        let before = snapshot(target)
        guard budget.claim(eligible: before.identityMatches && before.nodeImage) else {
            return "postFailureSample=false,targetEligible=false,identityMatches=\(before.identityMatches),nodeImage=\(before.nodeImage)"
        }
        let readyBefore = captureReady()
        do { try await Task.sleep(for: .milliseconds(250)) }
        catch { return "postFailureSample=true,interrupted=true; before[\(before.summary)]" }
        let after = snapshot(target)
        let readyAfter = captureReady()
        let comparable = before.identityMatches && after.identityMatches && before.nodeImage && after.nodeImage &&
            before.taskRead && after.taskRead
        let stack = await sample(target)
        return "postFailureSample=true,targetCaptured=true,interrupted=false; stack[\(stack)]; before[\(before.summary)]; after[\(after.summary)]; cpuComparable=\(comparable),userAdvanced=\(comparable && after.userTime > before.userTime),systemAdvanced=\(comparable && after.systemTime > before.systemTime),captureReadyBefore=\(readyBefore),captureReadyAfter=\(readyAfter)"
    }

    static func nativeRefusalCode(_ text: String) -> String {
        let prefix = "The managed runtime lease could not be established: "
        let allowed: Set = [
            "inUse",
            "blocked",
            "missingAuthority",
            "unsafeRecord",
            "invalidScope",
            "legacyUnverified",
            "invalidPayload",
            "unsafeLock",
            "unsupportedInvocation",
            "cannotExecute",
            "nativeFailure",
            "invalidRequest",
        ]
        for line in text.suffix(8192).split(separator: "\n") where line.hasPrefix(prefix) {
            let value = String(line.dropFirst(prefix.count))
            return allowed.contains(value) ? value : "unknown"
        }
        return "none"
    }

    static let maximumStackBytes = 2 * 1024 * 1024

    /// Finite mentions only, never raw stack symbols, paths, process headers or tool messages.
    static func stackFacts(_ bytes: Data) -> String {
        guard bytes.count <= maximumStackBytes else { return "bounded=false" }
        let text = String(decoding: bytes, as: UTF8.self)
        return "bounded=true,dyldMention=\(text.contains("dyld")),nodeMention=\(text.contains("node::")),tlsMention=\(text.contains("SSL_")),securityMention=\(text.contains("SecTrust")),kernelMention=\(text.contains("mach_msg"))"
    }

    static func verifies(_ target: Target, identity: DesktopBackgroundProcessIdentity?, image: String?) -> Bool {
        identity == target.identity && image == target.node
    }

    static func refusal(bytes: Int64, elapsed: Duration, ownedFile: Bool) -> String? {
        if !ownedFile || bytes < 0 { return "file-refused" }
        if bytes > maximumStackBytes { return "oversize" }
        if elapsed >= .seconds(5) { return "deadline" }
        return nil
    }

    /// Only the function that freshly posix_spawn'ed the child may use this state.
    /// WNOHANG == 0 proves it is still our unreaped child. No other code reaps it;
    /// its PID cannot be reused between that observation and a cleanup signal.
    struct SamplerLifecycle {
        enum Observation { case running, joined, ownershipLost, interrupted }
        enum Action: Equatable { case wait, terminate, kill, joined, unconfirmed, finished }
        private(set) var finished = false
        private var terminatedAt: Duration?
        private var killed = false

        mutating func advance(_ observation: Observation, elapsed: Duration, refused: Bool) -> Action {
            if finished { return .finished }
            switch observation {
            case .joined: finished = true
                return .joined
            case .ownershipLost: finished = true
                return .unconfirmed
            case .running, .interrupted: break
            }
            // A bounded refusal is not physical closure. Retain private ownership evidence.
            if elapsed >= .seconds(7) { finished = true
                return .unconfirmed
            }
            guard case .running = observation else { return .wait }
            if terminatedAt == nil, refused || elapsed >= .seconds(5) {
                terminatedAt = elapsed
                return .terminate
            }
            if let terminatedAt, elapsed - terminatedAt >= .seconds(1), !killed {
                killed = true
                return .kill
            }
            return .wait
        }
    }

    static func permitsSoleWaiter(defaultHandler: Bool, autoReaps: Bool) -> Bool {
        defaultHandler && !autoReaps
    }

    private static func permitsSoleWaiter() -> Bool {
        var disposition = sigaction()
        guard sigaction(SIGCHLD, nil, &disposition) == 0 else { return false }
        // Darwin SIG_DFL is the null handler; custom handlers might reap our child.
        return permitsSoleWaiter(
            defaultHandler: disposition.__sigaction_u.__sa_handler == nil,
            autoReaps: disposition.sa_flags & SA_NOCLDWAIT != 0
        )
    }

    static func verifiesSampler(
        initial: DesktopBackgroundProcessIdentity?,
        current: DesktopBackgroundProcessIdentity?,
        image: String?
    )
        -> Bool {
        initial != nil && initial == current && image == "/usr/bin/sample"
    }

    private static func image(_ pid: Int32) -> String? {
        var path = [CChar](repeating: 0, count: 4096)
        guard proc_pidpath(pid, &path, UInt32(path.count)) > 0 else { return nil }
        return String(cString: path)
    }

    private static func verifies(_ target: Target) -> Bool {
        verifies(target, identity: try? DesktopBackgroundProcessIdentity.read(target.identity.pid), image: image(target.identity.pid))
    }

    private static func privateDirectory(_ directory: URL) throws {
        var info = stat()
        guard lstat(directory.path, &info) == 0, info.st_mode & S_IFMT == S_IFDIR,
              info.st_uid == getuid(), info.st_mode & 0o077 == 0,
              try DesktopCanonicalPath.resolve(directory.path) == directory.path else { throw SampleFailure.refused }
    }

    private enum SampleFailure: Error { case refused }

    /// One fixed public tool, only after a failed assertion. Raw output remains outside upload
    /// until target identity, actual sampler join and the retained-file bound all validate.
    @MainActor
    static func sample(_ target: Target, didPublish: ((URL) -> Void)? = nil) async -> String {
        guard verifies(target) else { return "result=identity-refused" }
        guard permitsSoleWaiter() else { return "result=reaper-refused" }
        let manager = FileManager.default
        var temporary: URL?
        do {
            let parent = try URL(fileURLWithPath: DesktopCanonicalPath.resolve(manager.temporaryDirectory.path), isDirectory: true)
            let directory = parent.appendingPathComponent("omnesis-owned-readiness-" + UUID().uuidString, isDirectory: true)
            try manager.createDirectory(at: directory, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
            temporary = directory
            try privateDirectory(directory)
            let output = directory.appendingPathComponent("stack.txt")
            let fd = Darwin.open(output.path, O_RDWR | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0o600)
            guard fd >= 0 else { throw SampleFailure.refused }
            defer { Darwin.close(fd) }
            var original = stat()
            guard fstat(fd, &original) == 0 else { throw SampleFailure.refused }
            func fileState() -> stat? {
                var info = stat(), published = stat()
                guard fstat(fd, &info) == 0, lstat(output.path, &published) == 0,
                      info.st_mode & S_IFMT == S_IFREG, info.st_uid == getuid(),
                      info.st_mode & 0o077 == 0, info.st_nlink == 1,
                      info.st_dev == original.st_dev, info.st_ino == original.st_ino,
                      info.st_dev == published.st_dev, info.st_ino == published.st_ino else { return nil }
                return info
            }
            let owner = directory.appendingPathComponent("sampler-owner.json")
            let ownerFD = Darwin.open(owner.path, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0o600)
            guard ownerFD >= 0 else { throw SampleFailure.refused }
            defer { Darwin.close(ownerFD) }
            var actions: posix_spawn_file_actions_t?
            guard posix_spawn_file_actions_init(&actions) == 0 else { throw SampleFailure.refused }
            defer { posix_spawn_file_actions_destroy(&actions) }
            for descriptor in [STDIN_FILENO, STDOUT_FILENO, STDERR_FILENO] {
                guard posix_spawn_file_actions_addopen(
                    &actions,
                    descriptor,
                    "/dev/null",
                    descriptor == STDIN_FILENO ? O_RDONLY : O_WRONLY,
                    0
                ) == 0 else { throw SampleFailure.refused }
            }
            let command = "/usr/bin/sample"
            let argumentStrings: [String] = [command, String(target.identity.pid), "1", "-file", output.path]
            let environmentStrings = ["PATH=/usr/bin:/bin"]
            let argv: [UnsafeMutablePointer<CChar>?] = argumentStrings.map { value in
                value.withCString { strdup($0) }
            } + [nil]
            let environment: [UnsafeMutablePointer<CChar>?] = environmentStrings.map { value in
                value.withCString { strdup($0) }
            } + [nil]
            defer { argv.forEach { free($0) }
                environment.forEach { free($0) }
            }
            guard argv.dropLast().allSatisfy({ $0 != nil }), environment.dropLast().allSatisfy({ $0 != nil }),
                  verifies(target) else { throw SampleFailure.refused }
            var pid: pid_t = 0
            let spawned = argv.withUnsafeBufferPointer { args in environment.withUnsafeBufferPointer { env in
                posix_spawn(&pid, command, &actions, nil, args.baseAddress!, env.baseAddress!)
            } }
            guard spawned == 0, pid > 1 else { return "result=spawn-refused" }
            // Optional image/birth metadata gates evidence; cleanup authority is the
            // fresh direct child plus the sole waitpid owner's unreaped relationship.
            let sampler = try? DesktopBackgroundProcessIdentity.read(pid)
            let began = ContinuousClock.now
            var reason: String? = verifiesSampler(initial: sampler, current: sampler, image: image(pid)) ? nil : "sampler-identity-refused"
            var status: Int32 = 0
            // Retain only this spawned child's kernel binding if join cannot be confirmed.
            // A receipt is diagnostic evidence, never permission to adopt or signal a PID.
            let ownership = Data(
                "{\"format\":1,\"pid\":\(pid),\"parent\":\(sampler?.parent ?? -1),\"seconds\":\(sampler?.startedSeconds ?? 0),\"microseconds\":\(sampler?.startedMicroseconds ?? 0)}\n"
                    .utf8
            )
            let written = ownership.withUnsafeBytes { Darwin.write(ownerFD, $0.baseAddress, $0.count) }
            if written != ownership.count || fsync(ownerFD) != 0 { reason = "owner-refused" }
            var lifecycle = SamplerLifecycle(), didJoin = false
            while !lifecycle.finished {
                guard permitsSoleWaiter() else { return "result=reaper-changed,joined=false,privateRetained=true" }
                // This is the sole waitpid owner, from successful spawn until join/loss.
                let waited = waitpid(pid, &status, WNOHANG)
                let observation: SamplerLifecycle.Observation = waited == pid ? .joined :
                    waited == 0 ? .running : errno == EINTR ? .interrupted : .ownershipLost
                let state = fileState()
                reason = reason ?? refusal(bytes: Int64(state?.st_size ?? -1), elapsed: began.duration(to: .now), ownedFile: state != nil)
                if Task.isCancelled { reason = reason ?? "cancelled" }
                if !verifies(target) { reason = reason ?? "identity-changed" }
                // Image/birth metadata gates publication, never cleanup authority for our
                // freshly spawned, still-unreaped direct child after WNOHANG == 0.
                if case .running = observation,
                   !verifiesSampler(initial: sampler, current: try? DesktopBackgroundProcessIdentity.read(pid), image: image(pid)) {
                    reason = reason ?? "sampler-identity-refused"
                }
                switch lifecycle.advance(observation, elapsed: began.duration(to: .now), refused: reason != nil) {
                case .terminate: _ = Darwin.kill(pid, SIGTERM)
                case .kill: _ = Darwin.kill(pid, SIGKILL)
                case .joined: didJoin = true
                case .unconfirmed: return "result=join-unconfirmed,joined=false,privateRetained=true"
                case .wait, .finished: break
                }
                if !lifecycle.finished {
                    do { try await Task.sleep(for: .milliseconds(10)) }
                    catch { usleep(10000) }
                }
            }
            guard didJoin else { return "result=join-unconfirmed,joined=false,privateRetained=true" }
            var observed = stat()
            let observedFile = lstat(output.path, &observed) == 0
            let outputFacts = "outputPresent=\(observedFile),regular=\(observedFile && observed.st_mode & S_IFMT == S_IFREG),owned=\(observedFile && observed.st_uid == getuid()),private=\(observedFile && observed.st_mode & 0o077 == 0),singleLink=\(observedFile && observed.st_nlink == 1),initialInode=\(observedFile && observed.st_dev == original.st_dev && observed.st_ino == original.st_ino),bytes=\(observedFile ? max(0, min(Int64(observed.st_size), Int64(maximumStackBytes + 1))) : -1)"
            guard verifies(target),
                  let final = fileState() else { return "result=identity-or-file-refused,joined=true,privateRetained=true; " + outputFacts }
            reason = reason ?? refusal(bytes: Int64(final.st_size), elapsed: began.duration(to: .now), ownedFile: true)
            if let reason {
                if reason == "oversize" { try manager.removeItem(at: output)
                    try manager.removeItem(at: owner)
                    try manager.removeItem(at: directory)
                }
                return "result=\(reason),joined=true"
            }
            guard status == 0 else { return "result=tool-refused,joined=true,privateRetained=true" }
            var bytes = [UInt8](repeating: 0, count: maximumStackBytes + 1)
            let count = Darwin.pread(fd, &bytes, bytes.count, 0)
            guard count > 0, count == final.st_size, count <= maximumStackBytes,
                  fileState()?.st_size == final.st_size else { return "result=read-refused,joined=true,privateRetained=true" }
            // Derive only the owned checkout, never an operator-selected output or another process.
            var repository = URL(fileURLWithPath: #filePath)
            for _ in 0 ..< 4 {
                repository.deleteLastPathComponent()
            }
            var destination = repository
            for name in ["evidence", "readiness-diagnostics"] {
                destination.appendPathComponent(name, isDirectory: true)
                if !manager.fileExists(atPath: destination.path) {
                    try manager.createDirectory(at: destination, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
                }
                try privateDirectory(destination)
            }
            destination.appendPathComponent(UUID().uuidString, isDirectory: true)
            try manager.createDirectory(at: destination, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
            try privateDirectory(destination)
            guard verifies(target), fileState()?.st_size == final.st_size else { throw SampleFailure.refused }
            let published = destination.appendingPathComponent("stack.txt")
            // Never copy across filesystems or expose an unchecked replacement inode.
            guard Darwin.rename(output.path, published.path) == 0 else { throw SampleFailure.refused }
            var retained = stat()
            guard lstat(published.path, &retained) == 0, retained.st_dev == original.st_dev,
                  retained.st_ino == original.st_ino, retained.st_mode & S_IFMT == S_IFREG,
                  retained.st_uid == getuid(), retained.st_mode & 0o077 == 0,
                  retained.st_nlink == 1, retained.st_size == final.st_size else { throw SampleFailure.refused }
            try manager.removeItem(at: owner)
            try manager.removeItem(at: directory)
            didPublish?(published)
            return "result=collected,joined=true; " + stackFacts(Data(bytes.prefix(count)))
        } catch {
            return "result=io-refused,privateRetained=\(temporary != nil)"
        }
    }

    private static func snapshot(_ target: Target) -> Snapshot {
        var result = Snapshot()
        guard (try? DesktopBackgroundProcessIdentity.read(target.identity.pid)) == target.identity else { return result }
        result.identityMatches = true
        var executable = [CChar](repeating: 0, count: 4096)
        guard proc_pidpath(target.identity.pid, &executable, UInt32(executable.count)) > 0,
              String(cString: executable) == target.node else { return result }
        result.nodeImage = true
        var task = proc_taskinfo()
        let taskSize = Int32(MemoryLayout<proc_taskinfo>.size)
        if proc_pidinfo(target.identity.pid, PROC_PIDTASKINFO, 0, &task, taskSize) == taskSize {
            result.taskRead = true
            result.userTime = task.pti_total_user
            result.systemTime = task.pti_total_system
            result.taskThreads = task.pti_threadnum
        }
        var threads = [UInt64](repeating: 0, count: 64)
        let bytes = threads.withUnsafeMutableBytes { buffer in
            proc_pidinfo(target.identity.pid, PROC_PIDLISTTHREADS, 0, buffer.baseAddress, Int32(buffer.count))
        }
        if bytes > 0, Int(bytes) <= 64 * MemoryLayout<UInt64>.size, Int(bytes) % MemoryLayout<UInt64>.size == 0 {
            result.listRead = true
            result.listed = Int(bytes) / MemoryLayout<UInt64>.size
            for thread in threads.prefix(result.listed) {
                var info = proc_threadinfo()
                let size = Int32(MemoryLayout<proc_threadinfo>.size)
                // PROC_PIDLISTTHREADS returns legacy handles, not unique thread IDs.
                guard proc_pidinfo(target.identity.pid, PROC_PIDTHREADINFO, thread, &info, size) == size else {
                    result.readFailures += 1
                    continue
                }
                switch info.pth_run_state {
                case TH_STATE_RUNNING: result.running += 1
                case TH_STATE_STOPPED: result.stopped += 1
                case TH_STATE_WAITING: result.waiting += 1
                case TH_STATE_UNINTERRUPTIBLE: result.uninterruptible += 1
                case TH_STATE_HALTED: result.halted += 1
                default: result.unknownStates += 1
                }
            }
        }
        // Reject a PID incarnation or exec change during these bounded metadata reads.
        let identityMatches = (try? DesktopBackgroundProcessIdentity.read(target.identity.pid)) == target.identity
        let nodeImage = proc_pidpath(target.identity.pid, &executable, UInt32(executable.count)) > 0 &&
            String(cString: executable) == target.node
        guard identityMatches, nodeImage else {
            var rejected = Snapshot()
            rejected.identityMatches = identityMatches
            rejected.nodeImage = nodeImage
            return rejected
        }
        return result
    }
}
