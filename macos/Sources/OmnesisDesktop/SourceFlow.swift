// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import DesktopCore
import Foundation
import Observation

@MainActor @Observable
final class DesktopSourceFlow {
    private(set) var descriptor: DesktopDescriptor
    let advertisedHosts: [DesktopDescriptor.Host]
    private(set) var descriptorDeviceId: String?
    private(set) var needsDescriptorReview = false
    var isCurrentAPI: (() -> Bool)?
    let api: DesktopAPI
    var deviceId: String {
        didSet {
            if oldValue != deviceId {
                generation += 1
                busy = false
                descriptorDeviceId = nil
                observation?.cancel()
                observation = nil
                invalidateCollectionAccess()
            }
        }
    }

    var params: [String: String] = [:] {
        didSet { if oldValue != params { invalidateCollectionAccess() } }
    }

    var credentials: [String: String] = [:]
    var accounts: [String] = []
    var selectedAccounts: Set<String> = []
    var flowId: String?
    var auth: AuthSnapshot?
    var answer: [String: String] = [:]
    var error: String?
    var busy = false
    var complete = false
    var needsCredentials = false
    var credentialsStep = 0
    var gatewayOrigin: String?
    var notices: [AuthSnapshot.Notice] = []
    var pendingMove: DesktopSourceSettingsSnapshot?
    var keptPausedAfterMove = false
    let access = DesktopCollectionAccessFlow()
    var needsAccess = false
    private var unverifiedAccessChoices: Set<String> = []
    let movingSource: DesktopSource?
    private var processedAccounts: Set<String> = []
    private var moveAttemptedAccounts: Set<String> = []
    private let existingAccountId: String?
    private let targetHostId: String?
    private let repairSourceId: String?
    private var credentialsCollected = false
    private var sharedCredentialsSaved = false
    private var freshAccountRequested = false
    private var generation = 0
    private var retryAvailableAt: Date?
    private var observation: Task<Void, Never>?
    private var presentationCleanup: Task<Void, Never>?

    init(
        descriptor: DesktopDescriptor,
        api: DesktopAPI,
        accountId: String? = nil,
        hostId: String? = nil,
        movingSource: DesktopSource? = nil,
        repairSourceId: String? = nil
    ) {
        self.descriptor = descriptor
        advertisedHosts = descriptor.devices ?? []
        self.api = api
        existingAccountId = accountId
        targetHostId = hostId
        self.movingSource = movingSource
        self.repairSourceId = repairSourceId
        let hosts = descriptor.devices ?? []
        if let hostId {
            // An explicitly targeted member must never turn into a sibling's sign-in.
            deviceId = hosts.contains(where: { $0.id == hostId }) ? hostId : ""
        } else {
            deviceId = hosts.first(where: { $0.id == api.connection.collectorDeviceId })?.id ?? hosts.first?.id ?? ""
        }
    }

    private func requireRepairTarget(_ current: Int) async throws {
        if let repairSourceId { try await api.requireSourceRepair(repairSourceId, deviceId: deviceId) }
        try check(current)
    }

    private var selectedParams: [String: String] {
        let names = Set((descriptor.params ?? []).map(\.name))
        return params.filter { names.contains($0.key) }
    }

    private var selectedCredentials: [String: String] {
        let names = Set((descriptor.credentials?.fields ?? []).map(\.name))
        return credentials.filter { names.contains($0.key) }
    }

    private func bindSelectedDescriptor(_ current: Int, requireUnchanged: Bool = false) async throws {
        try check(current)
        let selected = deviceId
        let roster = try await api.devices()
        try check(current)
        guard selected == deviceId, roster.contains(where: { $0.id == selected && $0.revokedAt == nil && $0.needsPairing != true }) else {
            throw DesktopAPIError
                .message("The selected computer is no longer available for this source. Review its connection and try again.")
        }
        let fresh = try await api.descriptor(id: descriptor.id, deviceId: selected)
        try check(current)
        guard selected == deviceId else { throw CancellationError() }
        let changed = descriptor != fresh || (descriptorDeviceId != nil && descriptorDeviceId != selected)
        let wasBound = descriptorDeviceId != nil
        if changed {
            descriptor = fresh
            descriptorDeviceId = selected
            credentialsCollected = false
            sharedCredentialsSaved = false
            needsCredentials = false
            access.invalidateEvidenceKeepingDenial()
            unverifiedAccessChoices = []
        }
        descriptor = fresh
        descriptorDeviceId = selected
        if requireUnchanged, wasBound, changed {
            needsDescriptorReview = true
            throw DesktopAPIError
                .message("Source settings changed on the selected computer. Review the updated settings before connecting.")
        }
    }

    func prepareSelectedDevice() async {
        guard !descriptor.hasCompanionGuide else { return }
        guard isCurrentAPI?() != false else { return }
        guard !busy, !deviceId.isEmpty, descriptorDeviceId != deviceId else { return }
        busy = true
        let current = generation
        defer { if generation == current { busy = false } }
        do { try await bindSelectedDescriptor(current) }
        catch is CancellationError {} catch { if current == generation { self.error = error.localizedDescription } }
    }

    func invalidatePresentation() {
        generation += 1
        observation?.cancel()
        observation = nil
        access.invalidateSelection()
        descriptorDeviceId = nil
        busy = false
        credentials = [:]
        let previous = flowId
        flowId = nil
        auth = nil
        if let previous {
            let joining = presentationCleanup
            let api = api
            presentationCleanup = Task {
                await joining?.value
                try? await api.mutate("POST", "admin/auth-flows/\(pathPart(previous))/cancel")
            }
        }
    }

    func expand(_ text: String) -> String {
        text.replacingOccurrences(of: "{gatewayOrigin}", with: gatewayOrigin ?? "{gatewayOrigin}")
    }

    func begin() async {
        guard !descriptor.hasCompanionGuide else { return }
        guard isCurrentAPI?() != false else { return }
        guard !needsDescriptorReview else { return }
        guard !busy, !complete else { return }
        guard !deviceId.isEmpty else { error = "No connected device can add this source yet."
            return
        }
        busy = true
        error = nil
        let current = generation
        defer { if generation == current { busy = false } }
        do {
            try await bindSelectedDescriptor(current)
            guard !descriptor.hasCompanionGuide else { return }
            try await requireRepairTarget(current)
            for param in descriptor.params ?? [] {
                let value = params[param.name] ?? ""
                guard param.required != true || !value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
                    throw DesktopAPIError.message("Enter \(param.label.lowercased()).")
                }
                if value.isEmpty, param.validateWhenEmpty != true { continue }
                try SourceValidation.pattern(value, pattern: param.pattern, hint: param.patternHint, label: param.label)
                if param.type == "select", param.options?.contains(where: { $0.value == value }) != true {
                    throw DesktopAPIError.message("Choose an available \(param.label.lowercased()).")
                }
                struct Validation: Decodable { let valid: Bool
                    let error: String?
                }
                let result: Validation = try await api.request("POST", "admin/sources/validate-param", body: [
                    "descriptorId": descriptor.id, "deviceId": deviceId, "paramName": param.name, "value": value,
                ])
                try check(current)
                if !result.valid { throw DesktopAPIError.message(result.error ?? "Check \(param.label.lowercased()).") }
            }
            guard try await checkCollectionAccess(current, account: existingAccountId) else { return }
            if try await collectCredentialsIfNeeded(current) { return }
            try check(current)
            // Existing brokered/local accounts are offered before starting a fresh sign-in.
            if descriptor.hasDiscover, existingAccountId == nil, !freshAccountRequested {
                do {
                    struct Discovered: Decodable { let accounts: [String] }
                    let result: Discovered = try await api.request("POST", "admin/sources/discover", body: [
                        "descriptorId": descriptor.id, "deviceId": deviceId,
                    ])
                    try check(current)
                    let existing = try await api.sources()
                    try check(current)
                    let proven = (descriptor.params ?? []).compactMap { param -> String? in
                        guard !(params[param.name] ?? "").isEmpty else { return nil }
                        return param.provesLocalAvailabilityForAccount
                    }
                    accounts = Array(Set(result.accounts + proven)).sorted().filter { account in
                        !existing
                            .contains {
                                $0.type == descriptor.id && $0.accountId == account && $0
                                    .enabled && ($0.deviceId == deviceId || $0.members?.contains(deviceId) == true)
                            }
                    }
                    selectedAccounts = Set(accounts)
                    if !accounts.isEmpty { return }
                    if !descriptor.hasAuthFlow {
                        throw DesktopAPIError.message(result.accounts.isEmpty
                            ? "No accounts were found on this device. Check the source’s settings and try again."
                            : "These accounts are already connected on this device.")
                    }
                } catch is CancellationError { throw CancellationError() }
                catch { if !descriptor.hasAuthFlow { throw error } }
            }
            try check(current)
            if descriptor.hasAuthFlow {
                try await startAuthentication(current)
            } else {
                if descriptor.hasResolveAccountId == true {
                    struct Resolved: Decodable { let accountId: String }
                    let result: Resolved = try await api.request("POST", "admin/sources/resolve-account", body: [
                        "descriptorId": descriptor.id, "deviceId": deviceId, "params": selectedParams,
                    ])
                    try check(current)
                    accounts = [result.accountId]
                } else { accounts = ["local"] }
                selectedAccounts = Set(accounts)
                try await addAccounts(current)
            }
        } catch is CancellationError {}
        catch { if generation == current { self.error = error.localizedDescription } }
    }

    private func check(_ current: Int) throws {
        guard generation == current, !Task.isCancelled, isCurrentAPI?() != false else { throw CancellationError() }
    }

    private func collectCredentialsIfNeeded(_ current: Int) async throws -> Bool {
        guard !descriptor.hasCompanionGuide else { throw DesktopAPIError.message("Open companion setup to continue.") }
        guard let spec = descriptor.credentials else { return false }
        if credentialsCollected {
            if spec.perAccount != true, !sharedCredentialsSaved {
                try await requireRepairTarget(current)
                try await api.mutate(
                    "POST",
                    "admin/credentials/\(pathPart(spec.fileKey))",
                    body: ["deviceId": deviceId, "fields": selectedCredentials]
                )
                try check(current)
                credentials = [:]
                sharedCredentialsSaved = true
            }
            return false
        }
        guard spec.required == true || spec.perAccount == true else { return false }
        struct Entry: Decodable {
            let fileKey: String
            let configured: Bool
            let brokeredAccounts: [String]?
        }
        let status: DesktopAPI.Rows<Entry> = try await api.request("GET", "admin/credentials?deviceId=\(pathPart(deviceId))")
        try check(current)
        let entry = status.items.first { $0.fileKey == spec.fileKey }
        if spec.perAccount != true, entry?.configured == true { return false }
        if !freshAccountRequested, let brokered = entry?.brokeredAccounts, !brokered.isEmpty {
            let existing = try await api.sources()
            try check(current)
            if brokered
                .contains(where: { account in
                    !existing.contains(where: { $0.type == descriptor.id && $0.accountId == account })
                }) { return false }
        }
        // The collector remains authoritative if a legacy gateway omits this entry.
        guard entry != nil else { return false }
        if spec.fields
            .contains(where: { ($0.default ?? "").contains("{gatewayOrigin}") || ($0.placeholder ?? "").contains("{gatewayOrigin}") }) ||
            spec.wizard?.steps.contains(where: { $0.body.contains("{gatewayOrigin}") }) == true {
            struct Config: Decodable { let config: Body
                struct Body: Decodable { let gateway: Gateway? }
                struct Gateway: Decodable { let publicBaseUrl: String? }
            }
            let config: Config = try await api.request("GET", "admin/config")
            try check(current)
            gatewayOrigin = SourceValidation.publicOrigin(config.config.gateway?.publicBaseUrl)
            if gatewayOrigin == nil {
                struct Account: Decodable {
                    let publicOrigin: String?
                    let account: Link?
                    struct Link: Decodable { let linked: Bool }
                }
                let status: Account = try await api.request("GET", "admin/cloud-relay")
                try check(current)
                if status.account?.linked == true { gatewayOrigin = SourceValidation.publicOrigin(status.publicOrigin) }
            }
            guard gatewayOrigin != nil
            else {
                throw DesktopAPIError
                    .message(
                        "This provider needs your library’s public address. Connect your Omnesis account in Settings before continuing."
                    )
            }
        }
        for field in spec.fields where credentials[field.name] == nil {
            if let value = field.default { credentials[field.name] = expand(value) }
        }
        needsCredentials = true
        credentialsStep = 0
        return true
    }

    func selectHost(_ id: String) {
        guard targetHostId == nil, !busy, flowId == nil, deviceId != id else { return }
        deviceId = id
        credentials = [:]
        credentialsCollected = false
        sharedCredentialsSaved = false
        needsCredentials = false
        error = nil
    }

    var canChooseHost: Bool {
        targetHostId == nil
    }

    func continueCredentials() async {
        guard isCurrentAPI?() != false else { return }
        guard let spec = descriptor.credentials, !busy else { return }
        do {
            for field in spec.fields {
                let value = credentials[field.name] ?? ""
                if field.required != false, value.isEmpty { throw DesktopAPIError.message("Enter \(field.label.lowercased()).") }
                if !value
                    .isEmpty { try SourceValidation.pattern(value, pattern: field.pattern, hint: field.patternHint, label: field.label) }
                if value
                    .contains("{gatewayOrigin}") { throw DesktopAPIError.message("Your library’s public address is not available yet.") }
            }
            credentialsCollected = true
            needsCredentials = false
            await begin()
        } catch { self.error = error.localizedDescription }
    }

    func authenticateAnotherAccount() async {
        guard isCurrentAPI?() != false else { return }
        guard canAuthenticateAnotherAccount, !busy else { return }
        error = nil
        let expectedGeneration = generation + 1
        await cancel(clearCredentials: descriptor.credentials?.perAccount == true)
        guard generation == expectedGeneration, error == nil, !Task.isCancelled else { return }
        accounts = []
        selectedAccounts = []
        answer = [:]
        freshAccountRequested = true
        await begin()
    }

    var canAuthenticateAnotherAccount: Bool {
        !descriptor.hasCompanionGuide && descriptor
            .hasAuthFlow && existingAccountId == nil && movingSource == nil && !complete && !needsDescriptorReview
    }

    var offersAnotherAccountAfterFailure: Bool {
        canAuthenticateAnotherAccount && error != nil && (auth?.state == "error" || !accounts.isEmpty)
    }

    var offersRegistrationRetry: Bool {
        error != nil && auth?.state == "completed" && !selectedAccounts.isEmpty && !complete && !needsDescriptorReview
    }

    private func startAuthentication(_ current: Int) async throws {
        guard !descriptor.hasCompanionGuide else { throw DesktopAPIError.message("Open companion setup to continue.") }
        struct Started: Decodable { let flowId: String }
        var body: [String: Any] = [
            "sourceType": descriptor.id,
            "deviceId": deviceId,
            "params": selectedParams,
            "renders": ["redirect", "code", "qr", "fields", "widget", "wait"],
        ]
        if descriptor.credentials?.perAccount == true { body["credentials"] = selectedCredentials }
        if let existingAccountId { body["accountId"] = existingAccountId }
        try await requireRepairTarget(current)
        let result: Started = try await api.request("POST", "admin/auth-flows", body: body)
        // Even when the sheet closed during start, cancel the newly created remote flow.
        if current != generation || Task.isCancelled {
            try? await api.mutate("POST", "admin/auth-flows/\(pathPart(result.flowId))/cancel")
            throw CancellationError()
        }
        flowId = result.flowId
        accounts = []
        watch(current)
    }

    func add() async {
        guard !descriptor.hasCompanionGuide else { return }
        guard isCurrentAPI?() != false else { return }
        guard !busy else { return }
        busy = true
        error = nil
        let current = generation
        defer { if current == generation { busy = false } }
        do { try await addAccounts(current)
        } catch { if current == generation { self.error = error.localizedDescription } }
    }

    private func addAccounts(_ current: Int) async throws {
        guard !descriptor.hasCompanionGuide else { throw DesktopAPIError.message("Open companion setup to continue.") }
        guard !needsDescriptorReview else { throw DesktopAPIError.message("Review the updated source settings before connecting.") }
        try await bindSelectedDescriptor(current, requireUnchanged: true)
        guard !descriptor.hasCompanionGuide else { throw DesktopAPIError.message("Open companion setup to continue.") }
        guard !selectedAccounts.isEmpty else { throw DesktopAPIError.message("Choose at least one account.") }
        let existing = try await api.sources()
        try check(current)
        try await requireRepairTarget(current)
        for account in selectedAccounts.sorted() {
            try check(current)
            if processedAccounts.contains(account) { continue }
            let configured = existing.first { $0.type == descriptor.id && $0.accountId == account && DesktopSourceActionPolicy(
                source: $0,
                devices: []
            ).members.contains(deviceId) }
            guard try await checkCollectionAccess(current, account: account, sourceId: configured?.id) else { return }
            if let movingSource, account != movingSource.accountId {
                throw DesktopAPIError.message("Sign in to the same account to move this source. Other accounts can be added separately.")
            }
            if let source = existing.first(where: { $0.type == descriptor.id && $0.accountId == account }) {
                if source.deviceId == deviceId || source.members?.contains(deviceId) == true {
                    if !source.enabled, existingAccountId == nil, movingSource == nil,
                       !moveAttemptedAccounts.contains(account) { try await api.mutate(
                        "PATCH",
                        "admin/sources/\(pathPart(source.id))",
                        body: ["enabled": true]
                    ) }
                    if movingSource != nil || moveAttemptedAccounts.contains(account) { keptPausedAfterMove = !source.enabled }
                    continue
                }
                guard let mode = source.multiDeviceMode, ["handoff", "replicated", "partitioned"].contains(mode) else {
                    let settings = try await api.sourceSettings(source.id)
                    _ = try settings.checkedRevision()
                    try check(current)
                    guard settings.source.multiDeviceMode == "exclusive", settings.source.accountId == account else {
                        throw DesktopAPIError.message("This account's connection changed. Refresh Sources before continuing.")
                    }
                    auth = nil
                    pendingMove = settings
                    return
                }
                let localNames = Set(descriptor.memberScopedParamNames ?? [])
                    .union((descriptor.params ?? []).filter { $0.scope == "member" }.map(\.name))
                let memberParams = params.filter { localNames.contains($0.key) }
                var body: [String: Any] = ["deviceId": deviceId]
                if !memberParams.isEmpty { body["memberConfig"] = ["params": memberParams] }
                try await api.mutate("POST", "admin/sources/\(pathPart(source.id))/members", body: body)
            } else {
                if movingSource !=
                    nil { throw DesktopAPIError.message("This source was removed. Refresh Sources before connecting it again.") }
                try await api.mutate("POST", "admin/sources/add", body: [
                    "descriptorId": descriptor.id, "deviceId": deviceId, "accountIds": [account], "params": selectedParams,
                ])
            }
        }
        try check(current)
        credentials = [:]
        complete = true
    }

    func confirmMove() async {
        guard isCurrentAPI?() != false else { return }
        guard !busy, let pendingMove else { return }
        busy = true
        error = nil
        let current = generation
        defer { if current == generation { busy = false } }
        do {
            try await bindSelectedDescriptor(current, requireUnchanged: true)
            guard try await checkCollectionAccess(current, account: pendingMove.source.accountId) else { return }
            let memberNames = Set(descriptor.memberScopedParamNames ?? [])
                .union((descriptor.params ?? []).filter { $0.scope == "member" }.map(\.name))
            let sharedFields = (descriptor.params ?? []).filter { !memberNames.contains($0.name) }
            var body: [String: Any] = try [
                "deviceId": deviceId, "expectedRevision": pendingMove.checkedRevision(),
            ]
            if !sharedFields.isEmpty {
                var config = (pendingMove.source.config ?? [:]).mapValues(\.jsonValue)
                var shared: [String: Any] = [:]
                if let existing = pendingMove.source.config?["params"] {
                    guard let object = existing.objectValue
                    else { throw DesktopAPIError.message("The source settings need repair before moving it.") }
                    shared = object.mapValues(\.jsonValue)
                }
                for field in sharedFields {
                    shared[field.name] = params[field.name] ?? ""
                }
                config["params"] = shared
                body["config"] = config
            }
            let local = params.filter { memberNames.contains($0.key) }
            if !local.isEmpty { body["memberConfig"] = ["params": local] }
            try check(current)
            moveAttemptedAccounts.insert(pendingMove.source.accountId)
            try await api.mutate("PATCH", "admin/sources/\(pathPart(pendingMove.source.id))", body: body)
            try check(current)
            keptPausedAfterMove = !pendingMove.source.enabled
            processedAccounts.insert(pendingMove.source.accountId)
            self.pendingMove = nil
            try await addAccounts(current)
        } catch {
            if current == generation {
                self.pendingMove = nil
                self.error = error.localizedDescription
            }
        }
    }

    private func watch(_ current: Int) {
        observation?.cancel()
        observation = Task { [weak self] in
            guard let self, let flowId else { return }
            while !Task.isCancelled {
                do {
                    let next: AuthSnapshot = try await api.request("GET", "admin/auth-flows/\(pathPart(flowId))")
                    try check(current)
                    let changed = next.pendingChallenge?.id != auth?.pendingChallenge?.id
                    auth = next
                    if changed {
                        answer = next.pendingChallenge?.challenge.prefill ?? [:]
                        for (name, field) in next.pendingChallenge?.challenge.schema ?? [:] where answer[name] == nil {
                            if let value = field.default { answer[name] = value.text }
                            else if field.kind == "boolean" { answer[name] = "false" }
                        }
                    }
                    if next.state == "completed" {
                        notices = next.resolvedNotices ?? []
                        accounts = next.resolvedAccountIds ?? next.resolvedAccountId.map { [$0] } ?? []
                        selectedAccounts = Set(accounts)
                        try await addAccounts(current)
                        return
                    }
                    if next.state == "error" {
                        retryAvailableAt = next.errorDetail?.retryAfterMs.map { Date().addingTimeInterval(Double(max(0, $0)) / 1000) }
                        if next.errorDetail?.code == "missing-credentials", descriptor.credentials != nil {
                            credentialsCollected = false
                            sharedCredentialsSaved = false
                            needsCredentials = true
                        }
                        error = next.errorDetail?.remedy ?? next.errorMessage ?? "Sign-in could not finish. Try again."
                        return
                    }
                    try await Task.sleep(for: .seconds(1))
                } catch is CancellationError { return }
                catch { if generation == current, !Task.isCancelled { self.error = error.localizedDescription }
                    return
                }
            }
        }
    }

    func submitAnswer() async {
        guard isCurrentAPI?() != false else { return }
        guard !busy, let flowId, let pending = auth?.pendingChallenge, pending.expectsAnswer else { return }
        busy = true
        let current = generation
        defer { if current == generation { busy = false } }
        do {
            try await requireRepairTarget(current)
            let challenge = pending.challenge
            if let deadline = challenge.expiration, deadline < Date() {
                throw DesktopAPIError.message("This sign-in step expired. Cancel and try again for a fresh one.")
            }
            if challenge.kind == "redirect" {
                guard let code = answer["url"], !code.isEmpty else { throw DesktopAPIError.message("Paste the completed sign-in link.") }
                try await requireRepairTarget(current)
                try await api.mutate("POST", "admin/auth-flows/\(pathPart(flowId))/code", body: ["code": code])
            } else {
                var values: [String: Any] = [:]
                switch challenge.kind {
                case "code":
                    let code = answer["code"] ?? ""
                    guard !code.isEmpty else { throw DesktopAPIError.message("Enter the confirmation code.") }
                    try SourceValidation.pattern(code, pattern: challenge.pattern, hint: challenge.patternHint, label: "confirmation code")
                    values = ["code": code]
                case "fields":
                    guard let schema = challenge.schema
                    else { throw DesktopAPIError.message("This source sent an unsupported sign-in form.") }
                    for (name, field) in schema {
                        if let text = answer[name], !text.isEmpty { values[name] = try field.value(text) }
                        else if field.required == true { values[name] = try field.value("") }
                    }
                default: throw DesktopAPIError.message("This sign-in step cannot accept an answer.")
                }
                try await api.mutate(
                    "POST",
                    "admin/auth-flows/\(pathPart(flowId))/answer",
                    body: ["challengeId": pending.id, "answer": values]
                )
            }
            try check(current)
            answer = [:]
            error = nil
        } catch is CancellationError {}
        catch { if current == generation { self.error = error.localizedDescription } }
    }

    func submitLegacyCode() async {
        guard isCurrentAPI?() != false else { return }
        guard !busy, descriptor.acceptsAuthCode == true, let flowId,
              auth?.pendingChallenge == nil, let code = answer["code"], !code.isEmpty else { return }
        busy = true
        let current = generation
        defer { if current == generation { busy = false } }
        do {
            try await requireRepairTarget(current)
            try await api.mutate("POST", "admin/auth-flows/\(pathPart(flowId))/code", body: ["code": code])
            try check(current)
            answer = [:]
        } catch is CancellationError {}
        catch { if current == generation { self.error = error.localizedDescription } }
    }

    func submitWidgetResult(token: String?, metadata: [String: Any]?) async {
        guard isCurrentAPI?() != false else { return }
        guard let flowId, let token, !token.isEmpty, token.utf8.count <= 16384,
              let metadata, JSONSerialization.isValidJSONObject(metadata),
              let data = try? JSONSerialization.data(withJSONObject: metadata), data.count <= 65536,
              auth?.widget != nil || auth?.pendingChallenge?.challenge.kind == "widget" else { return }
        let current = generation
        do {
            try await requireRepairTarget(current)
            try await api.mutate("POST", "admin/auth-flows/\(pathPart(flowId))/widget-result", body: ["token": token, "metadata": metadata])
            try check(current)
        } catch is CancellationError {}
        catch DesktopAPIError
            .refusal(status: 409, code: _, message: _) { /* The flow may already have completed after an earlier widget result. */ }
        catch { if current == generation { self.error = error.localizedDescription } }
    }

    var canRetryAuthentication: Bool {
        guard let code = auth?.errorDetail?.code else { return true }
        return !["denied", "unsupported", "insecure-connection", "identity-mismatch", "duplicate"].contains(code)
    }

    func reviewCredentials() async {
        guard isCurrentAPI?() != false else { return }
        guard let spec = descriptor.credentials, !busy else { return }
        await cancel(clearCredentials: false)
        credentialsCollected = false
        sharedCredentialsSaved = false
        credentialsStep = spec.wizard?.steps.count ?? 0
        needsCredentials = true
        error = nil
    }

    func reviewUpdatedSettings() async {
        guard isCurrentAPI?() != false, !busy, needsDescriptorReview else { return }
        generation += 1
        observation?.cancel()
        observation = nil
        // Only completed discovery/authentication or a pending move reaches this boundary.
        flowId = nil
        auth = nil
        accounts = []
        selectedAccounts = []
        needsDescriptorReview = false
        error = nil
        await begin()
    }

    func retry() async {
        guard isCurrentAPI?() != false else { return }
        guard canRetryAuthentication else { return }
        if let retryAvailableAt, retryAvailableAt > Date() {
            error = "The provider asked you to wait before trying again. Review the message above and try again later."
            return
        }
        await cancel(clearCredentials: false)
        auth = nil
        error = nil
        await begin()
    }

    func cancel(clearCredentials: Bool = true) async {
        access.cancel()
        generation += 1
        let current = generation
        busy = false
        observation?.cancel()
        observation = nil
        let previous = flowId
        flowId = nil
        auth = nil
        pendingMove = nil
        processedAccounts = []
        moveAttemptedAccounts = []
        answer = [:]
        if clearCredentials { credentials = [:]
            for field in descriptor.params ?? [] where field.type == "secret" {
                params.removeValue(forKey: field.name)
            }
            credentialsCollected = false
        }
        let cleanup = presentationCleanup
        presentationCleanup = nil
        await cleanup?.value
        guard let previous, !complete else { return }
        do { try await api.mutate("POST", "admin/auth-flows/\(pathPart(previous))/cancel") }
        catch { if generation == current { self.error = error.localizedDescription } }
    }

    private func checkCollectionAccess(_ current: Int, account: String?, sourceId: String? = nil) async throws -> Bool {
        guard !descriptor.hasCompanionGuide else { return false }
        guard descriptorDeviceId == deviceId
        else { throw DesktopAPIError.message("Check the selected computer’s source settings before continuing.") }
        if descriptor.permissionRequirements?.isEmpty == true, !access.unresolvedDenial, !access.memberAccessProblem { needsAccess = false
            return true
        }
        let target = DesktopAccessTarget(
            descriptorId: descriptor.id,
            deviceId: deviceId,
            sourceId: sourceId ?? repairSourceId,
            accountId: account,
            params: sourceId == nil && repairSourceId == nil ? selectedParams : [:]
        )
        access.configure(target, api: api)
        needsAccess = true
        await access.check(api: api)
        try check(current)
        let requestedTrial = (access.observation?.scopeDigest).map { unverifiedAccessChoices.contains(target.id + ":" + $0) } ?? false
        unverifiedAccessChoices = unverifiedAccessChoices.filter { !$0.hasPrefix(target.id + ":") }
        if access.allowsCollection, !access.memberAccessProblem { needsAccess = false
            return true
        }
        if !access.unresolvedDenial, !access.memberAccessProblem, api.connection.collectorDeviceId == target.deviceId,
           access.hasManagedPublicationGuard, [.unavailable, .unsupported].contains(access.state),
           requestedTrial {
            needsAccess = false
            return true
        }
        return false
    }

    func continueAfterAccess() async {
        if !accounts.isEmpty { await add() } else { await begin() }
    }

    private func invalidateCollectionAccess() {
        access.invalidateSelection()
        unverifiedAccessChoices = []
        needsAccess = false
    }

    func tryCollectionToCheckAccess() async {
        guard isCurrentAPI?() != false else { return }
        guard let local = api.connection.collectorDeviceId, let target = access.target, target.deviceId == local,
              access.hasManagedPublicationGuard,
              !access.memberAccessProblem, let digest = access.observation?.scopeDigest, !access.unresolvedDenial, [
                  .unavailable,
                  .unsupported
              ].contains(access.state) else { return }
        unverifiedAccessChoices.insert(target.id + ":" + digest)
        await continueAfterAccess()
    }
}

func pathPart(_ value: String) -> String {
    value.addingPercentEncoding(withAllowedCharacters: .alphanumerics) ?? ""
}
