// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation
#if canImport(SwiftUI) && canImport(UIKit)
import SwiftUI

/// The info / warning / error icons shown beside a device on the Sources
/// screens, and the half-sheet that lists their text when one is tapped.
///
/// The gateway writes every notice (`notices` on a sync status, one list per
/// member device); these views only present them. They never read
/// `errorMessage`, `issues` or `coverage` themselves — `displayNotices` owns
/// the fallback for a status that carries no notices.
extension SourceNotice.Severity {
    var symbolName: String {
        switch self {
        case .info: "info.circle"
        case .warning: "exclamationmark.triangle.fill"
        case .error: "exclamationmark.octagon.fill"
        }
    }

    var color: Color {
        switch self {
        case .info: Theme.accent
        case .warning: Theme.warning
        case .error: Theme.danger
        }
    }
}

/// One device's notices, as a titled section of the sheet.
struct SourceNoticeSection: Identifiable, Equatable {
    /// The device id, or a positional key when the gateway named no device.
    let id: String
    /// The device's display name; `nil` for a surface that names no device.
    let deviceName: String?
    let notices: [SourceNotice]
}

/// One device line beside a source's detail: its name, whether that is a
/// real name or a shortened id, and its own notices.
struct SourceHostEntry: Identifiable {
    let id: String
    let name: String
    let isResolved: Bool
    let notices: [SourceNotice]
}

/// What an open notices sheet shows. Captured when the sheet opens, so a
/// status refresh while it is up neither changes nor dismisses it.
struct SourceNoticesPresentation: Identifiable {
    let id = UUID()
    let sections: [SourceNoticeSection]
}

/// The name the Sources screens give notices the gateway tied to no device.
private let unknownDeviceName = "Unknown device"

@available(iOS 17.0, *)
extension AppStore {
    /// A source's notices as one sheet section per device that has any, named
    /// as the Sources screens name devices ("Gateway" for an internal source,
    /// "Unknown device" when the gateway named none).
    func noticeSections(for status: SourceSyncStatus, source: SourceRecord) -> [SourceNoticeSection] {
        status.noticesByDevice(fallbackDeviceId: source.deviceId)
            .enumerated()
            .filter { !$0.element.notices.isEmpty }
            .map { index, group in
                SourceNoticeSection(
                    id: group.deviceId ?? "device-\(index)",
                    deviceName: isInternalSource(source.id) ? "Gateway" : deviceDisplayName(group.deviceId).name,
                    notices: group.notices
                )
            }
    }

    /// The devices listed beside a source's detail, each with its own
    /// notices: the registered hosts, then any device — or none, as "Unknown
    /// device" — that the status gives notices the hosts do not cover. An
    /// internal source lists only "Gateway", carrying every notice.
    func hostNoticeEntries(for source: SourceRecord) -> [SourceHostEntry] {
        let status = syncStatusesBySource[source.id]
        if isInternalSource(source.id) {
            return [SourceHostEntry(id: "gateway", name: "Gateway", isResolved: true, notices: status?.allDisplayNotices ?? [])]
        }
        let groups = status?.noticesByDevice(fallbackDeviceId: source.deviceId) ?? []
        var entries = source.hostDeviceIds.map { id in
            let display = deviceDisplayName(id)
            let notices = groups.first(where: { $0.deviceId == id })?.notices ?? []
            return SourceHostEntry(id: id, name: display.name, isResolved: display.isResolved, notices: notices)
        }
        for (index, group) in groups.enumerated() where !group.notices.isEmpty {
            if let id = group.deviceId, source.hostDeviceIds.contains(id) { continue }
            let display = deviceDisplayName(group.deviceId)
            entries.append(SourceHostEntry(
                id: group.deviceId ?? "unknown-\(index)",
                name: display.name,
                isResolved: display.isResolved,
                notices: group.notices
            ))
        }
        return entries
    }

    /// The host label of a Sources row: "Gateway" for an internal source,
    /// "N devices" for one several devices contribute to, otherwise the host.
    func sourceRowHostLabel(for source: SourceRecord, status: SourceSyncStatus?) -> String? {
        if isInternalSource(source.id) { return "Gateway" }
        let deviceCount = max(status?.members?.count ?? 0, source.hostDeviceIds.count)
        return deviceCount > 1 ? "\(deviceCount) devices" : deviceNamesById[source.deviceId]
    }

    /// A device's name, or a shortened id when the name is not known yet
    /// (`isResolved` false), or "Unknown device" for no id at all.
    func deviceDisplayName(_ deviceId: String?) -> (name: String, isResolved: Bool) {
        guard let deviceId else { return (unknownDeviceName, true) }
        if let name = deviceNamesById[deviceId] { return (name, true) }
        return (String(deviceId.prefix(12)) + "…", false)
    }
}

/// A small tappable glyph with an optional count. The hit area reaches 44pt
/// around the glyph without taking that much room in the row.
@available(iOS 17.0, *)
private struct NoticeGlyphButton: View {
    let severity: SourceNotice.Severity
    let count: Int
    let label: String
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: 2) {
                Image(systemName: severity.symbolName)
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundStyle(severity.color)
                if count > 1 {
                    Text("\(count)")
                        .font(.system(size: 10, weight: .semibold))
                        .foregroundStyle(severity.color)
                        .monospacedDigit()
                }
            }
            .padding(.horizontal, 3)
            .frame(minWidth: 20, minHeight: 14)
            .contentShape(Rectangle().inset(by: -15))
        }
        // Borderless keeps the tap to the glyph when it sits in a Form row or
        // a NavigationLink's label, instead of the whole row taking it.
        .buttonStyle(.borderless)
        .accessibilityLabel(label)
        .accessibilityHint("Shows the details")
    }
}

/// One icon per severity present in one device's notices, most severe first.
/// Any icon opens the sheet listing all of that device's notices.
@available(iOS 17.0, *)
struct SourceNoticeIcons: View {
    let notices: [SourceNotice]
    let deviceName: String?

    @State private var presentation: SourceNoticesPresentation?

    var body: some View {
        HStack(spacing: 2) {
            ForEach(groups, id: \.severity) { group in
                NoticeGlyphButton(
                    severity: group.severity,
                    count: group.count,
                    label: sourceNoticeGroupLabel(severity: group.severity, count: group.count, deviceName: deviceName)
                ) {
                    presentation = SourceNoticesPresentation(sections: [
                        SourceNoticeSection(id: deviceName ?? "device", deviceName: deviceName, notices: notices),
                    ])
                }
            }
        }
        .sheet(item: $presentation) { SourceNoticesSheet(sections: $0.sections) }
    }

    private var groups: [(severity: SourceNotice.Severity, count: Int)] {
        SourceNotice.Severity.allCases.reversed().compactMap { severity in
            let count = notices.filter { $0.severity == severity }.count
            return count > 0 ? (severity, count) : nil
        }
    }
}

/// A single icon standing for every device's notices on a surface too narrow
/// for one per device: the most severe glyph, with the total count. Opens the
/// sheet with one section per device. The presentation is bound so the row
/// holding it can open the same sheet from an accessibility action.
@available(iOS 17.0, *)
struct SourceNoticeSummaryIcon: View {
    let sections: [SourceNoticeSection]
    @Binding var presentation: SourceNoticesPresentation?

    var body: some View {
        let all = sections.flatMap(\.notices)
        HStack(spacing: 0) {
            if let worst = all.map(\.severity).max() {
                NoticeGlyphButton(
                    severity: worst,
                    count: all.count,
                    label: sourceNoticeSummaryLabel(all, deviceNames: sections.compactMap(\.deviceName))
                ) {
                    presentation = SourceNoticesPresentation(sections: sections)
                }
            }
        }
        .sheet(item: $presentation) { SourceNoticesSheet(sections: $0.sections) }
    }
}

extension View {
    /// Offer "Show notices" to VoiceOver on a row whose notice icon sits
    /// inside a NavigationLink, where the icon is not separately reachable.
    func sourceNoticesAccessibilityAction(
        sections: [SourceNoticeSection],
        presentation: Binding<SourceNoticesPresentation?>
    )
        -> some View {
        accessibilityActions {
            if sections.contains(where: { !$0.notices.isEmpty }) {
                Button("Show notices") { presentation.wrappedValue = SourceNoticesPresentation(sections: sections) }
            }
        }
    }
}

/// The half-sheet listing notices, one section per device.
@available(iOS 17.0, *)
struct SourceNoticesSheet: View {
    @Environment(\.dismiss) private var dismiss

    let sections: [SourceNoticeSection]

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: Theme.Spacing.lg) {
                    ForEach(sections) { section in
                        VStack(alignment: .leading, spacing: Theme.Spacing.md) {
                            if sections.count > 1, let name = section.deviceName {
                                Text(name.uppercased())
                                    .font(.system(size: 12, weight: .semibold))
                                    .tracking(0.5)
                                    .foregroundStyle(Theme.textSecondary)
                            }
                            ForEach(Array(sortedBySeverity(section.notices).enumerated()), id: \.offset) { _, notice in
                                NoticeEntry(notice: notice)
                            }
                        }
                    }
                }
                .padding(Theme.Spacing.lg)
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            .background(Theme.bgPrimary.ignoresSafeArea())
            .navigationTitle(title)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .primaryAction) {
                    Button("Done") { dismiss() }
                        .tint(Theme.accent)
                }
            }
        }
        .omnesisColorScheme()
        .presentationDetents([.medium, .large])
    }

    private var title: String {
        if sections.count == 1, let name = sections.first?.deviceName, !name.isEmpty {
            return name
        }
        return "Notices"
    }
}

/// One notice: glyph and title, then the detail, the numbered steps and when
/// it was first seen.
@available(iOS 17.0, *)
private struct NoticeEntry: View {
    let notice: SourceNotice

    var body: some View {
        HStack(alignment: .top, spacing: Theme.Spacing.sm) {
            Image(systemName: notice.severity.symbolName)
                .font(.system(size: 15, weight: .semibold))
                .foregroundStyle(notice.severity.color)
                .frame(width: 20)
                .padding(.top, 1)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 6) {
                Text(notice.title)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .font(.headline)
                    .foregroundStyle(Theme.textPrimary)
                    .fixedSize(horizontal: false, vertical: true)
                if let detail = notice.detail, !detail.isEmpty {
                    Text(detail)
                        .font(.body)
                        .foregroundStyle(Theme.textSecondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
                if let steps = notice.steps, !steps.isEmpty {
                    VStack(alignment: .leading, spacing: 4) {
                        ForEach(Array(steps.enumerated()), id: \.offset) { index, step in
                            HStack(alignment: .firstTextBaseline, spacing: 6) {
                                Text("\(index + 1).")
                                    .font(.subheadline.weight(.semibold))
                                    .foregroundStyle(Theme.textSecondary)
                                    .monospacedDigit()
                                Text(step)
                                    .font(.subheadline)
                                    .foregroundStyle(Theme.textPrimary)
                                    .fixedSize(horizontal: false, vertical: true)
                                    .frame(maxWidth: .infinity, alignment: .leading)
                            }
                        }
                    }
                    .padding(.top, 2)
                }
                if let since = noticeSinceText(notice.since) {
                    Text(since)
                        .font(.caption)
                        .foregroundStyle(Theme.textMuted)
                }
            }
            Spacer(minLength: 0)
        }
        .padding(Theme.Spacing.md)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(
            RoundedRectangle(cornerRadius: 10)
                .fill(Theme.bgSecondary)
        )
        .accessibilityElement(children: .combine)
    }
}

#if DEBUG
/// Every icon arrangement on one canvas, for the preview and the snapshot:
/// per-severity groups, a double-digit count, an older gateway's derived
/// notice, and the list row's single summary icon.
@available(iOS 17.0, *)
struct SourceNoticeIconsGallery: View {
    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            row("studio-desk", SourceNoticeIcons(notices: PreviewMocks.noticesStudioMac, deviceName: "studio-desk"))
            row("travel-laptop", SourceNoticeIcons(notices: PreviewMocks.noticesTravelMacBook, deviceName: "travel-laptop"))
            row("archive-server", SourceNoticeIcons(notices: PreviewMocks.noticesMany, deviceName: "archive-server"))
            row("older gateway", SourceNoticeIcons(notices: PreviewMocks.noticesLegacy, deviceName: "mac-mini"))
            row(
                "2 devices",
                SourceNoticeSummaryIcon(sections: PreviewMocks.noticeSectionsMultiMember, presentation: .constant(nil))
            )
        }
        .padding()
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .background(Theme.bgPrimary)
    }

    private func row(_ label: String, _ icons: some View) -> some View {
        HStack(spacing: 6) {
            Text(label).foregroundStyle(Theme.textPrimary)
            icons
        }
    }
}

@available(iOS 17.0, *)
#Preview("Notices sheet — one device") {
    Color.clear.sheet(isPresented: .constant(true)) {
        SourceNoticesSheet(sections: [PreviewMocks.noticeSectionsMultiMember[1]])
    }
}

@available(iOS 17.0, *)
#Preview("Notices sheet — every device") {
    SourceNoticesSheet(sections: PreviewMocks.noticeSectionsMultiMember)
}

@available(iOS 17.0, *)
#Preview("Notices sheet — older gateway fallback") {
    SourceNoticesSheet(sections: PreviewMocks.noticeSectionsLegacy)
}

@available(iOS 17.0, *)
#Preview("Notice icons") {
    SourceNoticeIconsGallery()
}
#endif
#endif
