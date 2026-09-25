// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation

#if os(iOS)
private let log = AppLog.make(category: "storage.protection")
#endif

/// iOS data-protection class applied to a store's files, expressed
/// platform-independently so the per-store policy stays testable in the
/// SwiftPM logic lane (which runs on macOS, where file protection does
/// not exist).
///
/// Why an explicit class at all: without one, files get the OS default
/// (`completeUntilFirstUserAuthentication`) — readable at any point
/// after the first unlock following boot, including while the phone
/// sits locked. Corpus-derived stores deserve a passcode-tied class.
/// The trade-off between the two stricter classes is background access:
///
/// - `.complete`: the class key is evicted shortly after the device
///   locks — no reads, no writes while locked. Right for stores that
///   only foreground code touches (the device is necessarily unlocked
///   then). Wrong for anything a background wake touches: HealthKit
///   observer wakes and BGTask runs routinely happen while the device
///   is locked, and under `.complete` every one of those reads AND
///   writes fails.
/// - `.completeUnlessOpen`: new files can still be created while the
///   device is locked (the file key is wrapped with an asymmetric class
///   key whose public half stays available), and files already open at
///   lock time remain usable. A closed file can't be reopened until the
///   next unlock — so background reads of existing files fail while
///   locked and callers must treat that as transient. Right for stores
///   written on background wakes.
///
/// A blanket `NSFileProtectionComplete` app entitlement is deliberately
/// not used: it would stamp `.complete` on the offline buffer too and
/// silently kill background health ingest.
public enum FileProtectionLevel: Sendable, Equatable {
    /// `NSFileProtectionComplete` — inaccessible whenever the device is locked.
    case complete
    /// `NSFileProtectionCompleteUnlessOpen` — locked-time creation and
    /// already-open handles keep working; closed files stay sealed
    /// until the next unlock.
    case completeUnlessOpen
}

/// The file-backed Omnesis stores that persist corpus-derived data,
/// each with a deliberately chosen protection level. A new file-backed
/// store gets a case here (plus an assertion in `FileProtectionTests`)
/// rather than writing with the OS default class.
public enum ProtectedStore: CaseIterable, Sendable, Equatable {
    /// Offline buffer (`Application Support/Omnesis/buffer/`): queued,
    /// ready-to-POST batches — actual corpus payloads (health samples,
    /// photo documents, deletions). Batches are enqueued from HealthKit
    /// background-delivery wakes and BGTask sync runs while the phone
    /// may be locked, so locked-time file creation must keep working →
    /// `.completeUnlessOpen`. The read side (the uploader draining
    /// queued batches) fails while locked; `CollectorCore` already
    /// treats a failed drain as transient and the next unlocked drain
    /// picks the queue back up.
    case offlineBuffer

    /// Photos asset index (`Application Support/Omnesis/photos-index/`):
    /// maps PHAsset local identifiers to the stable external ids they
    /// were pushed under, plus rich-analysis marks. Flushed from the
    /// Photos backfill `BGProcessingTask`, which iOS prefers to run
    /// while the device is idle — typically locked and charging — so
    /// `.complete` would fail every one of those flushes →
    /// `.completeUnlessOpen`. Locked-time loads of the index fail;
    /// `AnalyzedAssetStore` treats an unreadable index as "baseline
    /// unknown" (never as empty) so a locked-time flush cannot wipe it.
    case photosAssetIndex

    /// Pending notes (`Application Support/Omnesis/pending-notes/`):
    /// quick-capture notes queued while the gateway is unreachable.
    /// Notes are user-authored content with no upstream source of truth
    /// (unlike buffered health batches, a dropped note is gone forever),
    /// and the Siri capture intent enqueues them from a background app
    /// launch that can happen while the phone is locked — locked-time
    /// file creation must keep working → `.completeUnlessOpen`. The
    /// read side (draining to the gateway) fails while locked and is
    /// retried on the next foreground.
    case pendingNotes

    /// The protection class this store's files carry.
    public var protectionLevel: FileProtectionLevel {
        switch self {
        case .offlineBuffer: .completeUnlessOpen
        case .photosAssetIndex: .completeUnlessOpen
        case .pendingNotes: .completeUnlessOpen
        }
    }

    /// Every corpus-derived store is excluded from device backups. In
    /// particular, HealthKit-derived batches must never enter iCloud Backup;
    /// notes and photo metadata receive the same conservative treatment.
    public var isExcludedFromBackup: Bool {
        true
    }

    /// Options for every `Data.write(to:options:)` this store performs:
    /// atomic replace plus the store's protection class. On non-iOS
    /// platforms (the SwiftPM logic lane runs on macOS) file protection
    /// does not exist and this degrades to plain `.atomic`.
    public var writingOptions: Data.WritingOptions {
        #if os(iOS)
        switch protectionLevel {
        case .complete: return [.atomic, .completeFileProtection]
        case .completeUnlessOpen: return [.atomic, .completeFileProtectionUnlessOpen]
        }
        #else
        return [.atomic]
        #endif
    }

    /// Stamp this store's protection class onto `directory` and every
    /// item inside it. Stores call this at construction so files
    /// already on disk with a weaker class are upgraded in place, and
    /// so files subsequently created inside the directory (including
    /// the temporary files an atomic write goes through) inherit the
    /// class by default. Best-effort: a failed stamp (e.g. attempted
    /// during a locked-device background launch) is logged and retried
    /// the next time the store is constructed. No-op on non-iOS
    /// platforms and when `directory` does not exist.
    public func applyProtection(toContentsOf directory: URL, fileManager: FileManager = .default) {
        #if os(iOS)
        guard fileManager.fileExists(atPath: directory.path) else { return }
        let attributes: [FileAttributeKey: Any] = [.protectionKey: fileProtectionType]
        var paths = [directory.path]
        if let enumerator = fileManager.enumerator(atPath: directory.path) {
            while let relative = enumerator.nextObject() as? String {
                paths.append((directory.path as NSString).appendingPathComponent(relative))
            }
        }
        var failures = 0
        for path in paths {
            do {
                try fileManager.setAttributes(attributes, ofItemAtPath: path)
            } catch {
                failures += 1
            }
        }
        if failures > 0 {
            let name = directory.lastPathComponent
            let total = paths.count
            log.warning(
                "Protection stamp failed for \(failures, privacy: .public)/\(total, privacy: .public) items in \(name, privacy: .public)"
            )
        }
        #endif
    }

    /// Mark the store directory as excluded from iCloud and computer backups.
    /// The directory-level resource value covers existing contents and files
    /// created below it. Best-effort for the same reason as protection
    /// stamping: a later store construction retries after transient failures.
    @discardableResult
    public func applyBackupExclusion(
        to directory: URL,
        fileManager: FileManager = .default
    )
        -> Bool {
        guard isExcludedFromBackup,
              fileManager.fileExists(atPath: directory.path) else { return false }
        do {
            var values = URLResourceValues()
            values.isExcludedFromBackup = true
            var mutableDirectory = directory
            try mutableDirectory.setResourceValues(values)
            return true
        } catch {
            #if os(iOS)
            log.warning(
                "Backup exclusion failed for \(directory.lastPathComponent, privacy: .public)"
            )
            #endif
            return false
        }
    }

    /// Fail closed before persisting corpus-derived data. This deliberately
    /// retries the resource-value write on every store mutation: a transient
    /// locked-device failure during construction must not disable the privacy
    /// invariant for the actor's entire lifetime.
    public func requireBackupExclusion(
        to directory: URL,
        fileManager: FileManager = .default
    ) throws {
        guard applyBackupExclusion(to: directory, fileManager: fileManager) else {
            throw ProtectedStoreError.backupExclusionFailed(self)
        }
    }

    #if os(iOS)
    private var fileProtectionType: FileProtectionType {
        switch protectionLevel {
        case .complete: .complete
        case .completeUnlessOpen: .completeUnlessOpen
        }
    }
    #endif
}

public enum ProtectedStoreError: Error, Equatable {
    case backupExclusionFailed(ProtectedStore)
}
