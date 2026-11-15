// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation
import Observation

/// A device that reached the gateway through the owner's Tailscale network
/// and waits for the owner to let it join, as `GET /admin/tailscale/join-requests`
/// lists it.
public struct TailscaleJoinRequest: Decodable, Equatable, Identifiable, Sendable {
    public let id: String
    /// The name the device asked to join under.
    public let name: String
    /// The device kind it would join as (`collector`, `cli`, …).
    public let kind: String
    /// The Tailscale machine the request came from.
    public let machine: String?
    public let os: String?
    /// The Tailscale account signed in on that machine.
    public let login: String?
    public let requestedAt: Date
    public let expiresAt: Date

    public init(
        id: String,
        name: String,
        kind: String,
        machine: String?,
        os: String?,
        login: String?,
        requestedAt: Date,
        expiresAt: Date
    ) {
        self.id = id
        self.name = name
        self.kind = kind
        self.machine = machine
        self.os = os
        self.login = login
        self.requestedAt = requestedAt
        self.expiresAt = expiresAt
    }

    private enum CodingKeys: String, CodingKey {
        case id, name, kind, machine, os, login, requestedAt, expiresAt
    }

    public init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        id = try values.decode(String.self, forKey: .id)
        name = try values.decode(String.self, forKey: .name)
        kind = try values.decode(String.self, forKey: .kind)
        machine = try values.decodeIfPresent(String.self, forKey: .machine)
        os = try values.decodeIfPresent(String.self, forKey: .os)
        login = try values.decodeIfPresent(String.self, forKey: .login)
        requestedAt = try Self.date(values, .requestedAt)
        expiresAt = try Self.date(values, .expiresAt)
    }

    /// The gateway writes ISO 8601 timestamps with milliseconds; one without is read too.
    private static func date(_ values: KeyedDecodingContainer<CodingKeys>, _ key: CodingKeys) throws -> Date {
        let raw = try values.decode(String.self, forKey: key)
        let fractional = ISO8601DateFormatter()
        fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let date = fractional.date(from: raw) ?? ISO8601DateFormatter().date(from: raw) {
            return date
        }
        throw DecodingError.dataCorruptedError(forKey: key, in: values, debugDescription: "not an ISO 8601 date: \(raw)")
    }
}

/// The owner's answer the gateway recorded for a join request.
public enum TailscaleJoinDecision: String, Decodable, Equatable, Sendable {
    case approved
    case denied
}

/// The admin routes behind the Tailscale requests in Waiting for your OK. `AdminClient` speaks them.
public protocol TailscaleJoinDeciding: Sendable {
    /// Throws `GatewayClient.Error.notFound` from a gateway that does not run its own Tailscale device.
    func tailscaleJoinRequests() async throws -> [TailscaleJoinRequest]
    /// Throws `GatewayClient.Error.notFound` when the request has expired or was decided.
    func decideTailscaleJoin(requestId: String, approve: Bool) async throws -> TailscaleJoinDecision
}

/// The words of a device waiting to join through Tailscale, as Waiting for your OK lists it
/// beside the devices that signed in.
public enum TailscaleJoinPresentation {
    /// What every Tailscale request says it came through, beside its kind.
    public static let via = "via Tailscale"
    public static let recognise = "Approve only if you recognise this machine and Tailscale account."
    public static let gone = "That request has expired or was already decided."
    public static let expired = "Expired"
    public static let approve = "Approve"
    public static let deny = "Deny"

    /// "Collector · via Tailscale": what joins, and how it asked.
    public static func kindLine(_ request: TailscaleJoinRequest) -> String {
        "\(DeviceKindMeta.label(request.kind)) · \(via)"
    }

    /// "On maya-laptop · macOS", or nil when the gateway named no machine.
    public static func machineLine(_ request: TailscaleJoinRequest) -> String? {
        guard let machine = nonEmpty(request.machine) else { return nil }
        guard let os = nonEmpty(request.os) else { return "On \(machine)" }
        return "On \(machine) · \(os)"
    }

    /// "Tailscale account maya@example.com", or nil when the gateway named none.
    public static func accountLine(_ request: TailscaleJoinRequest) -> String? {
        nonEmpty(request.login).map { "Tailscale account \($0)" }
    }

    /// "Requested 5 minutes ago", relative to `now`. Under a minute, and for a phone clock a
    /// little behind the gateway's, "Requested just now".
    public static func requestedLine(_ request: TailscaleJoinRequest, now: Date) -> String {
        guard now.timeIntervalSince(request.requestedAt) >= 60 else { return "Requested just now" }
        return "Requested \(relative(request.requestedAt, now: now))"
    }

    /// "Requested 4 minutes ago · Expires in 6 minutes", or nil once the request has run out.
    public static func timingLine(_ request: TailscaleJoinRequest, now: Date) -> String? {
        guard !isExpired(request, now: now) else { return nil }
        return "\(requestedLine(request, now: now)) · Expires \(relative(request.expiresAt, now: now))"
    }

    public static func isExpired(_ request: TailscaleJoinRequest, now: Date) -> Bool {
        request.expiresAt <= now
    }

    private static func relative(_ date: Date, now: Date) -> String {
        let formatter = RelativeDateTimeFormatter()
        formatter.unitsStyle = .full
        return formatter.localizedString(for: date, relativeTo: now)
    }

    private static func nonEmpty(_ value: String?) -> String? {
        guard let trimmed = value?.trimmingCharacters(in: .whitespacesAndNewlines), !trimmed.isEmpty else { return nil }
        return trimmed
    }
}

/// The Tailscale half of Waiting for your OK: the requests the gateway lists, and one
/// decision at a time on them.
@MainActor
@Observable
public final class TailscaleJoinRequestsModel {
    public private(set) var requests: [TailscaleJoinRequest] = []
    /// True once a read has finished, so an empty list reads as "none waiting"
    /// rather than as loading.
    public private(set) var loaded = false
    public private(set) var busy = false
    /// The request a decision is being sent for.
    public private(set) var deciding: String?
    /// Why the list or a decision failed. Cleared by the next attempt.
    public private(set) var error: Error?
    /// A short note shown above the list, for a request that was gone when decided.
    public private(set) var notice: String?
    private var generation = UUID()

    public init() {}

    public func refresh(client: any TailscaleJoinDeciding) async {
        guard !busy else { return }
        busy = true
        await load(client: client)
        busy = false
    }

    public func decide(_ request: TailscaleJoinRequest, approve: Bool, client: any TailscaleJoinDeciding) async {
        guard !busy, requests.contains(request) else { return }
        busy = true
        deciding = request.id
        error = nil
        notice = nil
        let operation = generation
        defer {
            if operation == generation {
                busy = false
                deciding = nil
            }
        }
        do {
            _ = try await client.decideTailscaleJoin(requestId: request.id, approve: approve)
            guard operation == generation else { return }
            requests.removeAll { $0.id == request.id }
        } catch GatewayClient.Error.notFound {
            guard operation == generation else { return }
            // Expired, or decided on another device: say so, and show what still waits.
            notice = TailscaleJoinPresentation.gone
            requests.removeAll { $0.id == request.id }
            await load(client: client)
        } catch {
            guard operation == generation else { return }
            self.error = error
        }
    }

    /// Forget everything; a read or decision still in flight lands nowhere.
    public func stop() {
        generation = UUID()
        requests = []
        loaded = false
        busy = false
        deciding = nil
        error = nil
        notice = nil
    }

    private func load(client: any TailscaleJoinDeciding) async {
        let operation = generation
        do {
            let incoming = try await client.tailscaleJoinRequests()
            guard operation == generation else { return }
            requests = incoming.sorted { $0.requestedAt < $1.requestedAt }
            error = nil
        } catch GatewayClient.Error.notFound {
            // A gateway without its own Tailscale device has no such list: nothing waits.
            guard operation == generation else { return }
            requests = []
            error = nil
        } catch {
            guard operation == generation else { return }
            self.error = error
        }
        loaded = true
    }
}
