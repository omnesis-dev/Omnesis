// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Darwin
import Foundation
import Security

/// Public code/peer metadata only; this does not query TCC responsibility.
public enum DesktopBackgroundPeerTrust {
    public enum Failure: Error { case untrustedPeer }
    public enum Kind: Equatable, Sendable { case helper, client, observer }
    public struct Peer: Sendable {
        public let pid: Int32
        public let executable: URL
        public let kind: Kind
        public let identity: DesktopBackgroundProcessIdentity
    }

    public static func peer(socket: Int32, kind: Kind, expectedPID: Int32? = nil) throws -> Peer {
        var uid: uid_t = 0, gid: gid_t = 0
        var pid: pid_t = 0
        var size = socklen_t(MemoryLayout<pid_t>.size)
        guard getpeereid(socket, &uid, &gid) == 0, uid == getuid(),
              getsockopt(socket, SOL_LOCAL, LOCAL_PEERPID, &pid, &size) == 0,
              size == socklen_t(MemoryLayout<pid_t>.size), pid > 0,
              expectedPID == nil || expectedPID == pid else { throw Failure.untrustedPeer }
        return try validate(pid: pid, kind: kind)
    }

    public static func observer(pid: Int32) throws -> Peer {
        try validate(pid: pid, kind: .observer)
    }

    public static func helper(pid: Int32) throws -> Peer {
        try validate(pid: pid, kind: .helper)
    }

    public static func helperParent() throws -> Peer {
        try validate(pid: getppid(), kind: .helper)
    }

    private static func validate(pid: Int32, kind: Kind) throws -> Peer {
        let identity = try DesktopBackgroundProcessIdentity.read(pid)
        var own: SecCode?
        guard SecCodeCopySelf([], &own) == errSecSuccess, let own,
              SecCodeCheckValidity(own, [], nil) == errSecSuccess else { throw Failure.untrustedPeer }
        var ownStatic: SecStaticCode?
        guard SecCodeCopyStaticCode(own, [], &ownStatic) == errSecSuccess, let ownStatic else { throw Failure.untrustedPeer }
        var ownInfo: CFDictionary?
        guard SecCodeCopySigningInformation(ownStatic, SecCSFlags(rawValue: kSecCSSigningInformation), &ownInfo) == errSecSuccess,
              let ownValues = ownInfo as? [String: Any], let team = ownValues[kSecCodeInfoTeamIdentifier as String] as? String,
              team.count == 10,
              team.utf8.allSatisfy({ (48 ... 57).contains($0) || (65 ... 90).contains($0) }) else { throw Failure.untrustedPeer }
        let identifier = switch kind {
        case .helper: "dev.omnesis.desktop.background"
        case .client: "dev.omnesis.desktop.runtime-exec"
        case .observer: "dev.omnesis.desktop"
        }
        let text = "anchor apple generic and identifier \"\(identifier)\" and certificate leaf[subject.OU] = \"\(team)\""
        var requirement: SecRequirement?
        guard SecRequirementCreateWithString(text as CFString, [], &requirement) == errSecSuccess,
              let requirement else { throw Failure.untrustedPeer }
        var guest: SecCode?
        let attributes = [kSecGuestAttributePid as String: NSNumber(value: pid)] as CFDictionary
        guard SecCodeCopyGuestWithAttributes(nil, attributes, [], &guest) == errSecSuccess, let guest,
              SecCodeCheckValidity(guest, [], requirement) == errSecSuccess else { throw Failure.untrustedPeer }
        var staticGuest: SecStaticCode?
        guard SecCodeCopyStaticCode(guest, [], &staticGuest) == errSecSuccess, let staticGuest else { throw Failure.untrustedPeer }
        var information: CFDictionary?
        guard SecCodeCopySigningInformation(staticGuest, SecCSFlags(rawValue: kSecCSSigningInformation), &information) == errSecSuccess,
              let values = information as? [String: Any], let reported = values[kSecCodeInfoMainExecutable as String] as? URL,
              reported.isFileURL else { throw Failure.untrustedPeer }
        // This path comes from Security's live code object, not a caller path.
        let executable = try URL(fileURLWithPath: DesktopCanonicalPath.resolve(reported.path))
        switch kind {
        case .helper:
            let suffix = "/Contents/Library/LoginItems/OmnesisBackground.app/Contents/MacOS/OmnesisBackground"
            guard executable.path.hasSuffix(suffix) else { throw Failure.untrustedPeer }
            let application = URL(fileURLWithPath: String(executable.path.dropLast(suffix.count)), isDirectory: true)
            try DesktopRuntimeBootstrap.validateApplication(application)
        case .observer:
            guard executable.path.hasSuffix("/Contents/MacOS/Omnesis") else { throw Failure.untrustedPeer }
            try DesktopRuntimeBootstrap
                .validateApplication(executable.deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent())
        case .client:
            guard executable.lastPathComponent == "runtime-exec", executable.deletingLastPathComponent().lastPathComponent.count == 64,
                  executable.deletingLastPathComponent().lastPathComponent.utf8
                  .allSatisfy({ (48 ... 57).contains($0) || (97 ... 102).contains($0) }) else { throw Failure.untrustedPeer }
        }
        guard try DesktopBackgroundProcessIdentity.read(pid) == identity else { throw Failure.untrustedPeer }
        return Peer(pid: pid, executable: executable, kind: kind, identity: identity)
    }
}
