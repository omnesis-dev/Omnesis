// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import CryptoKit
import Foundation
import XCTest

/// The synthetic gateway a journey drives the app against.
///
/// `scripts/run-mobile-journeys.sh ios` boots it and hands its address, admin
/// token and TLS leaf fingerprint to the on-simulator test runner through
/// `TEST_RUNNER_OMNESIS_JOURNEY_CONFIG` (xcodebuild strips the prefix). The
/// token only ever belongs to that throwaway gateway. The helper talks to the
/// gateway directly to set a journey up — minting a pairing code, reading back
/// what the app did — and never stands in for the app itself.
struct JourneyGateway {
    let url: URL
    let token: String
    let fingerprint: String

    private struct Config: Decodable {
        let gatewayURL: String
        let token: String
        let fingerprint: String
    }

    /// Reads the configuration the journey script supplies. A journey run
    /// without it fails rather than skipping: the journeys exist to be run
    /// against a gateway, and a silent skip would read as a pass.
    static func fromEnvironment() throws -> JourneyGateway {
        guard let raw = ProcessInfo.processInfo.environment["OMNESIS_JOURNEY_CONFIG"],
              let data = raw.data(using: .utf8)
        else {
            throw JourneyGatewayError.missingConfiguration
        }
        let config = try JSONDecoder().decode(Config.self, from: data)
        guard let url = URL(string: config.gatewayURL) else {
            throw JourneyGatewayError.invalidConfiguration(config.gatewayURL)
        }
        return JourneyGateway(url: url, token: config.token, fingerprint: config.fingerprint.lowercased())
    }

    /// `host:port` as the pairing confirmation sheet shows it.
    var hostAndPort: String {
        "\(url.host ?? ""):\(url.port ?? 443)"
    }

    /// The launch-environment pairing the DEBUG app seeds into its Keychain
    /// (`DEMO_PAIRING_JSON`), for journeys that start from a paired app. The
    /// credential is a real iPhone device's: the journey mints a pairing code
    /// and redeems it the way the app's pairing exchange does, so the app runs
    /// as a paired phone rather than with the gateway's admin token.
    func automationPairingJSON(deviceName: String) throws -> String {
        let pending = try post("/admin/devices/pair", body: ["kind": "ios", "name": deviceName])
        guard let code = pending["pairingCode"] as? String else {
            throw JourneyGatewayError.unexpectedResponse("/admin/devices/pair")
        }
        let paired = try request("POST", "/devices/pair", body: ["pairingCode": code], authorized: false)
        guard let deviceToken = paired["token"] as? String,
              let device = paired["device"] as? [String: Any],
              let deviceId = device["id"] as? String
        else {
            throw JourneyGatewayError.unexpectedResponse("/devices/pair")
        }
        let object: [String: String] = [
            "url": url.absoluteString,
            "token": deviceToken,
            "deviceId": deviceId,
            "fingerprint": fingerprint,
            "tlsMode": "pinned-leaf",
            "name": "Journey Gateway",
        ]
        let data = try JSONSerialization.data(withJSONObject: object, options: [.sortedKeys])
        return String(data: data, encoding: .utf8) ?? "{}"
    }

    /// Access-level setup must use the same genuinely paired owner as the app.
    func ownerGateway(pairingJSON: String) throws -> JourneyGateway {
        let object = try JSONSerialization.jsonObject(with: Data(pairingJSON.utf8)) as? [String: Any]
        guard object?["url"] as? String == url.absoluteString,
              (object?["fingerprint"] as? String)?.lowercased() == fingerprint,
              object?["tlsMode"] as? String == "pinned-leaf",
              let deviceId = object?["deviceId"] as? String, !deviceId.isEmpty,
              let deviceToken = object?["token"] as? String, !deviceToken.isEmpty else {
            throw JourneyGatewayError.unexpectedResponse("paired owner configuration")
        }
        return JourneyGateway(url: url, token: deviceToken, fingerprint: fingerprint)
    }

    /// Mints a one-time iPhone pairing code and returns the QR payload the
    /// gateway would show for it, pinned to the gateway's own certificate.
    func mintPairingPayload(deviceName: String) throws -> String {
        let pending = try post("/admin/devices/pair", body: ["kind": "ios", "name": deviceName])
        guard let code = pending["pairingCode"] as? String else {
            throw JourneyGatewayError.unexpectedResponse("/admin/devices/pair")
        }
        let qr = try post(
            "/admin/devices/pair-qr",
            body: ["pairingCode": code, "gatewayUrl": url.absoluteString, "trustMode": "pinned-leaf"]
        )
        guard let payload = qr["qrPayload"] as? String else {
            throw JourneyGatewayError.unexpectedResponse("/admin/devices/pair-qr")
        }
        return payload
    }

    /// Whether the gateway lists a live device of `kind` with this name.
    func hasDevice(named name: String, kind: String) throws -> Bool {
        let page = try request("GET", "/admin/devices", body: nil)
        let items = page["items"] as? [[String: Any]] ?? []
        return items.contains { item in
            item["name"] as? String == name && item["kind"] as? String == kind
        }
    }

    /// Real collector metadata and owner API setup for the folder picker journey.
    func prepareFolderScrollLevel() throws -> (id: String, name: String, sourceId: String) {
        let deadline = Date().addingTimeInterval(90)
        var sourceId: String?
        while Date() < deadline {
            let overview = try request("GET", "/admin/access", body: nil)
            guard (overview["sourceFilters"] as? [String: Any])?["enabled"] as? Bool == true else {
                throw JourneyGatewayError.unexpectedResponse("source filter authoring is not enabled")
            }
            let sources = overview["sources"] as? [[String: Any]] ?? []
            if let source = sources.first(where: { ($0["id"] as? String)?.hasPrefix("google-drive:") == true }),
               let id = source["id"] as? String,
               let readiness = source["scopeReadiness"] as? [[String: Any]],
               readiness.contains(where: { $0["kind"] as? String == "folder" && $0["ready"] as? Bool == true }) {
                sourceId = id
                break
            }
            Thread.sleep(forTimeInterval: 0.2)
        }
        guard let sourceId else { throw JourneyGatewayError.timedOut("Drive folder readiness") }
        let first = try folderOptions(sourceId: sourceId)
        guard let items = first["items"] as? [[String: Any]], items.count == 50,
              let cursor = first["nextCursor"] as? String else {
            throw JourneyGatewayError.unexpectedResponse("folder catalogue first50")
        }
        let second = try folderOptions(sourceId: sourceId, cursor: cursor)
        guard let remaining = second["items"] as? [[String: Any]], remaining.count == 15,
              second["nextCursor"] == nil else {
            throw JourneyGatewayError.unexpectedResponse("folder catalogue final15")
        }
        guard (items + remaining).compactMap({ $0["label"] as? String }) == (0 ..< 65).map({ String(format: "Journey folder %03d", $0) })
        else {
            throw JourneyGatewayError.unexpectedResponse("ordered collector folder catalogue")
        }
        let name = "Folder gesture \(UUID().uuidString.prefix(8))"
        let rule: [String: Any] = ["capability": "direct", "sources": ["mode": "allowlist", "sourceIds": [sourceId]]]
        let result = try request("POST", "/admin/access/levels", body: [
            "name": name,
            "rules": [rule],
        ])
        guard let level = result["level"] as? [String: Any], let id = level["id"] as? String else {
            throw JourneyGatewayError.unexpectedResponse("create folder gesture level")
        }
        return (id, name, sourceId)
    }

    func hasSelectedFolder(levelId: String, sourceId: String, folderId: String) throws -> Bool {
        let overview = try request("GET", "/admin/access", body: nil)
        let levels = overview["levels"] as? [[String: Any]] ?? []
        let level = levels.first { $0["id"] as? String == levelId }
        let rules = level?["rules"] as? [[String: Any]] ?? []
        guard rules.count == 1, let direct = rules.first, direct["capability"] as? String == "direct",
              let boundary = direct["sources"] as? [String: Any], boundary["mode"] as? String == "allowlist",
              boundary["sourceIds"] as? [String] == [sourceId],
              let policies = direct["scopePolicies"] as? [[String: Any]], policies.count == 1,
              let policy = policies.first, policy["sourceId"] as? String == sourceId,
              let audience = policy["audience"] as? [String: Any], audience.count == 2,
              audience["accessLevel"] as? String == levelId, audience["capability"] as? String == "direct" else { return false }
        let decisions = policy["rules"] as? [[String: Any]] ?? []
        let refs = decisions.flatMap { $0["match"] as? [[String: Any]] ?? [] }
        return policy["otherwise"] as? String == "hide" && decisions.count == 1 && decisions[0]["action"] as? String == "share"
            && refs.count == 1 && refs[0].count == 2 && refs[0]["kind"] as? String == "folder" && refs[0]["id"] as? String == folderId
    }

    private func folderOptions(sourceId: String, cursor: String? = nil) throws -> [String: Any] {
        var components = URLComponents()
        components.path = "/admin/access/source-filters/\(sourceId)/options"
        components.queryItems = [.init(name: "kind", value: "folder"), .init(name: "parentId", value: "journey-folders-root")]
        if let cursor { components.queryItems?.append(.init(name: "cursor", value: cursor)) }
        return try request("GET", components.string!, body: nil)
    }

    private func post(_ path: String, body: [String: String]) throws -> [String: Any] {
        try request("POST", path, body: body)
    }

    private func request(
        _ method: String,
        _ path: String,
        body: [String: Any]?,
        authorized: Bool = true
    ) throws
        -> [String: Any] {
        guard let endpoint = URL(string: path, relativeTo: url) else {
            throw JourneyGatewayError.invalidConfiguration(path)
        }
        var request = URLRequest(url: endpoint)
        request.httpMethod = method
        request.timeoutInterval = 30
        if authorized {
            request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }
        if let body {
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = try JSONSerialization.data(withJSONObject: body)
        }
        let session = URLSession(
            configuration: .ephemeral,
            delegate: PinnedLeafDelegate(fingerprint: fingerprint),
            delegateQueue: nil
        )
        defer { session.finishTasksAndInvalidate() }

        var outcome: Result<(Data, URLResponse), Error>?
        let done = DispatchSemaphore(value: 0)
        session.dataTask(with: request) { data, response, error in
            if let data, let response {
                outcome = .success((data, response))
            } else {
                outcome = .failure(error ?? JourneyGatewayError.unexpectedResponse(path))
            }
            done.signal()
        }.resume()
        guard done.wait(timeout: .now() + 45) == .success, let outcome else {
            throw JourneyGatewayError.timedOut(path)
        }
        let (data, response) = try outcome.get()
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        guard (200 ..< 300).contains(status) else {
            let text = String(data: data, encoding: .utf8) ?? ""
            throw JourneyGatewayError.httpStatus(path, status, text)
        }
        return try (JSONSerialization.jsonObject(with: data) as? [String: Any]) ?? [:]
    }
}

enum JourneyGatewayError: Error, CustomStringConvertible {
    case missingConfiguration
    case invalidConfiguration(String)
    case unexpectedResponse(String)
    case timedOut(String)
    case httpStatus(String, Int, String)

    var description: String {
        switch self {
        case .missingConfiguration:
            "OMNESIS_JOURNEY_CONFIG is not set. Run the journeys through scripts/run-mobile-journeys.sh ios."
        case .invalidConfiguration(let url):
            "The journey configuration names an invalid gateway URL: \(url)"
        case .unexpectedResponse(let path):
            "The gateway answered \(path) without the expected fields."
        case .timedOut(let path):
            "The gateway did not answer \(path) in time."
        case .httpStatus(let path, let status, let body):
            "The gateway answered \(path) with HTTP \(status): \(body)"
        }
    }
}

/// Trusts exactly the gateway's self-signed leaf certificate, the way a
/// paired app does, so the setup calls never disable certificate checks.
private final class PinnedLeafDelegate: NSObject, URLSessionDelegate {
    private let fingerprint: String

    init(fingerprint: String) {
        self.fingerprint = fingerprint
    }

    func urlSession(
        _ session: URLSession,
        didReceive challenge: URLAuthenticationChallenge,
        completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void
    ) {
        guard challenge.protectionSpace.authenticationMethod == NSURLAuthenticationMethodServerTrust,
              let trust = challenge.protectionSpace.serverTrust,
              let leaf = (SecTrustCopyCertificateChain(trust) as? [SecCertificate])?.first
        else {
            completionHandler(.cancelAuthenticationChallenge, nil)
            return
        }
        let digest = SHA256.hash(data: SecCertificateCopyData(leaf) as Data)
            .map { String(format: "%02x", $0) }
            .joined()
        if digest == fingerprint {
            completionHandler(.useCredential, URLCredential(trust: trust))
        } else {
            completionHandler(.cancelAuthenticationChallenge, nil)
        }
    }
}
