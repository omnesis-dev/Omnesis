// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation
#if canImport(Darwin)
import Darwin
#else
import Glibc
#endif

/// A new owner-readable file. Failure removes only this operation's own inode.
public final class PrivateSaveFile: @unchecked Sendable {
    private let lock = NSLock()
    private let url: URL
    private let handle: FileHandle
    private let identity: stat
    private var finished = false
    private var closed = false

    public init(url: URL) throws {
        self.url = url
        let descriptor = open(url.path, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, 0o600)
        guard descriptor >= 0 else { throw CocoaError(.fileWriteFileExists) }
        var identity = stat()
        guard fstat(descriptor, &identity) == 0 else {
            _ = close(descriptor)
            throw CocoaError(.fileWriteUnknown)
        }
        self.identity = identity
        handle = FileHandle(fileDescriptor: descriptor, closeOnDealloc: true)
    }

    deinit { discard() }

    public func append(_ data: Data) throws {
        lock.lock()
        defer { lock.unlock() }
        guard !closed else { throw CocoaError(.fileWriteUnknown) }
        try handle.write(contentsOf: data)
    }

    public func finish() throws {
        lock.lock()
        defer { lock.unlock() }
        guard !closed else { throw CocoaError(.fileWriteUnknown) }
        try handle.synchronize()
        // Check while our descriptor still pins the inode; a replacement is never this save.
        var destination = stat()
        guard lstat(url.path, &destination) == 0,
              destination.st_mode & S_IFMT == S_IFREG,
              destination.st_dev == identity.st_dev, destination.st_ino == identity.st_ino else {
            throw CocoaError(.fileWriteUnknown, userInfo: [
                NSLocalizedDescriptionKey: "The save location changed before saving finished. Choose a location and try again.",
            ])
        }
        try handle.close()
        closed = true
        finished = true
    }

    public func discard() {
        lock.lock()
        defer { lock.unlock() }
        guard !finished else { return }
        if !closed { try? handle.close()
            closed = true
        }
        var current = stat()
        if lstat(url.path, &current) == 0, current.st_dev == identity.st_dev, current.st_ino == identity.st_ino {
            _ = unlink(url.path)
        }
    }
}
