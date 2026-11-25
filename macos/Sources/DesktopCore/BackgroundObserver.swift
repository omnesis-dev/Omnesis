// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import AppKit
import Foundation

/// The embedded observer also runs when launch-at-login is disabled. It does not register a login item.
@MainActor
public enum DesktopBackgroundObserver {
    public static func ensureRunning(appBundle: URL) async throws {
        let helper = appBundle.appendingPathComponent("Contents/Library/LoginItems/OmnesisBackground.app")
        guard FileManager.default.fileExists(atPath: helper.appendingPathComponent("Contents/Info.plist").path) else {
            throw CocoaError(.fileNoSuchFile)
        }
        let configuration = NSWorkspace.OpenConfiguration()
        configuration.activates = false
        configuration.hides = true
        configuration.createsNewApplicationInstance = false
        _ = try await NSWorkspace.shared.openApplication(at: helper, configuration: configuration)
    }
}

/// Pure containment policy: ordinary moves preserve service; only the user's actual Trash is terminal.
public enum DesktopApplicationLocation {
    public static func isInTrash(_ application: URL, trash: URL) -> Bool {
        let parent = trash.standardizedFileURL.pathComponents
        let child = application.standardizedFileURL.pathComponents
        return child.count > parent.count && Array(child.prefix(parent.count)) == parent
    }
}
