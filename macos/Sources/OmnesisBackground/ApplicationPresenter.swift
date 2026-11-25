// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation

/// Watches the exact application launched by this helper, including Finder move/delete coordination.
final class ApplicationPresenter: NSObject, NSFilePresenter, @unchecked Sendable {
    private let lock = NSLock()
    private var location: URL
    private let removed: @Sendable (URL?) -> Void
    init(application: URL, removed: @escaping @Sendable (URL?) -> Void) {
        location = application
        self.removed = removed
        super.init()
        NSFileCoordinator.addFilePresenter(self)
    }

    deinit { NSFileCoordinator.removeFilePresenter(self) }
    var presentedItemURL: URL? {
        lock.lock()
        defer { lock.unlock() }
        return location
    }

    var presentedItemOperationQueue: OperationQueue {
        .main
    }

    func presentedItemDidMove(to newURL: URL) {
        lock.lock()
        location = newURL
        lock.unlock()
        removed(newURL)
    }

    func accommodatePresentedItemDeletion(completionHandler: @escaping (Error?) -> Void) {
        removed(nil)
        completionHandler(nil)
    }
}
