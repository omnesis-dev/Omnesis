// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation

// MARK: - Commands from the gateway

@available(iOS 17.0, *)
extension DeviceSocket {
    /// Outcome of running a gateway-originated command locally.
    ///
    /// The gateway validates a successful response's `result` against that
    /// command's schema in `ws-messages.ts` and rejects a payload that doesn't
    /// match, so an ack has to carry the fields its command declares — an
    /// empty object reads as a protocol error, not as "done". A `.failure`
    /// travels as an error envelope instead, which the gateway surfaces as a
    /// structured `WsCommandError` rather than a schema complaint.
    enum CommandOutcome {
        case success(JSONValue)
        case failure(code: String, message: String)
    }

    /// What happened when a gateway-requested sync reached the collector.
    ///
    /// Mirrors the desktop collector's `{ok, triggered, skipped}` acknowledgement
    /// (`packages/collector/src/main.ts`) rather than collapsing to a Bool: an
    /// operator who taps "Sync now" twice, or before the collector exists,
    /// gets an answer that says which of those happened instead of a blanket
    /// success or a misleading "not hosted".
    public enum SyncDispatch: Sendable {
        /// A sync is now running for this source.
        case triggered
        /// The source is hosted here but no sync started — already in flight,
        /// or its collector hasn't been built yet.
        case skipped(reason: String)
        /// No source with this id lives on this device.
        case notHosted
    }

    /// Reply to a gateway-originated command. The gateway's
    /// `sendCommand(deviceId, type, payload)` awaits a response envelope with
    /// a matching `correlationId`; without this, admin APIs like
    /// `GET /admin/sources/:id/debug` time out against iOS-hosted sources.
    func handleIncomingCommand(_ command: WsCommandFrame, via connection: any DeviceSocketConnection) async {
        let outcome = await run(command)

        let response: [String: JSONValue] = switch outcome {
        case .success(let result):
            [
                "kind": .string("response"),
                "correlationId": .string(command.id),
                "ok": .bool(true),
                "result": result,
            ]
        case .failure(let code, let message):
            [
                "kind": .string("response"),
                "correlationId": .string(command.id),
                "ok": .bool(false),
                "error": .object(["code": .string(code), "message": .string(message)]),
            ]
        }

        do {
            try await send(object: response, via: connection)
        } catch {
            log.warning("WS respond failed for command \(command.type, privacy: .public): \(String(describing: error), privacy: .private)")
        }
    }

    func run(_ command: WsCommandFrame) async -> CommandOutcome {
        switch command.type {
        case "source.sync":
            guard let sourceId = Self.sourceId(from: command.payload), !sourceId.isEmpty else {
                return .failure(code: "invalid_payload", message: "source.sync requires a sourceId")
            }
            guard let onSyncRequested else {
                return .failure(code: "unsupported", message: "this device hosts no collector")
            }
            // `triggered` counts syncs started, not finished: a full Apple
            // Health cycle far outruns the gateway's 30s command timeout, so
            // acking on completion would time out every call.
            switch await onSyncRequested(sourceId) {
            case .triggered:
                return .success(.object(["ok": .bool(true), "triggered": .int(1), "skipped": .int(0)]))
            case .skipped(let reason):
                // A valid, honest "nothing started" — the schema carries it, so
                // the operator sees the reason rather than a false success.
                return .success(.object([
                    "ok": .bool(true), "triggered": .int(0), "skipped": .int(1), "error": .string(reason),
                ]))
            case .notHosted:
                return .failure(code: "not_hosted", message: "\(sourceId) is not hosted on this device")
            }

        case "source.added", "source.updated", "sources.snapshot":
            // The gateway owns the source registry and the app re-reads it
            // via `refreshSources()` on reconnect, so this acks receipt
            // without claiming to have applied the delta. See #54.
            return .success(.object(["ok": .bool(true), "applied": .bool(false)]))

        case "source.removed":
            // Removal commands also withdraw local opt-in, including a member
            // detach whose logical source survives on sibling devices.
            eventsContinuation.yield(Event(type: command.type, payload: command.payload))
            return .success(.object(["ok": .bool(true), "applied": .bool(false), "deleted": .array([])]))

        case "source.debug":
            // Minimal: confirm the source id is recognized. Full cursor +
            // stats snapshot can come later — today the app doesn't expose
            // that plumbing to the socket layer.
            let sourceId = Self.sourceId(from: command.payload) ?? ""
            return .success(.object([
                "status": .object([
                    "sourceId": .string(sourceId),
                    "note": .string("Live debug not yet implemented on iOS — source is hosted here"),
                ]),
            ]))

        default:
            // Refuse honestly rather than acking a command we didn't run: a
            // blanket `{ok: true}` would report success for work that never
            // happened.
            return .failure(code: "unsupported", message: "\(command.type) is not handled on iOS")
        }
    }

    static func sourceId(from payload: JSONValue) -> String? {
        guard case .object(let p) = payload, case .string(let sid)? = p["sourceId"] else { return nil }
        return sid
    }
}

// MARK: - Wire envelope (mirrors `packages/core/src/ws-protocol.ts`)

/// A typed gateway-pushed command. Mirrors `WsCommand` on the producer side.
struct WsCommandFrame: Decodable {
    let id: String
    let type: String
    let payload: JSONValue

    init(id: String, type: String, payload: JSONValue) {
        self.id = id
        self.type = type
        self.payload = payload
    }

    enum CodingKeys: String, CodingKey { case id, type, payload }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.id = try c.decode(String.self, forKey: .id)
        self.type = try c.decode(String.self, forKey: .type)
        self.payload = (try? c.decode(JSONValue.self, forKey: .payload)) ?? .null
    }
}

/// A typed gateway-pushed event. Mirrors `WsEvent` on the producer side.
struct WsEventFrame: Decodable {
    let type: String
    let payload: JSONValue

    enum CodingKeys: String, CodingKey { case type, payload }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.type = try c.decode(String.self, forKey: .type)
        self.payload = (try? c.decode(JSONValue.self, forKey: .payload)) ?? .null
    }
}

/// A typed response envelope. Mirrors `WsResponseOk | WsResponseErr` on the
/// producer side: when `ok:true`, `result` is present; when `ok:false`,
/// `error: { code, message }` is present.
struct WsResponseFrame: Decodable {
    let correlationId: String
    let body: Body

    enum Body {
        case ok(result: [String: JSONValue])
        case err(WsResponseError)
    }

    struct WsResponseError: Decodable {
        let code: String
        let message: String
    }

    enum CodingKeys: String, CodingKey { case correlationId, ok, result, error }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.correlationId = try c.decode(String.self, forKey: .correlationId)
        let ok = try c.decode(Bool.self, forKey: .ok)
        if ok {
            // Tolerate a non-object result by falling back to an empty dict.
            let result = (try? c.decode([String: JSONValue].self, forKey: .result)) ?? [:]
            self.body = .ok(result: result)
        } else {
            let err = try c.decode(WsResponseError.self, forKey: .error)
            self.body = .err(err)
        }
    }
}

/// A single inbound WS frame. The `kind` discriminator lives at the top
/// level of the JSON object alongside the rest of the fields (flat
/// shape — see `packages/core/src/ws-protocol.ts`); we read it first and
/// then re-decode the remaining fields into the matching frame type.
enum WsFrame: Decodable {
    case event(WsEventFrame)
    case command(WsCommandFrame)
    case response(WsResponseFrame)

    private enum CodingKeys: String, CodingKey { case kind }
    private enum Kind: String, Decodable { case event, command, response }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let kind = try c.decode(Kind.self, forKey: .kind)
        switch kind {
        case .event: self = try .event(WsEventFrame(from: decoder))
        case .command: self = try .command(WsCommandFrame(from: decoder))
        case .response: self = try .response(WsResponseFrame(from: decoder))
        }
    }
}
