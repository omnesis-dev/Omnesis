// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation
import Observation

@MainActor @Observable
final class DesktopSourceFlow {
    let descriptor: DesktopDescriptor
    let api: DesktopAPI
    var deviceId: String
    var params: [String: String] = [:]
    var credentials: [String: String] = [:]
    var accounts: [String] = []
    var selectedAccounts: Set<String> = []
    var flowId: String?
    var auth: AuthSnapshot?
    var answer: [String: String] = [:]
    var error: String?
    var busy = false
    var complete = false
    private var observation: Task<Void, Never>?

    init(descriptor: DesktopDescriptor, api: DesktopAPI) {
        self.descriptor = descriptor
        self.api = api
        let hosts = descriptor.devices ?? []
        deviceId = hosts.first(where: { $0.id == api.connection.collectorDeviceId })?.id ?? hosts.first?.id ?? ""
    }

    func begin() async {
        guard !deviceId.isEmpty else { error = "No connected Mac can add this source yet."
            return
        }
        busy = true
        error = nil
        defer { busy = false }
        do {
            for param in descriptor.params ?? [] {
                let value = params[param.name] ?? ""
                guard param.required != true || !value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
                    throw DesktopAPIError.message("Enter \(param.label.lowercased()).")
                }
                struct Validation: Decodable { let valid: Bool
                    let error: String?
                }
                let result: Validation = try await api.request("POST", "admin/sources/validate-param", body: [
                    "descriptorId": descriptor.id, "deviceId": deviceId, "paramName": param.name, "value": value,
                ])
                if !result.valid { throw DesktopAPIError.message(result.error ?? "Check \(param.label.lowercased()).") }
            }
            if let spec = descriptor.credentials, !credentials.isEmpty, spec.perAccount != true {
                try await api.mutate(
                    "POST",
                    "admin/credentials/\(pathPart(spec.fileKey))",
                    body: ["deviceId": deviceId, "fields": credentials]
                )
            }
            if descriptor.hasAuthFlow {
                struct Started: Decodable { let flowId: String }
                var body: [String: Any] = [
                    "sourceType": descriptor.id,
                    "deviceId": deviceId,
                    "params": params,
                    "renders": ["redirect", "code", "qr", "fields", "wait"],
                ]
                if descriptor.credentials?.perAccount == true { body["credentials"] = credentials }
                let result: Started = try await api.request("POST", "admin/auth-flows", body: body)
                flowId = result.flowId
                credentials = [:]
                watch()
            } else if descriptor.hasDiscover {
                struct Discovered: Decodable { let accounts: [String] }
                let result: Discovered = try await api.request(
                    "POST",
                    "admin/sources/discover",
                    body: ["descriptorId": descriptor.id, "deviceId": deviceId]
                )
                accounts = result.accounts
                selectedAccounts = Set(accounts)
                if accounts.isEmpty { error = "No accounts were found on this Mac. Check the source’s settings and try again." }
            } else if descriptor.hasResolveAccountId == true {
                struct Resolved: Decodable { let accountId: String }
                let result: Resolved = try await api.request(
                    "POST",
                    "admin/sources/resolve-account",
                    body: ["descriptorId": descriptor.id, "deviceId": deviceId, "params": params]
                )
                accounts = [result.accountId]
                selectedAccounts = Set(accounts)
                try await addAccounts()
            } else {
                throw DesktopAPIError
                    .message("This source needs a setup step that is available in advanced settings. Open the web portal to continue.")
            }
        } catch { self.error = error.localizedDescription }
    }

    func add() async {
        busy = true
        error = nil
        defer { busy = false }
        do { try await addAccounts() } catch { self.error = error.localizedDescription }
    }

    private func addAccounts() async throws {
        guard !selectedAccounts.isEmpty else { throw DesktopAPIError.message("Choose at least one account.") }
        let existing = try await api.sources()
        for account in selectedAccounts.sorted() {
            if let source = existing.first(where: { $0.type == descriptor.id && $0.accountId == account }) {
                if source.deviceId == deviceId || source.members?.contains(deviceId) == true { continue }
                guard let mode = source.multiDeviceMode, ["handoff", "replicated", "partitioned"].contains(mode) else {
                    throw DesktopAPIError
                        .message("This source is already connected on another device. Use advanced setup if you want to move it.")
                }
                let localNames = Set(descriptor.memberScopedParamNames ?? [])
                let memberParams = params.filter { localNames.contains($0.key) }
                var body: [String: Any] = ["deviceId": deviceId]
                if !memberParams.isEmpty { body["memberConfig"] = ["params": memberParams] }
                try await api.mutate("POST", "admin/sources/\(pathPart(source.id))/members", body: body)
            } else {
                try await api.mutate(
                    "POST",
                    "admin/sources/add",
                    body: ["descriptorId": descriptor.id, "deviceId": deviceId, "accountIds": [account], "params": params]
                )
            }
        }
        complete = true
    }

    private func watch() {
        observation?.cancel()
        observation = Task { [weak self] in
            guard let self, let flowId else { return }
            while !Task.isCancelled {
                do {
                    let next: AuthSnapshot = try await api.request("GET", "admin/auth-flows/\(pathPart(flowId))")
                    let changed = next.pendingChallenge?.id != auth?.pendingChallenge?.id
                    auth = next
                    if changed { answer = next.pendingChallenge?.challenge.prefill ?? [:] }
                    if next.state == "completed" {
                        accounts = next.resolvedAccountIds ?? next.resolvedAccountId.map { [$0] } ?? []
                        selectedAccounts = Set(accounts)
                        try await addAccounts()
                        return
                    }
                    if next.state == "error" { error = next.errorMessage ?? "Sign-in could not finish. Try again."
                        return
                    }
                    try await Task.sleep(for: .seconds(1))
                } catch is CancellationError { return }
                catch { if !Task.isCancelled { self.error = error.localizedDescription }
                    return
                }
            }
        }
    }

    func submitAnswer() async {
        guard let flowId, let challenge = auth?.pendingChallenge else { return }
        busy = true
        defer { busy = false }
        do {
            let value: [String: Any] = switch challenge.challenge.kind {
            case "redirect": ["url": answer["url"] ?? ""]
            case "code": ["code": answer["code"] ?? ""]
            default: answer
            }
            try await api.mutate(
                "POST",
                "admin/auth-flows/\(pathPart(flowId))/answer",
                body: ["challengeId": challenge.id, "answer": value]
            )
            answer = [:]
        } catch { self.error = error.localizedDescription }
    }

    func cancel() async {
        observation?.cancel()
        observation = nil
        guard let flowId, !complete else { return }
        do {
            try await api.mutate("POST", "admin/auth-flows/\(pathPart(flowId))/cancel")
            self.flowId = nil
            auth = nil
        } catch { self.error = error.localizedDescription }
    }
}

func pathPart(_ value: String) -> String {
    value.addingPercentEncoding(withAllowedCharacters: .alphanumerics) ?? ""
}

struct AuthSnapshot: Decodable {
    let state: String
    let errorMessage: String?
    let authUrl: URL?
    let qrData: String?
    let resolvedAccountId: String?
    let resolvedAccountIds: [String]?
    let pendingChallenge: Pending?
    struct Pending: Decodable {
        let id: String
        let expectsAnswer: Bool
        let challenge: Challenge
    }

    struct Challenge: Decodable {
        let kind: String
        let title: String
        let instructions: String?
        let url: URL?
        let data: String?
        let fields: [DesktopDescriptor.Param]?
        let prefill: [String: String]?
    }
}
