// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Darwin

/// Metadata for an already-known owned PID, never a process enumeration or TCC responsibility query.
public struct DesktopBackgroundProcessIdentity: Equatable, Sendable {
    public let pid: Int32
    public let parent: Int32
    public let startedSeconds: UInt64
    public let startedMicroseconds: UInt64

    public static func read(_ pid: Int32) throws -> Self {
        let value = try information(pid)
        return Self(
            pid: pid,
            parent: Int32(value.pbi_ppid),
            startedSeconds: value.pbi_start_tvsec,
            startedMicroseconds: value.pbi_start_tvusec
        )
    }

    static func information(_ pid: Int32) throws -> proc_bsdinfo {
        guard pid > 0 else { throw DesktopDataUsageLease.Failure.missingAuthority }
        var result = proc_bsdinfo()
        let size = Int32(MemoryLayout<proc_bsdinfo>.size)
        guard proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &result, size) == size,
              result.pbi_pid == UInt32(pid), result.pbi_uid == getuid() else { throw DesktopDataUsageLease.Failure.missingAuthority }
        return result
    }
}
