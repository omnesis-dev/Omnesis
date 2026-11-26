// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import AppKit
import Foundation
import Observation
import SwiftUI

struct DesktopRecordingRestoreReview: Decodable {
    let reviewRequired: Bool
    let hasPendingChunks: Bool
    let keepAudioDays: Int
    let transcriberAssignment: String?
    let speakers: String
    let version: String

    private enum CodingKeys: String, CodingKey {
        case reviewRequired, hasPendingChunks, keepAudioDays, transcriberAssignment, speakers, version
    }

    init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        reviewRequired = try values.decode(Bool.self, forKey: .reviewRequired)
        hasPendingChunks = try values.decode(Bool.self, forKey: .hasPendingChunks)
        keepAudioDays = try values.decode(Int.self, forKey: .keepAudioDays)
        transcriberAssignment = try values.decodeIfPresent(String.self, forKey: .transcriberAssignment)
        speakers = try values.decode(String.self, forKey: .speakers)
        version = try values.decode(String.self, forKey: .version)
        guard values.contains(.transcriberAssignment), (0 ... 365).contains(keepAudioDays),
              ["off", "local", "replay"].contains(speakers),
              version.utf8.count == 64, version.range(of: "^[a-f0-9]{64}$", options: .regularExpression) != nil,
              transcriberAssignment
              .map(
                  { !$0.isEmpty && $0.utf8.count <= 1024 && !$0.unicodeScalars.contains(where: CharacterSet.controlCharacters.contains) }
              ) ??
              true
        else { throw DecodingError.dataCorrupted(.init(
            codingPath: decoder.codingPath,
            debugDescription: "Invalid recording review metadata"
        )) }
    }
}

extension DesktopAPI {
    func recordingRestoreReview() async throws -> DesktopRecordingRestoreReview {
        try await request("GET", "admin/recordings/restore-review")
    }
}

@MainActor @Observable
final class DesktopRecordingReviewFlow {
    enum State: Equatable { case hidden, checking, required, unverified, requiredUnverified }
    private(set) var state = State.hidden
    private var api: DesktopAPI?
    private var generation = UUID()
    private var work: Task<Void, Never>?
    private var workID = UUID()
    private var workGeneration = UUID()
    private var knownRequired = false

    func displayedState(api next: DesktopAPI?, afterRestore: Bool) -> State {
        guard api === next else { return afterRestore ? .unverified : .hidden }
        return state
    }

    func refresh(api next: DesktopAPI?, afterRestore: Bool, isCurrent: @escaping @MainActor () -> Bool) async {
        guard isCurrent(), !Task.isCancelled else { return }
        if api !== next {
            generation = UUID()
            work?.cancel()
            api = next
            knownRequired = false
            state = afterRestore ? .unverified : .hidden
        }
        let current = generation
        if let pending = work {
            let joinsCurrentResult = workGeneration == current
            await withTaskCancellationHandler(operation: { await pending.value }, onCancel: { pending.cancel() })
            guard generation == current, isCurrent(), !Task.isCancelled else { return }
            // A same-scope caller joins the applied result. A canceled old-scope request must drain first.
            if joinsCurrentResult { return }
            await refresh(api: next, afterRestore: afterRestore, isCurrent: isCurrent)
            return
        }
        guard let next else {
            state = afterRestore ? .unverified : .hidden
            return
        }
        guard api === next, generation == current, isCurrent(), !Task.isCancelled else { return }
        if knownRequired { state = .required } else { state = afterRestore ? .checking : .hidden }
        let id = UUID()
        workID = id
        workGeneration = current
        let request = Task { [weak self] in
            defer { if self?.workID == id { self?.work = nil } }
            do {
                let result = try await next.recordingRestoreReview()
                guard let self, !Task.isCancelled, self.generation == current, self.api === next, isCurrent() else { return }
                self.knownRequired = result.reviewRequired
                self.state = result.reviewRequired ? .required : .hidden
            } catch {
                guard let self, !Task.isCancelled, self.generation == current, self.api === next, isCurrent() else { return }
                if self.knownRequired { self.state = .requiredUnverified }
                else if case DesktopAPIError.refusal(let status, _, _) = error, [403, 404].contains(status), !afterRestore {
                    self.state = .hidden
                } else { self.state = .unverified }
            }
        }
        work = request
        await withTaskCancellationHandler(operation: { await request.value }, onCancel: { request.cancel() })
    }

    /// Invalidates immediately; the owning task retains and joins its canceled physical request.
    func cancel() {
        generation = UUID()
        work?.cancel()
        if state == .checking { state = .unverified }
    }

    func drain() async {
        await work?.value
    }
}

struct DesktopRecordingReviewNotice: View {
    @Environment(DesktopStore.self) private var store
    @State private var flow = DesktopRecordingReviewFlow()
    var afterRestore = false

    var body: some View {
        DesktopRecordingReviewContent(
            state: flow.displayedState(api: store.api, afterRestore: afterRestore),
            openPortal: { store.openPortal() },
            check: { Task { await refresh() } }
        )
        .task(id: store.apiContextEpoch) { await refresh() }
        .onReceive(NotificationCenter.default.publisher(for: NSApplication.didBecomeActiveNotification, object: NSApp)) { _ in
            Task { await refresh() }
        }
        .onDisappear { flow.cancel() }
    }

    private func refresh() async {
        let context = store.apiContext
        let api = context?.api
        await flow.refresh(api: api, afterRestore: afterRestore, isCurrent: {
            if let context { return context.isCurrent && store.apiContext === context }
            return store.api == nil
        })
    }
}

struct DesktopRecordingReviewContent: View {
    let state: DesktopRecordingReviewFlow.State
    let openPortal: () -> Void
    let check: () -> Void
    var body: some View {
        switch state {
        case .hidden: EmptyView()
        case .checking:
            Label("Checking restored recording choices…", systemImage: "clock")
                .font(.callout).foregroundStyle(DesktopTheme.secondary)
        case .required, .requiredUnverified, .unverified:
            VStack(alignment: .leading, spacing: 8) {
                Text(state == .unverified ? "Recording review could not be checked" : "Restored recordings are paused")
                    .font(.headline).accessibilityAddTraits(.isHeader).accessibilityIdentifier("recording-review-notice")
                if state != .unverified {
                    Text(
                        "Review audio retention, transcription, and speaker processing in the web portal before resuming. Completed recordings remain available."
                    )
                    .font(.callout).foregroundStyle(DesktopTheme.secondary)
                }
                if state == .unverified || state == .requiredUnverified {
                    Text("Omnesis could not verify the current recording choices. Check again or review them in the web portal.")
                        .font(.callout).foregroundStyle(DesktopTheme.secondary)
                }
                HStack {
                    Button("Open review in web portal", action: openPortal)
                        .buttonStyle(DesktopButtonStyle()).accessibilityIdentifier("recording-review-portal")
                    Button("Check again", action: check)
                        .buttonStyle(DesktopButtonStyle()).accessibilityIdentifier("recording-review-check")
                }
            }
        }
    }
}
