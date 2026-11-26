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

    @MainActor private static var attempted = false

    @MainActor
    static func collect(target: Target?, captureReady: @Sendable () -> Bool) async -> String {
        guard !attempted else { return "postFailureSample=false" }
        attempted = true
        guard let target else { return "postFailureSample=true,targetCaptured=false" }
        let readyBefore = captureReady()
        let before = snapshot(target)
        do { try await Task.sleep(for: .milliseconds(250)) }
        catch { return "postFailureSample=true,interrupted=true; before[\(before.summary)]" }
        let after = snapshot(target)
        let readyAfter = captureReady()
        let comparable = before.identityMatches && after.identityMatches && before.nodeImage && after.nodeImage &&
            before.taskRead && after.taskRead
        return "postFailureSample=true,targetCaptured=true,interrupted=false; before[\(before.summary)]; after[\(after.summary)]; cpuComparable=\(comparable),userAdvanced=\(comparable && after.userTime > before.userTime),systemAdvanced=\(comparable && after.systemTime > before.systemTime),captureReadyBefore=\(readyBefore),captureReadyAfter=\(readyAfter)"
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
