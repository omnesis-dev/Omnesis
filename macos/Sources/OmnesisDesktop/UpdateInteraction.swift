// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import DesktopCore
import Foundation

enum DesktopUpdateInteraction {
    static let supported: Set<String> = [
        "verifyDesktopInstaller",
        "verifyCurrentDesktopApplication",
        "stageDesktopInstaller",
        "openDesktopInstaller",
        "stageCurrentDesktopApplication",
        "activateCurrentDesktopApplication",
        "verifyPreviousDesktopApplication",
        "openPreviousDesktopApplication",
    ]

    static func respond(to prompt: RuntimeInteraction, installer: DesktopUpdateInstaller) async throws -> BridgeValue {
        func string(_ key: String) throws -> String {
            guard case .string(let value)? = prompt.payload[key], !value.isEmpty else { throw DesktopUpdateInstaller.Failure.untrusted }
            return value
        }
        switch prompt.kind {
        case "verifyDesktopInstaller":
            let value = try await installer.verify(
                artifactPath: string("artifactPath"),
                artifactHash: string("artifactSha256"),
                oldEpoch: string("oldEpoch"),
                version: string("version"),
                architecture: string("architecture")
            )
            return receipt(value)
        case "verifyCurrentDesktopApplication":
            let value = try await installer.verifyCurrent()
            return receipt(value)
        case "stageDesktopInstaller", "openDesktopInstaller":
            let id = try string("receiptId"), hash = try string("artifactSha256"), old = try string("oldEpoch"),
                candidate = try string("candidateEpoch")
            if prompt.kind == "stageDesktopInstaller" {
                try await installer.stage(receiptID: id, artifactHash: hash, oldEpoch: old, candidateEpoch: candidate)
                return .object(["ready": .bool(true)])
            }
            try await installer.openInstaller(receiptID: id, artifactHash: hash, oldEpoch: old, candidateEpoch: candidate)
            return .object(["opened": .bool(true)])
        case "stageCurrentDesktopApplication", "activateCurrentDesktopApplication":
            let id = try string("receiptId"), old = try string("oldEpoch"), candidate = try string("candidateEpoch")
            if prompt.kind == "stageCurrentDesktopApplication" {
                try await installer.stageCurrent(receiptID: id, oldEpoch: old, candidateEpoch: candidate)
                return .object(["ready": .bool(true)])
            }
            try await installer.activateCurrent(receiptID: id, oldEpoch: old, candidateEpoch: candidate)
            return .object(["opened": .bool(true)])
        case "verifyPreviousDesktopApplication":
            try await installer.verifyPrevious(epoch: string("oldEpoch"), expectedVersion: string("expectedVersion"))
            return .object(["verified": .bool(true)])
        case "openPreviousDesktopApplication":
            try await installer.openPrevious(epoch: string("oldEpoch"), expectedVersion: string("expectedVersion"))
            return .object(["opened": .bool(true)])
        default: throw DesktopUpdateInstaller.Failure.untrusted
        }
    }

    private static func receipt(_ value: DesktopUpdateInstaller.Receipt) -> BridgeValue {
        var values: [String: BridgeValue] = [
            "verified": .bool(true),
            "receiptId": .string(value.id),
            "metadata": value.metadata,
            "candidateEpoch": .string(value.candidateEpoch),
            "payloadBytes": .number(Double(value.payloadBytes)),
            "applicationBytes": .number(Double(value.applicationBytes)),
            "oldApplicationBytes": .number(Double(value.oldApplicationBytes)),
        ]
        if let previous = value.previousMetadata { values["previousMetadata"] = previous
            values["oldEpoch"] = .string(value.oldEpoch)
        }
        return .object(values)
    }
}
