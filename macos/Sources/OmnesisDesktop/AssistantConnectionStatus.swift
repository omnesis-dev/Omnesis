// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation
import Observation
import SwiftUI

/// Metadata about permission and authenticated MCP reach, never a successful answer or live presence.
/// The shared access summary omits credential expiry and OAuth identity; retain their presence here.
struct DesktopAssistantAccess: Decodable {
    struct Principal: Decodable {
        let name: String
        let kind: String
        let revokedAt: Stamp
        let grants: [Grant]
        enum CodingKeys: CodingKey { case name, kind, revokedAt, grants }
        init(from decoder: Decoder) throws {
            let values = try decoder.container(keyedBy: CodingKeys.self)
            name = try values.decode(String.self, forKey: .name)
            kind = try values.decode(String.self, forKey: .kind)
            revokedAt = try Stamp.read(values, .revokedAt)
            grants = try values.decode([Grant].self, forKey: .grants)
        }
    }

    struct Grant: Decodable {
        let revokedAt: Stamp
        let expiresAt: Stamp
        let credentials: [Credential]
        enum CodingKeys: CodingKey { case revokedAt, expiresAt, credentials }
        init(from decoder: Decoder) throws {
            let values = try decoder.container(keyedBy: CodingKeys.self)
            revokedAt = try Stamp.read(values, .revokedAt)
            expiresAt = try Stamp.read(values, .expiresAt)
            credentials = try values.decode([Credential].self, forKey: .credentials)
        }
    }

    struct Credential: Decodable {
        let kind: String?
        let oauthClientId: String?
        let status: String?
        let revokedAt: Stamp
        let expiresAt: Stamp
        let lastUsedAt: Stamp
        enum CodingKeys: CodingKey { case kind, oauthClientId, status, revokedAt, expiresAt, lastUsedAt }
        init(from decoder: Decoder) throws {
            let values = try decoder.container(keyedBy: CodingKeys.self)
            kind = try values.decodeIfPresent(String.self, forKey: .kind)
            oauthClientId = try values.decodeIfPresent(String.self, forKey: .oauthClientId)
            status = try values.decodeIfPresent(String.self, forKey: .status)
            revokedAt = try Stamp.read(values, .revokedAt)
            expiresAt = try Stamp.read(values, .expiresAt)
            lastUsedAt = try Stamp.read(values, .lastUsedAt)
        }
    }

    enum Stamp {
        case unknown, none, value(Int64)
        static func read<K: CodingKey>(_ values: KeyedDecodingContainer<K>, _ key: K) throws -> Stamp {
            guard values.contains(key) else { return .unknown }
            if try values.decodeNil(forKey: key) { return .none }
            let value = try values.decode(Int64.self, forKey: key)
            guard value > 0, value <= 8_640_000_000_000_000 else { throw DecodingError.dataCorruptedError(
                forKey: key,
                in: values,
                debugDescription: "Invalid time"
            ) }
            return .value(value)
        }

        func live(now: Int64, expiry: Bool) -> Bool? {
            switch self {
            case .unknown: nil
            case .none: true
            case .value(let value): expiry ? value > now : (value <= now ? false : nil)
            }
        }
    }

    let principals: [Principal]

    enum Progress: Equatable {
        case none, permission, pending, signedIn, reached(Int64), reconnect, unknown
        var text: String {
            switch self {
            case .none: "Connect an assistant when you want to use your library there."
            case .permission: "Permission saved. Finish signing in from your assistant."
            case .pending: "Assistant sign-in is waiting to finish."
            case .signedIn: "Assistant signed in. Its first connection has not been reported yet."
            case .reached: "An assistant has reached Omnesis."
            case .reconnect: "An assistant connection needs signing in again."
            case .unknown: "Assistant connection status could not be confirmed."
            }
        }
    }

    func nextExpiry(after now: Int64) -> Int64? {
        principals.flatMap(\.grants).flatMap { grant in
            [grant.expiresAt] + grant.credentials.map(\.expiresAt)
        }.compactMap { stamp -> Int64? in
            if case .value(let time) = stamp, time > now { return time }
            return nil
        }.min()
    }

    func progress(now: Int64) -> Progress {
        guard !principals.isEmpty else { return .none }
        var observations: [Progress] = []
        for principal in principals {
            guard principal.kind == "interactive" else { observations.append(.unknown)
                continue
            }
            guard principal.revokedAt.live(now: now, expiry: false) == true else {
                observations.append(principal.revokedAt.live(now: now, expiry: false) == false ? .reconnect : .unknown)
                continue
            }
            for grant in principal.grants {
                let valid = [grant.revokedAt.live(now: now, expiry: false), grant.expiresAt.live(now: now, expiry: true)]
                guard valid.allSatisfy({ $0 == true }) else {
                    observations.append(valid.contains(false) ? .reconnect : .unknown)
                    continue
                }
                if grant.credentials.isEmpty { observations.append(.permission) }
                for credential in grant.credentials {
                    // Generic legacy token usage has no MCP-specific meaning.
                    guard credential.kind == "interactive", let client = credential.oauthClientId,
                          !client.isEmpty, client.utf8.count <= 512 else { observations.append(.unknown)
                        continue
                    }
                    let live = [credential.revokedAt.live(now: now, expiry: false), credential.expiresAt.live(now: now, expiry: true)]
                    guard live.allSatisfy({ $0 == true }) else {
                        observations.append(live.contains(false) ? .reconnect : .unknown)
                        continue
                    }
                    if credential.status == "pending" { observations.append(.pending)
                        continue
                    }
                    guard credential.status == "active" else { observations.append(.unknown)
                        continue
                    }
                    switch credential.lastUsedAt {
                    case .value(let used) where used <= now: observations.append(.reached(used))
                    case .none: observations.append(.signedIn)
                    default: observations.append(.unknown)
                    }
                }
            }
        }
        if let used = observations.compactMap({ observation -> Int64? in
            if case .reached(let time) = observation { return time }
            return nil
        }).max() {
            return .reached(used)
        }
        for state in [.signedIn, .pending, .permission, .reconnect] as [Progress] where observations.contains(state) {
            return state
        }
        return .unknown
    }
}

@MainActor @Observable
final class DesktopAssistantConnections {
    private(set) var progress = DesktopAssistantAccess.Progress.unknown
    private(set) var checking = false
    private(set) var failure = false
    private var nextCheck = Duration.seconds(30)
    private var context: DesktopAPIContext?
    private var epoch = UUID()
    private var request: (id: UUID, task: Task<Void, Never>)?
    private var retiring: Task<Void, Never>?

    func bind(_ context: DesktopAPIContext?) {
        guard self.context !== context else { return }
        epoch = UUID()
        let old = request?.task, predecessor = retiring
        old?.cancel()
        retiring = Task { await predecessor?.value
            await old?.value
        }
        request = nil
        self.context = context
        progress = .unknown
        checking = false
        failure = false
        nextCheck = .seconds(30)
    }

    func refresh(context: DesktopAPIContext) async {
        guard self.context === context, context.isCurrent, !Task.isCancelled else { return }
        if let request {
            let task = request.task
            await withTaskCancellationHandler(operation: { await task.value }, onCancel: { task.cancel() })
            return
        }
        let generation = epoch, barrier = retiring, id = UUID()
        checking = true
        let task = Task { @MainActor [weak self] in
            defer {
                if let self, self.epoch == generation, self.request?.id == id {
                    self.request = nil
                    self.checking = false
                }
            }
            await barrier?.value
            guard !Task.isCancelled, context.isCurrent else { return }
            do {
                let snapshot: DesktopAssistantAccess = try await context.request("GET", "admin/access")
                guard let self, self.epoch == generation, context.isCurrent, !Task.isCancelled else { return }
                let now = Int64(Date().timeIntervalSince1970 * 1000)
                self.progress = snapshot.progress(now: now)
                self.nextCheck = .milliseconds(min(30000, max(1, (snapshot.nextExpiry(after: now) ?? (now + 30000)) - now)))
                self.failure = false
            } catch {
                guard let self, self.epoch == generation, context.isCurrent, !Task.isCancelled else { return }
                self.progress = .unknown
                self.nextCheck = .seconds(30)
                self.failure = true
            }
        }
        request = (id, task)
        await withTaskCancellationHandler(operation: { await task.value }, onCancel: { task.cancel() })
    }

    func observe(_ context: DesktopAPIContext?) async {
        guard !Task.isCancelled, context?.isCurrent != false else { return }
        bind(context)
        let generation = epoch
        while !Task.isCancelled, context?.isCurrent == true, epoch == generation {
            if let context { await refresh(context: context) }
            do { try await Task.sleep(for: nextCheck) } catch { break }
        }
        if epoch == generation { await stop() }
    }

    func stop() async {
        bind(nil)
        await retiring?.value
    }
}

struct DesktopAssistantStatusView: View {
    let model: DesktopAssistantConnections
    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(model.checking ? "Checking assistant connections…" : model.progress.text)
            if case .reached(let time) = model.progress, !model.checking {
                Text(
                    "Last reached Omnesis \(Date(timeIntervalSince1970: Double(time) / 1000).formatted()). This confirms a connection, not an answer or that the assistant is online."
                )
                .font(.callout).foregroundStyle(DesktopTheme.secondary)
            }
            if model.failure { Text("Check your library connection and try again.").font(.callout) }
        }.accessibilityIdentifier("assistant-connection-status")
    }
}
