// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

#if os(iOS)
import Foundation
import WidgetKit

/// App-side lifecycle for the widget's isolated pairing authority. Demo builds
/// have no shared-group Info key and never publish their pairing to widgets.
@MainActor
public enum TaskWidgetAppBridge {
    public static func configure(pairing: Pairing?) {
        guard Bundle.main.object(forInfoDictionaryKey: "OmnesisTaskWidgetAccessGroup") is String else { return }
        let value = pairing.map {
            TaskWidgetCredential(
                url: $0.url,
                token: $0.token,
                deviceId: $0.deviceId,
                generation: $0.pairingGeneration,
                tlsMode: $0.tlsMode.rawValue,
                fingerprint: $0.fingerprint
            )
        }
        do {
            let old = try TaskWidgetStorage.credential()
            try TaskWidgetStorage.configure(value)
            if old != value { reload() }
        } catch {
            // A locked/unavailable Keychain leaves the existing timeline alone;
            // the next foreground pairing reconciliation retries publication.
        }
    }

    public static func clear() {
        guard Bundle.main.object(forInfoDictionaryKey: "OmnesisTaskWidgetAccessGroup") is String else { return }
        try? TaskWidgetStorage.clear()
        reload()
    }

    public static func reload() {
        WidgetCenter.shared.reloadTimelines(ofKind: TaskWidgetIdentity.kind)
    }
}
#endif
