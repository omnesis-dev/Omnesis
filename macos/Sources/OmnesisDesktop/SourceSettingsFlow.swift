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
    let descriptor: DesktopDescriptor
    let api: DesktopAPI
    let sourceId: String
    var snapshot: DesktopSourceSettingsSnapshot?
    var memberSnapshot: DesktopSourceSettingsSnapshot?
    var memberIds: [String] = []
    var selectedDeviceId: String
    var sharedValues: [String: String] = [:]
    var localValues: [String: String] = [:]
    var busy = false
    var error: String?
    var message: String?
    var removalRequested = false
    var removalComplete = false
    var disconnected = false
    private var generation = 0

    init(source: DesktopSource, descriptor: DesktopDescriptor, api: DesktopAPI) {
        sourceId = source.id
        self.descriptor = descriptor
        self.api = api
        let members = Set([source.deviceId] + (source.members ?? []))
        selectedDeviceId = api.connection.collectorDeviceId.flatMap { members.contains($0) ? $0 : nil } ?? source.deviceId
    }

    var memberParamNames: Set<String> {
        Set(descriptor.memberScopedParamNames ?? [])
            .union((descriptor.params ?? []).filter { $0.scope == "member" }.map(\.name))
    }

    var sharedParams: [DesktopDescriptor.Param] {
        (descriptor.params ?? []).filter { !memberParamNames.contains($0.name) }
    }

    var localParams: [DesktopDescriptor.Param] {
        (descriptor.params ?? []).filter { memberParamNames.contains($0.name) }
    }

    func load() async {
        guard !busy, !removalRequested else { return }
        busy = true
        error = nil
        let current = generation
        defer { if current == generation { busy = false } }
        do { try await refresh(current) }
        catch { if current == generation { self.error = error.localizedDescription } }
    }

    func selectDevice(_ id: String) async {
        guard !busy, memberIds.contains(id) else { return }
        selectedDeviceId = id
        await load()
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
        let members = Array(Set([row.deviceId] + (row.members ?? []))).sorted()
        let selected = members.contains(selectedDeviceId) ? selectedDeviceId : row.deviceId
        let local = try await api.sourceSettings(sourceId, member: selected)
        _ = try local.checkedRevision()
        try check(current)
        let shared = try parameterValues(global.source.config, fields: sharedParams)
        let localValues = try parameterValues(local.source.config, fields: localParams)
        snapshot = global
        memberSnapshot = local
        selectedDeviceId = selected
        memberIds = members
        sharedValues = shared
        self.localValues = localValues
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
        guard !busy, let snapshot, let memberSnapshot else { return }
        busy = true
        error = nil
        message = nil
        let current = generation
        defer { if current == generation { busy = false } }
        do {
            let fields = local ? localParams : sharedParams
            let values = local ? localValues : sharedValues
            try await validate(fields, values: values, member: memberSnapshot, current: current)
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
                try? await refresh(current)
            }
        }
    }

    private func validate(
        _ fields: [DesktopDescriptor.Param],
        values: [String: String],
        member: DesktopSourceSettingsSnapshot,
        current: Int
    ) async throws {
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
        if descriptor.hasResolveAccountId == true {
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
        guard !busy, let snapshot else { return }
        busy = true
        error = nil
        let current = generation
        defer { if current == generation { busy = false } }
        do {
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
        busy = false
    }

    private func check(_ current: Int) throws {
        try Task.checkCancellation()
        if current != generation { throw CancellationError() }
    }
}
