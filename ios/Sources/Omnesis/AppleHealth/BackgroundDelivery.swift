// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation
#if canImport(HealthKit)
import HealthKit

/// Installs HKObserverQuery + enableBackgroundDelivery for every type
/// in the catalog. When HealthKit receives new data, iOS wakes the app
/// (even from Background App Refresh) and calls the supplied handler.
///
/// The handler triggers a collector sync cycle, which rotates through
/// types looking for new samples. Anchors per type ensure we only read
/// what's new; everything else is a cheap no-op.
///
/// Must be set up AFTER the user grants HealthKit authorisation.
/// Calling `enableBackgroundDelivery` before authorization silently
/// does nothing, which wastes the observer.
@available(iOS 17.0, *)
public actor BackgroundDeliveryInstaller {
    private let client: HealthKitClient
    private let catalog: [TypeEntry]
    private let log = AppLog.make(category: "collector.hk-observer")

    private var installedQueries: [HKObserverQuery] = []

    public init(
        client: HealthKitClient = HealthKitClient(),
        catalog: [TypeEntry] = TypeCatalog.v1
    ) {
        self.client = client
        self.catalog = catalog
    }

    /// Install observers for every type. `onNewData` fires (possibly
    /// in the background) each time HealthKit reports new samples.
    /// Deduplicated across types — the handler is the same; the
    /// collector decides which source to sync.
    public func install(onNewData: @escaping @Sendable () async -> Void) async {
        // Uninstall any existing observers first so repeated pairing
        // flows don't leak.
        await uninstall()

        for entry in catalog {
            guard let type = entry.sampleType else { continue }
            let query = client.installObserver(type: type) {
                await onNewData()
            }
            installedQueries.append(query)

            do {
                try await client.enableBackgroundDelivery(for: type, frequency: .immediate)
            } catch {
                log.warning(
                    "enableBackgroundDelivery failed for \(entry.identifier, privacy: .public): \(String(describing: error), privacy: .private)"
                )
            }
        }
        log.notice("Installed \(self.installedQueries.count, privacy: .public) HealthKit observers")
    }

    public func uninstall() async {
        for query in installedQueries {
            client.stop(query)
        }
        installedQueries.removeAll()
    }
}
#endif
