// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import AppKit
import Foundation
import ServiceManagement

/// The embedded observer also runs when launch-at-login is disabled. It does not register a login item.
@MainActor
public enum DesktopBackgroundObserver {
    public enum StartupBlock: Error, Equatable, Sendable {
        case approvalRequired
        case helperUnavailable
        case ownerMismatch
        case originRequired
    }

    public static func openHelper(appBundle: URL, arguments: [String] = []) async throws -> NSRunningApplication {
        let helper = appBundle.appendingPathComponent("Contents/Library/LoginItems/OmnesisBackground.app")
        guard FileManager.default.fileExists(atPath: helper.appendingPathComponent("Contents/Info.plist").path) else {
            throw StartupBlock.helperUnavailable
        }
        let configuration = NSWorkspace.OpenConfiguration()
        configuration.activates = false
        configuration.hides = true
        configuration.createsNewApplicationInstance = false
        configuration.arguments = arguments
        let opened: NSRunningApplication
        do {
            opened = try await NSWorkspace.shared.openApplication(at: helper, configuration: configuration)
        } catch {
            throw startupBlock(approvalRequired: SMAppService.loginItem(identifier: "dev.omnesis.desktop.background")
                .status == .requiresApproval)
        }
        return opened
    }

    public static func ensureRunning(
        appBundle: URL,
        runtime: URL? = nil,
        ownership: (@MainActor (DesktopBackgroundApplicationOrigin.Evidence) -> Void)? = nil
    ) async throws {
        let opened = try await openHelper(appBundle: appBundle)
        let pid = opened.processIdentifier
        do {
            let selected = try runtime ?? DesktopRuntimeBootstrap.prepare(appBundle: appBundle)
            let before = try DesktopBackgroundProcessIdentity.read(pid)
            let check = Task.detached(priority: .userInitiated) {
                let profile = try DesktopBackgroundManagedProfile.current()
                let request = DesktopBackgroundLaunchProtocol.Request(
                    action: .hello, binding: profile.binding, expectedEpoch: selected.lastPathComponent
                )
                let reply = try DesktopBackgroundControlClient.exchange(request, expectedPID: pid)
                guard try DesktopBackgroundProcessIdentity.read(pid) == before else {
                    throw StartupBlock.helperUnavailable
                }
                guard try DesktopBackgroundManagedProfile.current() == profile else { throw StartupBlock.ownerMismatch }
                return reply
            }
            let reply = try await withTaskCancellationHandler {
                try await check.value
            } onCancel: { check.cancel() }
            try Task.checkCancellation()
            if let evidence = reply.applicationOwnership {
                ownership?(.init(
                    state: evidence.state,
                    codeEpoch: evidence.codeEpoch,
                    originEpoch: evidence.originEpoch,
                    presentation: evidence.presentation,
                    installation: evidence.installation,
                    installationId: reply.binding.instance
                ))
            }
            try requireOwnedOrigin(reply)
        } catch is CancellationError { throw CancellationError() }
        catch let blocked as StartupBlock { throw blocked }
        catch { throw StartupBlock.helperUnavailable }
    }

    static func requireOwnedOrigin(_ reply: DesktopBackgroundLaunchProtocol.Reply) throws {
        try requireMatchingOwner(reply.state)
        guard reply.applicationOwnership?.state == .verified,
              reply.originStatus?.state == .verified else { throw StartupBlock.originRequired }
    }

    /// Called only after the signed peer, selected PID/birth and nonce-bound HELLO are verified.
    static func requireMatchingOwner(_ state: DesktopBackgroundLaunchProtocol.State) throws {
        switch state {
        case .helperIdle, .daemonOwned: return
        case .scopeMismatch, .epochMismatch: throw StartupBlock.ownerMismatch
        case .originRequired: throw StartupBlock.originRequired
        case .lifecycleBlocked, .ownerUnavailable, .ownerVerified, .ownerReleased, .originAttached: throw StartupBlock.helperUnavailable
        }
    }

    static func startupBlock(approvalRequired: Bool) -> StartupBlock {
        approvalRequired ? .approvalRequired : .helperUnavailable
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
