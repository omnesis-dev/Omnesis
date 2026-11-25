// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation

/// Copy signed code with per-entry cancellation and an operation-local delegate.
public enum DesktopCodeCopy {
    public static func copyTree(
        source: URL,
        destination: URL,
        checkCancellation: @escaping @Sendable () throws -> Void = { try Task.checkCancellation() }
    ) throws {
        try checkCancellation()
        let observer = CopyObserver(check: checkCancellation)
        let manager = FileManager()
        manager.delegate = observer
        do { try manager.copyItem(at: source, to: destination) }
        catch { try observer.checkError()
            throw error
        }
        try observer.checkError()
        try checkCancellation()
    }
}

private final class CopyObserver: NSObject, FileManagerDelegate, @unchecked Sendable {
    private let lock = NSLock()
    private let check: @Sendable () throws -> Void
    private var failure: Error?
    init(check: @escaping @Sendable () throws -> Void) {
        self.check = check
    }

    func fileManager(_ fileManager: FileManager, shouldCopyItemAt srcURL: URL, to dstURL: URL) -> Bool {
        lock.lock()
        defer { lock.unlock() }
        if failure != nil { return false }
        do { try check()
            return true
        } catch { failure = error
            return false
        }
    }

    func checkError() throws {
        lock.lock()
        defer { lock.unlock() }
        if let failure { throw failure }
    }
}
