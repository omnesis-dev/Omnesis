// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation

/// A signed runtime must explicitly support the process authority used by this installation.
/// Legacy manifests can still be inspected for retention; this boundary only admits execution.
public enum DesktopProcessAuthorityManifest {
    public enum Failure: LocalizedError {
        case incompatible
        public var errorDescription: String? {
            "Omnesis cannot use this app safely with your library. Choose a compatible current version and review the update again."
        }
    }

    private struct Manifest: Decodable {
        let format: Int
        let processAuthorityProtocol: Int
    }

    public static func require(_ data: Data) throws {
        guard data.count <= 32 * 1024 * 1024,
              let manifest = try? JSONDecoder().decode(Manifest.self, from: data),
              manifest.format == 1, manifest.processAuthorityProtocol == 3 else { throw Failure.incompatible }
    }
}
