// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation
#if canImport(Darwin)
import Darwin
#else
import Glibc
#endif

/// Authority for one explicitly selected local archive, not a server file path.
public struct DesktopRestoreFileSelection: Encodable, Sendable {
    public let path: String
    public let device: String
    public let inode: String
    public let bytes: Int64
    public let mtimeSeconds: String
    public let mtimeNanoseconds: String

    public static func read(_ url: URL, maxBytes: Int64 = 1_099_511_627_776) throws -> Self {
        guard url.isFileURL, url.query == nil, url.fragment == nil, !url.path.contains("\0"),
              url.path.utf8.count <= 4096, maxBytes > 0,
              try DesktopCanonicalPath.resolve(url.path) == url.path else { throw CocoaError(.fileReadNoPermission) }
        let descriptor = open(url.path, O_RDONLY | O_NOFOLLOW | O_NONBLOCK)
        guard descriptor >= 0 else { throw CocoaError(.fileReadNoSuchFile) }
        defer { close(descriptor) }
        var info = stat()
        guard fstat(descriptor, &info) == 0, info.st_mode & S_IFMT == S_IFREG, info.st_nlink == 1,
              info.st_uid == getuid(), info.st_size > 0, info.st_size <= maxBytes else { throw CocoaError(.fileReadNoPermission) }
        #if canImport(Darwin)
        // libuv publishes the signed Darwin dev_t through uint64_t.
        let device = String(UInt64(bitPattern: Int64(info.st_dev)))
        let seconds = info.st_mtimespec.tv_sec
        let nanoseconds = info.st_mtimespec.tv_nsec
        #else
        let device = String(info.st_dev)
        let seconds = info.st_mtim.tv_sec
        let nanoseconds = info.st_mtim.tv_nsec
        #endif
        guard nanoseconds >= 0, nanoseconds < 1_000_000_000 else { throw CocoaError(.fileReadNoPermission) }
        return Self(
            path: url.path,
            device: device,
            inode: String(info.st_ino),
            bytes: info.st_size,
            mtimeSeconds: String(seconds),
            mtimeNanoseconds: String(nanoseconds)
        )
    }

    public var parameters: [String: BridgeValue] {
        [
            "path": .string(path),
            "device": .string(device),
            "inode": .string(inode),
            "bytes": .number(Double(bytes)),
            "mtimeSeconds": .string(mtimeSeconds),
            "mtimeNanoseconds": .string(mtimeNanoseconds),
        ]
    }
}
