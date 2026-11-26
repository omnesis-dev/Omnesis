// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import CryptoKit
import Foundation

/// Scope identity excludes progress and presence, so routine polling cannot
/// continually cancel a slower access check. The digest is never persisted.
enum DesktopSourcePermissionContext {
    static func digest(sources: [DesktopSource], devices: [DesktopDevice], descriptors: [DesktopDescriptor]) throws -> String {
        let rows: [[String: Any]] = sources.sorted { $0.id < $1.id }.map { source in
            [
                "id": source.id,
                "type": source.type,
                "account": source.accountId,
                "enabled": source.enabled,
                "device": source.deviceId,
                "members": source.members?.sorted() as Any? ?? NSNull(),
                "mode": source.multiDeviceMode as Any? ?? NSNull(),
                "archived": source.archived ?? false,
                "archivedDevices": source.archivedDevices?.map(\.deviceId).sorted() as Any? ?? NSNull(),
                "dormantHosts": source.dormantHosts?.sorted() as Any? ?? NSNull(),
                "joinCandidates": source.joinCandidates?.sorted() as Any? ?? NSNull(),
                "config": source.config?.mapValues(\.jsonValue) as Any? ?? NSNull(),
            ]
        }
        let roster: [[String: Any]] = devices.sorted { $0.id < $1.id }.map {
            ["id": $0.id, "kind": $0.kind, "revoked": $0.revokedAt != nil, "needsPairing": $0.needsPairing ?? false]
        }
        let contracts: [[String: Any]] = descriptors.sorted { $0.id < $1.id }.map { descriptor in
            let requirements: Any = (descriptor.permissionRequirements.map { values in values.map { value -> [String: Any] in
                [
                    "id": value.id,
                    "kind": value.kind.rawValue,
                    "summary": value.summary,
                    "scope": value.scope,
                    "blocking": value.blocking,
                    "actions": value.actions.map { ["kind": $0.kind.rawValue, "category": $0.category?.rawValue as Any? ?? NSNull()] },
                ]
            } } as Any?) ?? NSNull()
            return [
                "id": descriptor.id,
                "requirements": requirements,
                "memberScopedParams": descriptor.memberScopedParamNames?.sorted() as Any? ?? NSNull(),
                "hosts": descriptor.devices?.map(\.id).sorted() as Any? ?? NSNull(),
                "params": descriptor.params?.map { [
                    "name": $0.name,
                    "type": $0.type,
                    "required": $0.required as Any? ?? NSNull(),
                    "scope": $0.scope as Any? ?? NSNull(),
                    "mustExist": $0.mustExist as Any? ?? NSNull(),
                ] } as Any? ?? NSNull(),
            ]
        }
        let data = try JSONSerialization.data(
            withJSONObject: ["sources": rows, "devices": roster, "descriptors": contracts],
            options: [.sortedKeys]
        )
        return SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
    }
}
