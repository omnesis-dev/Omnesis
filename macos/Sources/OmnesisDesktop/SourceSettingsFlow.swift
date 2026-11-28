// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation
import Observation

struct DesktopSourceSettingsSnapshot: Decodable, Identifiable {
    let source: DesktopSource
    let revision: String?
    var id: String {
        source.id
    }

    func checkedRevision() throws -> String {
        guard let revision, revision.range(of: "^[a-f0-9]{64}$", options: .regularExpression) != nil,
              source.config != nil else {
            throw DesktopAPIError.message("Update Omnesis on the library's home computer before editing these settings.")
        }
        return revision
    }
}

struct DesktopPendingSourceRemoval: Decodable, Identifiable {
    let id: String
    let type: String
    let accountId: String
    let state: String
}

extension DesktopAPI {
    struct SourcePage: Decodable {
        let items: [DesktopSource]
        let pendingRemovals: [DesktopPendingSourceRemoval]?
    }

    func sourcePage() async throws -> SourcePage {
        try await request("GET", "admin/sources")
    }

    func sourceSettings(_ id: String, member: String? = nil) async throws -> DesktopSourceSettingsSnapshot {
        let path = "admin/sources/\(pathPart(id))" + (member.map { "/members/\(pathPart($0))" } ?? "")
        return try await request("GET", path)
    }
}

@MainActor @Observable
final class DesktopSourceSettingsFlow {
    var isCurrentAPI: (() -> Bool)?
    let descriptor: DesktopDescriptor
    let api: DesktopAPI
    private(set) var selectedDescriptor: DesktopDescriptor?
    private var descriptorDeviceId: String?
    private var descriptorReady = false
    let sourceId: String
    var snapshot: DesktopSourceSettingsSnapshot?
    var memberSnapshot: DesktopSourceSettingsSnapshot?
    var memberIds: [String] = []
    var lifecycle: DesktopSource?
    var devices: [DesktopDevice] = []
    var policy: DesktopSourceActionPolicy? {
        lifecycle.map { DesktopSourceActionPolicy(source: $0, devices: devices) }
    }

    var canEditSelectedHost: Bool {
        descriptorReady && descriptorDeviceId == selectedDeviceId && policy?.canRepair(selectedDeviceId) == true
    }

    var canResume: Bool {
        policy?.canResume == true
    }

    var historical: Bool {
        policy?.historical == true
    }

    private var requiredDeviceId: String?
    private(set) var selectedDeviceId: String
    var sharedValues: [String: String] = [:]
    var localValues: [String: String] = [:]
    var busy = false
    var error: String?
    var message: String?
    var removalRequested = false
    var removalComplete = false
    var disconnected = false
    private var generation = 0

    init(source: DesktopSource, descriptor: DesktopDescriptor, api: DesktopAPI, focusDeviceId: String? = nil) {
        sourceId = source.id
        self.descriptor = descriptor
        self.api = api
        requiredDeviceId = focusDeviceId
        let members = Set(DesktopSourceActionPolicy(source: source, devices: []).members)
        selectedDeviceId = focusDeviceId ?? api.connection.collectorDeviceId.flatMap { members.contains($0) ? $0 : nil } ?? members.sorted()
            .first ?? ""
    }

    var memberParamNames: Set<String> {
        Set(selectedDescriptor?.memberScopedParamNames ?? [])
            .union((selectedDescriptor?.params ?? []).filter { $0.scope == "member" }.map(\.name))
    }

    var sharedParams: [DesktopDescriptor.Param] {
        (selectedDescriptor?.params ?? []).filter { !memberParamNames.contains($0.name) }
    }

    var localParams: [DesktopDescriptor.Param] {
        (selectedDescriptor?.params ?? []).filter { memberParamNames.contains($0.name) }
    }

    func load() async {
        guard !busy, !removalRequested else { return }
        busy = true
        descriptorReady = false
        error = nil
        let current = generation
        defer { if current == generation { busy = false } }
        do { try await refresh(current) }
        catch { if current == generation { self.error = error.localizedDescription } }
    }

    func selectDevice(_ id: String) async {
        guard !busy, memberIds.contains(id) else { return }
        requiredDeviceId = nil // Changing computers here is an explicit user choice.
        let previous = selectedDeviceId
        selectedDeviceId = id
        await load()
        if error != nil { selectedDeviceId = previous }
    }

    private func refresh(_ current: Int) async throws {
        let global = try await api.sourceSettings(sourceId)
        _ = try global.checkedRevision()
        try check(current)
        let page = try await api.sourcePage()
        try check(current)
        guard let row = page.items.first(where: { $0.id == sourceId }) else {
            throw DesktopAPIError.message("This source has been removed. Refresh Sources before continuing.")
        }
        let roster = try await api.devices()
        try check(current)
        let policy = DesktopSourceActionPolicy(source: row, devices: roster)
        let members = policy.members
        if let requiredDeviceId, !policy.canRepair(requiredDeviceId) {
            throw DesktopAPIError
                .message(
                    "The computer selected for access recovery is no longer connected to this source. Review its device connection before changing folders. Your existing information is kept."
                )
        }
        let selected = selectedDeviceId
        // Publish lifecycle authority even when this member cannot supply editable metadata.
        // Draft values remain intact until the complete selected-member load succeeds.
        lifecycle = row
        devices = roster
        memberIds = members
        if !policy.canRepair(selected) {
            snapshot = global
            selectedDeviceId = selected
            descriptorReady = false
            memberSnapshot = nil
            return
        }
        var decodingFields = false
        do {
            let scoped = try await api.descriptor(id: descriptor.id, deviceId: selected)
            try check(current)
            let local = try await api.sourceSettings(sourceId, member: selected)
            _ = try local.checkedRevision()
            try check(current)
            guard global.source.id == sourceId, local.source.id == sourceId,
                  global.source.type == scoped.id, local.source.type == scoped.id,
                  global.source.accountId == local.source.accountId else {
                throw DesktopAPIError.message("The source settings changed computer or account. Refresh before editing them.")
            }
            try await api.requireSourceRepair(sourceId, deviceId: selected)
            try check(current)
            let names = Set(scoped.memberScopedParamNames ?? [])
                .union((scoped.params ?? []).filter { $0.scope == "member" }.map(\.name))
            decodingFields = true
            let shared = try parameterValues(global.source.config, fields: (scoped.params ?? []).filter { !names.contains($0.name) })
            let localValues = try parameterValues(local.source.config, fields: (scoped.params ?? []).filter { names.contains($0.name) })
            snapshot = global
            memberSnapshot = local
            selectedDescriptor = scoped
            descriptorDeviceId = selected
            selectedDeviceId = selected
            sharedValues = shared
            self.localValues = localValues
            descriptorReady = true
        } catch {
            try check(current)
            descriptorReady = false
            // Lifecycle and removal remain available without substituting fleet metadata.
            if snapshot == nil, !decodingFields { snapshot = global }
            throw error
        }
    }

    private func parameterValues(_ config: [String: SourceJSONValue]?, fields: [DesktopDescriptor.Param]) throws -> [String: String] {
        let params = try parameters(config)
        var values: [String: String] = [:]
        for field in fields {
            guard values.updateValue(params[field.name]?.text ?? "", forKey: field.name) == nil else {
                throw DesktopAPIError.message("This source repeated a setting. Update Omnesis before editing it.")
            }
        }
        return values
    }

    private func parameters(_ config: [String: SourceJSONValue]?) throws -> [String: SourceJSONValue] {
        guard let config else { throw DesktopAPIError.message("The source settings are unavailable. Refresh before editing them.") }
        guard let value = config["params"] else { return [:] }
        guard let params = value.objectValue else { throw DesktopAPIError.message("These source settings need repair on their computer.") }
        return params
    }

    func saveShared() async {
        await save(local: false)
    }

    func saveLocal() async {
        await save(local: true)
    }

    private func save(local: Bool) async {
        guard !busy, canEditSelectedHost, let snapshot, let memberSnapshot else { return }
        busy = true
        error = nil
        message = nil
        let current = generation
        defer { if current == generation { busy = false } }
        do {
            let freshDescriptor = try await api.descriptor(id: descriptor.id, deviceId: selectedDeviceId)
            try check(current)
            guard freshDescriptor == selectedDescriptor else {
                throw DesktopAPIError.message("This computer's source settings changed. Refresh and review your draft before saving.")
            }
            try await api.requireSourceRepair(sourceId, deviceId: selectedDeviceId)
            try check(current)
            let fields = local ? localParams : sharedParams
            let values = local ? localValues : sharedValues
            try await validate(fields, values: values, member: memberSnapshot, current: current)
            try await api.requireSourceRepair(sourceId, deviceId: selectedDeviceId)
            try check(current)
            if local {
                var params = try parameters(memberSnapshot.source.config)
                    .filter { memberParamNames.contains($0.key) }.mapValues(\.jsonValue)
                for field in fields {
                    params[field.name] = values[field.name] ?? ""
                }
                try await api.mutate("PATCH", "admin/sources/\(pathPart(sourceId))/members/\(pathPart(selectedDeviceId))", body: [
                    "expectedRevision": memberSnapshot.checkedRevision(), "configOverride": ["params": params],
                ])
            } else {
                var config = (snapshot.source.config ?? [:]).mapValues(\.jsonValue)
                var params = try parameters(snapshot.source.config).mapValues(\.jsonValue)
                for field in fields {
                    params[field.name] = values[field.name] ?? ""
                }
                config["params"] = params
                try await api.mutate("PATCH", "admin/sources/\(pathPart(sourceId))", body: [
                    "expectedRevision": snapshot.checkedRevision(), "config": config,
                ])
            }
            try check(current)
            try await refresh(current)
            message = self.snapshot?.source.enabled == false ? "Settings saved. The source remains paused." : "Settings saved."
        } catch {
            if current == generation {
                self.error = error.localizedDescription
                // A refusal or lost reply may follow a committed write. Refresh
                // actual state without presenting stale settings as current.
                let sharedDraft = sharedValues, localDraft = localValues
                try? await refresh(current)
                if current == generation {
                    sharedValues = sharedDraft
                    localValues = localDraft
                    descriptorReady = false
                }
            }
        }
    }

    private func validate(
        _ fields: [DesktopDescriptor.Param],
        values: [String: String],
        member: DesktopSourceSettingsSnapshot,
        current: Int
    ) async throws {
        guard let descriptor = selectedDescriptor, descriptorReady, descriptorDeviceId == selectedDeviceId else {
            throw DesktopAPIError.message("Refresh this computer's source settings before editing them.")
        }
        for field in fields {
            guard ["string", "path", "select", "secret"].contains(field.type) else {
                throw DesktopAPIError.message("Update Omnesis before editing this source's new setting type.")
            }
            let value = values[field.name] ?? ""
            guard field.required != true || !value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
                throw DesktopAPIError.message("Enter \(field.label.lowercased()).")
            }
            if value.isEmpty, field.validateWhenEmpty != true { continue }
            try SourceValidation.pattern(value, pattern: field.pattern, hint: field.patternHint, label: field.label)
            if field.type == "select", field.options?.contains(where: { $0.value == value }) != true {
                throw DesktopAPIError.message("Choose an available \(field.label.lowercased()).")
            }
            struct Validation: Decodable { let valid: Bool
                let error: String?
            }
            let result: Validation = try await api.request("POST", "admin/sources/validate-param", body: [
                "descriptorId": descriptor.id, "deviceId": selectedDeviceId, "paramName": field.name, "value": value,
            ])
            try check(current)
            if !result.valid { throw DesktopAPIError.message(result.error ?? "Check \(field.label.lowercased()).") }
        }
        if selectedDescriptor?.hasResolveAccountId == true {
            var params = try parameters(member.source.config).mapValues(\.text)
            for field in fields {
                params[field.name] = values[field.name] ?? ""
            }
            struct Resolved: Decodable { let accountId: String }
            let resolved: Resolved = try await api.request("POST", "admin/sources/resolve-account", body: [
                "descriptorId": descriptor.id, "deviceId": selectedDeviceId, "params": params,
            ])
            try check(current)
            guard resolved.accountId == member.source.accountId else {
                throw DesktopAPIError
                    .message("Those settings identify a different account. Add it separately to keep this source's information intact.")
            }
        }
    }

    func setEnabled(_ enabled: Bool) async {
        guard !busy, let snapshot, !enabled || canResume else { return }
        busy = true
        error = nil
        let current = generation
        defer { if current == generation { busy = false } }
        do {
            try check(current)
            if enabled {
                let page = try await api.sourcePage()
                let roster = try await api.devices()
                guard let row = page.items.first(where: { $0.id == sourceId }),
                      DesktopSourceActionPolicy(source: row, devices: roster).canResume else {
                    throw DesktopAPIError.message("Attach or repair a computer before resuming this source.")
                }
                try check(current)
            }
            try await api.mutate("PATCH", "admin/sources/\(pathPart(sourceId))", body: [
                "expectedRevision": snapshot.checkedRevision(), "enabled": enabled,
            ])
            try check(current)
            try await refresh(current)
            message = enabled ? "The source is enabled." : "The source is paused. Indexed information stays in your library."
        } catch { if current == generation { self.error = error.localizedDescription
            try? await refresh(current)
        } }
    }

    func detachSelectedDevice() async {
        guard !busy, memberIds.count > 1 else { return }
        busy = true
        error = nil
        let current = generation
        defer { if current == generation { busy = false } }
        do {
            try check(current)
            try await api.mutate("DELETE", "admin/sources/\(pathPart(sourceId))/members/\(pathPart(selectedDeviceId))")
            try check(current)
            disconnected = true
            message = "This device is disconnected from the source."
            try await refresh(current)
        } catch { if current == generation { self.error = error.localizedDescription
            try? await refresh(current)
        } }
    }

    func removeSource() async {
        guard !busy, !removalRequested, let snapshot else { return }
        busy = true
        error = nil
        let current = generation
        defer { if current == generation { busy = false } }
        do {
            try check(current)
            struct Removal: Decodable { let ok: Bool
                let state: String
            }
            let response: Removal = try await api.request(
                "DELETE",
                "admin/sources/\(pathPart(sourceId))",
                expectedRevision: snapshot.checkedRevision()
            )
            try check(current)
            guard response.ok,
                  response.state == "removing" else { throw DesktopAPIError.message("Removal was not confirmed. Refresh Sources.") }
            removalRequested = true
            busy = false
            await observeRemoval()
        } catch {
            guard current == generation else { return }
            self.error = error.localizedDescription
            // A lost acknowledgement must not invite a second destructive
            // request. Observe the gateway's durable removal state instead.
            if let page = try? await api.sourcePage(), current == generation,
               let pending = page.pendingRemovals,
               !page.items.contains(where: { $0.id == sourceId }) {
                removalRequested = true
                removalComplete = !pending.contains(where: { $0.id == sourceId })
                self.error = nil
                busy = false
                if !removalComplete { await observeRemoval() }
            }
        }
    }

    func observeRemoval() async {
        let current = generation
        error = nil
        do {
            while removalRequested, !removalComplete {
                let page = try await api.sourcePage()
                try check(current)
                guard let pending = page.pendingRemovals
                else {
                    throw DesktopAPIError.message("Removal was requested, but its progress is unavailable. Refresh Sources to check it.")
                }
                if !pending.contains(where: { $0.id == sourceId }), !page.items.contains(where: { $0.id == sourceId }) {
                    removalComplete = true
                    return
                }
                try await Task.sleep(for: .seconds(1))
            }
        } catch is CancellationError { return }
        catch { if current == generation { self.error = error.localizedDescription } }
    }

    func cancelPresentation() {
        generation += 1
        descriptorReady = false
        busy = false
    }

    private func check(_ current: Int) throws {
        try Task.checkCancellation()
        if current != generation || isCurrentAPI?() == false { throw CancellationError() }
    }
}
