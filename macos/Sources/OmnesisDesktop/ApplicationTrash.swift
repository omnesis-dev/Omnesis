// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import AppKit
import Darwin
import DesktopCore
import ServiceManagement

@MainActor
enum DesktopApplicationTrash {
    /// Invoked only by the person's final, separate Trash confirmation.
    static func removeCurrentApplication(after outcome: DesktopRemovalOutcome) async throws {
        let app = try target(after: outcome, application: Bundle.main.bundleURL, identifier: Bundle.main.bundleIdentifier)
        let before = try identity(app)
        try await Task.detached(priority: .userInitiated) {
            try DesktopRuntimeBootstrap.validateApplication(app)
        }.value
        guard try identity(app) == before, app.resolvingSymlinksInPath() == app else {
            throw CocoaError(.fileWriteNoPermission)
        }
        let service = SMAppService.loginItem(identifier: "dev.omnesis.desktop.background")
        if service.status == .enabled || service.status == .requiresApproval { try await service.unregister() }
        let result = try await NSWorkspace.shared.recycle([app])
        guard result[app] != nil else { throw CocoaError(.fileWriteUnknown) }
        NSApp.terminate(nil)
    }

    private static func identity(_ app: URL) throws -> [UInt64] {
        var info = stat()
        guard lstat(app.path, &info) == 0, info.st_mode & S_IFMT == S_IFDIR else { throw CocoaError(.fileWriteNoPermission) }
        return [UInt64(bitPattern: Int64(info.st_dev)), UInt64(info.st_ino)]
    }

    static func target(after outcome: DesktopRemovalOutcome, application: URL, identifier: String?) throws -> URL {
        let app = application.standardizedFileURL
        guard outcome.finished, app.isFileURL, identifier == "dev.omnesis.desktop", app.pathExtension == "app",
              app.resolvingSymlinksInPath() == app else { throw CocoaError(.fileWriteNoPermission) }
        return app
    }
}
