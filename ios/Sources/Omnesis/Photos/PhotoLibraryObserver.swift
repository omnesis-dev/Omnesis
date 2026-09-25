// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation
#if canImport(Photos)
import Photos

/// Foreground `PHPhotoLibraryChangeObserver` wrapper — the near-real-time
/// half of the Photos source. It does NOT do its own ingestion: it just
/// (a) requests an authorization-safe whole-library reconcile when removals
/// are observed, and (b) triggers a prompt `syncOne` call on any
/// change, same pattern as `BackgroundDeliveryInstaller` → `HKObserverQuery`
/// for AppleHealth. That triggered sync lands in `PhotosSource`'s
/// `.steady`-phase Recently-Added sweep — the SAME code path the
/// BGProcessingTask backstop uses — which is what makes "enrich exactly
/// once, whichever path reaches it first" true by construction (see
/// `PhotosSource`).
public final class PhotoLibraryObserver: NSObject, @unchecked Sendable {
    private let onChange: @Sendable () -> Void
    private let onRemoval: @Sendable () -> Void

    private let lock = NSLock()
    private var fetchResult: PHFetchResult<PHAsset>?

    public init(
        onChange: @escaping @Sendable () -> Void,
        onRemoval: @escaping @Sendable () -> Void
    ) {
        self.onChange = onChange
        self.onRemoval = onRemoval
    }

    /// Snapshot the current library and start observing. Call once when
    /// the Photos source is enabled; call `uninstall()` when disabled.
    public func install() {
        let options = PHFetchOptions()
        options.includeHiddenAssets = true
        lock.lock()
        fetchResult = PHAsset.fetchAssets(with: .image, options: options)
        lock.unlock()
        PHPhotoLibrary.shared().register(self)
    }

    public func uninstall() {
        PHPhotoLibrary.shared().unregisterChangeObserver(self)
        lock.lock()
        fetchResult = nil
        lock.unlock()
    }
}

extension PhotoLibraryObserver: PHPhotoLibraryChangeObserver {
    public func photoLibraryDidChange(_ changeInstance: PHChange) {
        lock.lock()
        let current = fetchResult
        lock.unlock()
        guard let current, let details = changeInstance.changeDetails(for: current) else { return }

        lock.lock()
        fetchResult = details.fetchResultAfterChanges
        lock.unlock()

        if !details.removedObjects.isEmpty {
            onRemoval()
        }
        onChange()
    }
}
#endif
