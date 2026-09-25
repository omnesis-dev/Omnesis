// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation

/// Per-user Photos source preferences. Lives in `UserDefaults.standard`
/// so it survives app relaunches but is wiped on uninstall. Mirrors
/// `HealthSettings`'s shape (same `KeyValueDefaults` seam for testing).
public struct PhotosSettings: Sendable {
    public enum Keys {
        /// User has opted in to the Photos source (post-pairing flow).
        /// Drives whether the gateway registers a `photos:<account>`
        /// source row + whether the collector instantiates `PhotosSource`.
        public static let enabled = "omnesis.photos.enabled"
        /// ISO-8601 timestamp of when the source was last enabled.
        /// Recorded for display/diagnostics; rich-analysis eligibility is
        /// decided entirely by `AnalyzedAssetStore` (has this asset been
        /// richly analyzed yet), not by this watermark.
        public static let enabledAt = "omnesis.photos.enabledAt"
        /// ISO-8601 timestamp of the last whole-library reconcile pass
        /// (the deletion backstop). Throttled to at most once/day — see
        /// `AppStore.runPhotosBackfillTask`, the sole reader/writer of
        /// this key.
        public static let lastReconcileAt = "omnesis.photos.lastReconcileAt"
        public static let accessState = "omnesis.photos.accessState"
        public static let accessEpoch = "omnesis.photos.accessEpoch"
    }

    private let defaults: KeyValueDefaults

    public init(defaults: KeyValueDefaults = UserDefaults.standard) {
        self.defaults = defaults
    }

    public var enabled: Bool {
        get { (defaults.object(forKey: Keys.enabled) as? Bool) ?? false }
        nonmutating set { defaults.set(newValue, forKey: Keys.enabled) }
    }

    public var enabledAt: Date? {
        get {
            (defaults.string(forKey: Keys.enabledAt)).flatMap { ISO8601DateFormatter().date(from: $0) }
        }
        nonmutating set {
            if let newValue {
                defaults.set(ISO8601DateFormatter().string(from: newValue), forKey: Keys.enabledAt)
            } else {
                defaults.removeObject(forKey: Keys.enabledAt)
            }
        }
    }

    public var lastReconcileAt: Date? {
        get {
            (defaults.string(forKey: Keys.lastReconcileAt)).flatMap { ISO8601DateFormatter().date(from: $0) }
        }
        nonmutating set {
            if let newValue {
                defaults.set(ISO8601DateFormatter().string(from: newValue), forKey: Keys.lastReconcileAt)
            } else {
                defaults.removeObject(forKey: Keys.lastReconcileAt)
            }
        }
    }

    public var lastAccessState: PhotosAccessState? {
        get { defaults.string(forKey: Keys.accessState).flatMap(PhotosAccessState.init(rawValue:)) }
        nonmutating set {
            if let newValue {
                defaults.set(newValue.rawValue, forKey: Keys.accessState)
            } else {
                defaults.removeObject(forKey: Keys.accessState)
            }
        }
    }

    public var accessEpoch: Int {
        get { (defaults.object(forKey: Keys.accessEpoch) as? Int) ?? 0 }
        nonmutating set { defaults.set(newValue, forKey: Keys.accessEpoch) }
    }

    /// Persist one observed authorization transition. Returning true means a
    /// previously scoped/inaccessible library became complete and the source
    /// must replay its full baseline under the new epoch.
    @discardableResult
    public func observeAccess(_ current: PhotosAccessState) -> Bool {
        // A missing state is also an upgrade boundary. Existing installs can
        // already have a steady epoch-0 cursor created before access epochs
        // existed, so the first observed Full grant must force one safe replay.
        let restored = current.isComplete && (lastAccessState?.isComplete != true)
        if restored {
            accessEpoch += 1
        }
        lastAccessState = current
        return restored
    }

    public func recordReconcile(_ outcome: PhotosSource.ReconcileOutcome, at date: Date = Date()) {
        guard outcome == .performed else { return }
        lastReconcileAt = date
    }

    /// Enable the source, stamping `enabledAt` only the FIRST time (a
    /// disable/re-enable cycle keeps the original watermark).
    public func enable(now: Date = Date()) {
        // Detaching a partition removes its gateway history, while the local
        // analysis index survives. Replay that index under a fresh generation
        // on re-enable, including when Photos access remains Limited.
        if !enabled {
            accessEpoch += 1
            lastReconcileAt = nil
        }
        enabled = true
        if enabledAt == nil {
            enabledAt = now
        }
    }

    public func disable() {
        enabled = false
    }

    /// Wipe pairing-scoped settings. The access epoch is intentionally
    /// monotonic across unpair/re-pair because the on-device analyzed-asset
    /// index also survives unpair; resetting only one side would make records
    /// from a higher epoch impossible to mark current after re-pairing.
    public func reset() {
        defaults.removeObject(forKey: Keys.enabled)
        defaults.removeObject(forKey: Keys.enabledAt)
        defaults.removeObject(forKey: Keys.lastReconcileAt)
        defaults.removeObject(forKey: Keys.accessState)
    }
}

/// Orders a Photos authorization callback so a restored Full grant advances
/// the cursor epoch and rebuilds the collector before health is published and
/// syncing resumes.
@available(iOS 17.0, *)
@MainActor
enum PhotosPermissionTransitionCoordinator {
    static func authorizationChanged(
        access: PhotosAccessState,
        settings: PhotosSettings,
        rebuild: () async -> Void,
        refresh: () async -> Void,
        sync: () async -> Void
    ) async {
        let previous = settings.lastAccessState
        if settings.observeAccess(access) {
            await rebuild()
        }
        if previous != access {
            await refresh()
        }
        await sync()
    }
}
