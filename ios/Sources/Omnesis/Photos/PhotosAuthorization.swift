// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation

public enum PhotosAccessState: String, Codable, Sendable, Equatable {
    case notDetermined
    case restricted
    case denied
    case limited
    case full

    public var isReadable: Bool {
        self == .limited || self == .full
    }

    public var isComplete: Bool {
        self == .full
    }
}

#if canImport(Photos)
import Photos

/// Thin wrapper around `PHPhotoLibrary`'s authorization API. There is
/// no read-only `PHAccessLevel` — `.readWrite` is the level that grants
/// read access (`.addOnly` is a write-only level for save-to-library
/// apps); this source never calls a PhotoKit write API, it only reads.
public enum PhotosAuthorization {
    public static var isAvailable: Bool {
        true
    }

    public static var isAuthorized: Bool {
        current.isReadable
    }

    public static var current: PhotosAccessState {
        map(PHPhotoLibrary.authorizationStatus(for: .readWrite))
    }

    /// Shows the Photos prompt when access is undecided and returns whether
    /// photos can be read afterwards.
    @MainActor
    @discardableResult
    public static func requestAuthorization() async -> Bool {
        // iOS only shows its prompt while access is undecided.
        let status = await SystemPromptActivity.shared.during(current == .notDetermined) {
            await PHPhotoLibrary.requestAuthorization(for: .readWrite)
        }
        return map(status).isReadable
    }

    public static func map(_ status: PHAuthorizationStatus) -> PhotosAccessState {
        switch status {
        case .notDetermined: .notDetermined
        case .restricted: .restricted
        case .denied: .denied
        case .limited: .limited
        case .authorized: .full
        @unknown default: .restricted
        }
    }
}
#endif
