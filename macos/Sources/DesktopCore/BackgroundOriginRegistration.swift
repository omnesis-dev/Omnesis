// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation

/// One attachment has one immutable callback identity. Verification runs off the UI/presenter queue.
public final class DesktopBackgroundOriginRegistration: NSObject, NSFilePresenter, @unchecked Sendable {
    public let id = UUID()
    private let lock = NSLock()
    private var location: URL
    private var registered = true
    private var generation: UInt64 = 0
    private var verifiedGeneration: UInt64?
    private let observed: @Sendable (UUID, UInt64, URL?) -> Void
    private let queue: OperationQueue = {
        let value = OperationQueue()
        value.maxConcurrentOperationCount = 1
        value.qualityOfService = .utility
        return value
    }()

    public init(application: URL, observed: @escaping @Sendable (UUID, UInt64, URL?) -> Void) {
        location = application
        self.observed = observed
        super.init()
        NSFileCoordinator.addFilePresenter(self)
    }

    public var presentedItemURL: URL? {
        lock.lock()
        defer { lock.unlock() }
        return location
    }

    public var presentedItemOperationQueue: OperationQueue {
        queue
    }

    public var isVerified: Bool {
        lock.lock()
        defer { lock.unlock() }
        return registered && verifiedGeneration == generation
    }

    public func isCurrent(event: UInt64) -> Bool {
        lock.lock()
        defer { lock.unlock() }
        return registered && generation == event
    }

    public func verify(_ record: DesktopBackgroundApplicationOrigin.Record) throws -> URL {
        try verify(record, archiveRoot: DesktopApplicationArchive.defaultRoot, validate: DesktopRuntimeBootstrap.validateApplication)
    }

    func verify(_ record: DesktopBackgroundApplicationOrigin.Record, archiveRoot: URL, validate: (URL) throws -> Void) throws -> URL {
        lock.lock()
        let expected = location, attempt = generation, active = registered
        lock.unlock()
        guard active else { throw DesktopBackgroundApplicationOrigin.Failure.changedObject }
        var succeeded = false
        defer {
            if !succeeded { lock.lock()
                if verifiedGeneration == attempt { verifiedGeneration = nil }
                lock.unlock()
            }
        }
        let expectedCanonical = try DesktopCanonicalPath.resolve(expected.path)
        var result: Result<URL, Error>?
        var coordinationError: NSError?
        let coordinator = NSFileCoordinator(filePresenter: self)
        coordinator.coordinate(readingItemAt: expected, options: .withoutChanges, error: &coordinationError) { coordinated in
            do {
                let resolved = try DesktopBackgroundApplicationOrigin.resolve(record, archiveRoot: archiveRoot, validate: validate)
                guard try DesktopCanonicalPath.resolve(coordinated.path) == expectedCanonical,
                      resolved.path == expectedCanonical else { throw DesktopBackgroundApplicationOrigin.Failure.changedObject }
                self.lock.lock()
                let matches = self.registered && self.generation == attempt && self.location.path == expected.path
                if matches { self.verifiedGeneration = attempt }
                self.lock.unlock()
                guard matches else { throw DesktopBackgroundApplicationOrigin.Failure.changedObject }
                result = .success(resolved)
            } catch { result = .failure(error) }
        }
        if let coordinationError { throw coordinationError }
        guard let result else { throw DesktopBackgroundApplicationOrigin.Failure.changedObject }
        let resolved = try result.get()
        succeeded = true
        return resolved
    }

    public func presentedItemDidMove(to newURL: URL) {
        changed(newURL)
    }

    public func presentedItemDidChange() {
        changed(presentedItemURL)
    }

    public func accommodatePresentedItemDeletion(completionHandler: @escaping (Error?) -> Void) {
        changed(nil)
        completionHandler(nil)
    }

    private func changed(_ newURL: URL?) {
        lock.lock()
        guard registered else { lock.unlock()
            return
        }
        if let newURL { location = newURL }
        generation &+= 1
        verifiedGeneration = nil
        let event = generation
        lock.unlock()
        observed(id, event, newURL)
    }

    public func stop() {
        lock.lock()
        guard registered else { lock.unlock()
            return
        }
        registered = false
        generation &+= 1
        verifiedGeneration = nil
        lock.unlock()
        NSFileCoordinator.removeFilePresenter(self)
    }

    deinit { stop() }
}
