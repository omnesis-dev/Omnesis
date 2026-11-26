// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import DesktopCore
import SwiftUI

struct DesktopStorageView: View {
    let context: DesktopAPIContext?
    @Environment(DesktopStore.self) private var store
    @State private var snapshot: DesktopStorageSnapshot?
    @State private var quota = ""
    @State private var noQuota = true
    @State private var sourceId = ""
    @State private var keepAllSourceHistory = true
    @State private var retentionDays = "90"
    @State private var confirmingRetention = false
    @State private var target = "backups"
    @State private var before = Calendar.current.date(byAdding: .month, value: -3, to: Date()) ?? Date()
    @State private var confirmingCleanup = false
    @State private var working = false
    @State private var error: String?
    init(snapshot: DesktopStorageSnapshot? = nil, context: DesktopAPIContext? = nil) {
        self.context = context
        _snapshot = State(initialValue: snapshot)
        _noQuota = State(initialValue: snapshot?.policy.maxBytes == nil)
        _quota = State(initialValue: snapshot?.policy.maxBytes.map { String(Double($0) / 1_073_741_824) } ?? "")
    }

    var body: some View {
        Form {
            DesktopRecordingReviewNotice()

            Section("Library storage") {
                if let snapshot {
                    Text(snapshot.pressure.message)
                    if let bytes = snapshot.pressure.usageBytes {
                        LabeledContent("Used", value: ByteCountFormatter.string(fromByteCount: bytes, countStyle: .file))
                    } else { LabeledContent("Used", value: "Not measured") }
                    if let measured = snapshot.pressure.measuredAt {
                        LabeledContent("Measured", value: Date(timeIntervalSince1970: measured / 1000).formatted())
                    }
                    Toggle("Use available disk space without a library size limit", isOn: $noQuota)
                    if !noQuota { TextField("Library limit (GiB)", text: $quota) }
                    Button("Save storage limit") { context?.run { _ in await saveQuota() } }.accessibilityIdentifier("storage-save-limit")
                        .disabled(working || (!noQuota && DesktopStorageSnapshot.quotaBytes(gibibytes: quota) == nil))
                } else { Text("Storage has not been measured.") }
                Text("Disk safety reserves still apply. Removing original source files is never part of this cleanup.")
                    .font(.callout).foregroundStyle(DesktopTheme.secondary)
                Button("Refresh measurement") { context?.run { _ in await refresh(measure: true) } }.disabled(working)
            }
            sourceRetention
            Section("Remove older history") {
                Picker("History", selection: $target) {
                    Text("Backups").tag("backups")
                    Text("Conversations").tag("conversations")
                    Text("Background processing transcripts").tag("brain-transcripts")
                }
                DatePicker("Before", selection: $before, in: ...Date(), displayedComponents: .date)
                Text(target == "backups" ? "The newest backup is always kept. Save a separate backup before removing older ones." :
                    "This permanently removes older history. It cannot be undone.")
                    .font(.callout).foregroundStyle(DesktopTheme.secondary)
                Button("Review cleanup…", role: .destructive) { confirmingCleanup = true }.accessibilityIdentifier("storage-review-cleanup")
                    .disabled(working || snapshot == nil)
                ForEach(snapshot?.cleanupJobs ?? []) { job in
                    VStack(alignment: .leading) {
                        Text(job.outcome)
                        if let message = job.error { Text(message).foregroundStyle(DesktopTheme.danger) }
                        if job.active { Button("Cancel cleanup") { context?.run { _ in await cancel(job.id) } }.disabled(working) }
                    }
                }
            }
            if let error { Text(error).foregroundStyle(DesktopTheme.danger) }
            if working { ProgressView("Updating storage…") }
        }.formStyle(.grouped)
            .task(id: context?.id) { if snapshot == nil { await refresh() } }
            .onChange(of: sourceId) { _, _ in loadRetention() }
            .confirmationDialog("Change saved source history?", isPresented: $confirmingRetention) {
                Button(
                    keepAllSourceHistory ? "Keep all new history" : "Remove older source history",
                    role: keepAllSourceHistory ? nil : .destructive
                ) {
                    context?.run { _ in await saveRetention() }
                }
            } message: {
                Text(keepAllSourceHistory ?
                    "Future cleanup will keep all history from this source. Previously removed information is not restored." :
                    "Omnesis will automatically remove information from this source older than \(retentionDays) days, including information already saved. Original source files stay in place. This cannot be undone.")
            }
            .task(id: snapshot?.cleanupJobs.contains(where: \.active) == true) {
                while snapshot?.cleanupJobs.contains(where: \.active) == true {
                    do { try await Task.sleep(for: .seconds(3)) } catch { return }
                    if !working { await refresh() }
                }
            }
            .confirmationDialog("Permanently remove older history?", isPresented: $confirmingCleanup) {
                Button("Remove older history", role: .destructive) { context?.run { _ in await cleanup() } }
                    .accessibilityIdentifier("storage-confirm-cleanup")
            } message: {
                Text(
                    "Remove \(target == "backups" ? "backups (keeping the newest)" : target == "conversations" ? "conversations" : "background processing transcripts") before \(before.formatted(date: .abbreviated, time: .omitted)). Your original source files stay in place."
                )
            }
    }

    private var sourceRetention: some View {
        Section("Source history") {
            Picker("Source", selection: $sourceId) {
                Text("Choose a source").tag("")
                ForEach(store.sources) { source in
                    Text("\(store.descriptors.first(where: { $0.id == source.type })?.name ?? source.type) · \(source.accountId)")
                        .tag(source.id)
                }
            }
            if !sourceId.isEmpty {
                Toggle("Keep all history from this source", isOn: $keepAllSourceHistory)
                if !keepAllSourceHistory { TextField("Keep the latest number of days", text: $retentionDays) }
                Text("Changing this applies to information saved in your library. It does not change the original service or its files.")
                    .font(.callout).foregroundStyle(DesktopTheme.secondary)
                Button("Review source history change…") { confirmingRetention = true }
                    .disabled(working || snapshot == nil ||
                        (!keepAllSourceHistory && DesktopStorageSnapshot.retentionDays(retentionDays) == nil))
            }
        }
    }

    private func loadRetention() {
        let days = snapshot?.retention.first(where: { $0.sourceId == sourceId })?.maxAgeDays
        keepAllSourceHistory = days == nil
        retentionDays = String(days ?? 90)
    }

    private func saveRetention() async {
        guard let context, context.isCurrent, !sourceId.isEmpty else { return }
        let days: Any
        if keepAllSourceHistory { days = NSNull() }
        else {
            guard let value = DesktopStorageSnapshot.retentionDays(retentionDays) else { return }
            days = value
        }
        working = true
        do {
            snapshot = try await context.request("PATCH", "admin/storage/retention", body: ["sourceId": sourceId, "maxAgeDays": days])
            error = nil
        } catch { self.error = error.localizedDescription }
        working = false
    }

    private func refresh(measure: Bool = false) async {
        guard let context, context.isCurrent else { error = "Connect to your library first."
            return
        }
        working = true
        defer { working = false }
        do {
            let result: DesktopStorageSnapshot = try await context.request(
                measure ? "POST" : "GET",
                measure ? "admin/storage/refresh" : "admin/storage",
                body: measure ? [:] : nil
            )
            let initial = snapshot == nil
            if initial || measure {
                noQuota = result.policy.maxBytes == nil
                if let bytes = result.policy.maxBytes { quota = String(Double(bytes) / 1_073_741_824) }
            }
            snapshot = result
            if initial, !sourceId.isEmpty { loadRetention() }
            error = nil
        } catch { self.error = error.localizedDescription }
    }

    private func saveQuota() async {
        guard let context, context.isCurrent else { return }
        let value: Any
        if noQuota { value = NSNull() }
        else {
            guard let bytes = DesktopStorageSnapshot.quotaBytes(gibibytes: quota) else { return }
            value = bytes
        }
        working = true
        do {
            snapshot = try await context.request("PATCH", "admin/storage/policy", body: ["maxBytes": value])
            error = nil
        } catch { self.error = error.localizedDescription }
        working = false
    }

    private func cleanup() async {
        guard let context, context.isCurrent else { return }
        working = true
        do {
            var body: [String: Any] = ["target": target, "before": DesktopStorageSnapshot.cutoff(before)]
            if target == "backups" { body["keepNewest"] = true }
            let _: JobReply = try await context.request("POST", "admin/storage/cleanup/jobs", body: body)
            error = nil
        } catch { self.error = error.localizedDescription }
        working = false
        let operationError = error
        await refresh()
        if let operationError { error = operationError }
    }

    private func cancel(_ id: String) async {
        guard let context, context.isCurrent else { return }
        working = true
        do { let _: JobReply = try await context.request("POST", "admin/storage/cleanup/jobs/\(id)/cancel", body: [:])
            error = nil
        } catch { self.error = error.localizedDescription }
        working = false
        let operationError = error
        await refresh()
        if let operationError { error = operationError }
    }

    private struct JobReply: Decodable { let job: DesktopStorageSnapshot.CleanupJob }
}
