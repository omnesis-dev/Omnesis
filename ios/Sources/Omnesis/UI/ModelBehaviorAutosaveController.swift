// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation
import Observation

/// One HTTP behavior PATCH at a time. Rapid choices replace the queued value,
/// so an older request cannot finish after and overwrite the user's last pick.
@MainActor
@Observable
final class ModelBehaviorAutosaveController {
    static let conflictMessage = "Settings changed elsewhere. Close and reopen this picker to load the latest settings."

    var isSaving = false
    var notice: String?
    var error: String?
    var hasConflict = false
    var acknowledgedValues: ModelBehaviorValues
    var resetGeneration = 0

    @ObservationIgnored private let save: (ModelBehaviorValues, ModelBehaviorValues) async throws -> String
    @ObservationIgnored private let messageForError: (Error) -> String
    @ObservationIgnored private let budgetDelayNanoseconds: UInt64
    @ObservationIgnored private var latestRevision = 0
    @ObservationIgnored private var pending: Request?
    @ObservationIgnored private var worker: Task<Void, Never>?
    @ObservationIgnored private var budgetDelay: Task<Void, Never>?
    @ObservationIgnored private var deferredExternalValues: ModelBehaviorValues?

    private struct Request {
        let revision: Int
        let values: ModelBehaviorValues
        let resetsControls: Bool
    }

    init(
        initialValues: ModelBehaviorValues,
        budgetDelayNanoseconds: UInt64 = 400_000_000,
        messageForError: @escaping (Error) -> String = { $0.localizedDescription },
        save: @escaping (ModelBehaviorValues, ModelBehaviorValues) async throws -> String
    ) {
        acknowledgedValues = initialValues
        self.budgetDelayNanoseconds = budgetDelayNanoseconds
        self.messageForError = messageForError
        self.save = save
    }

    func submit(_ candidate: Result<ModelBehaviorValues, Error>) {
        guard !hasConflict else { return }
        budgetDelay?.cancel()
        budgetDelay = nil
        apply(candidate)
    }

    func debounceBudget(_ candidate: Result<ModelBehaviorValues, Error>) {
        guard !hasConflict else { return }
        budgetDelay?.cancel()
        latestRevision += 1
        pending = nil
        notice = nil
        error = nil
        budgetDelay = Task {
            try? await Task.sleep(nanoseconds: budgetDelayNanoseconds)
            guard !Task.isCancelled else { return }
            apply(candidate)
            budgetDelay = nil
        }
    }

    func reset() {
        guard !hasConflict else { return }
        budgetDelay?.cancel()
        budgetDelay = nil
        enqueue(ModelBehaviorValues(), resetsControls: true)
    }

    /// Adopt a same-assignment overview refresh only while the editor is idle.
    /// A local draft or in-flight PATCH keeps its own baseline and controls.
    @discardableResult
    func reconcileExternal(_ values: ModelBehaviorValues, hasLocalDraft: Bool) -> Bool {
        guard !hasConflict else { return false }
        if worker != nil || budgetDelay != nil || isSaving {
            deferredExternalValues = values
            return false
        }
        guard !hasLocalDraft, pending == nil else { return false }
        acknowledgedValues = values
        deferredExternalValues = nil
        notice = nil
        error = nil
        return true
    }

    /// A stale unchanged overview prop must never replace a successful PATCH.
    /// Retry only a value actually observed while work was in flight.
    @discardableResult
    func retryDeferredExternal(_ currentValues: ModelBehaviorValues, hasLocalDraft: Bool) -> Bool {
        guard let deferred = deferredExternalValues, deferred == currentValues else {
            deferredExternalValues = nil
            return false
        }
        deferredExternalValues = nil
        guard deferred != acknowledgedValues else { return false }
        return reconcileExternal(deferred, hasLocalDraft: hasLocalDraft)
    }

    private func apply(_ candidate: Result<ModelBehaviorValues, Error>) {
        switch candidate {
        case .success(let values):
            if values == acknowledgedValues, pending == nil, !isSaving {
                error = nil
                notice = nil
            } else {
                enqueue(values, resetsControls: false)
            }
        case .failure(let failure):
            latestRevision += 1
            pending = nil
            notice = nil
            error = messageForError(failure)
        }
    }

    private func enqueue(_ values: ModelBehaviorValues, resetsControls: Bool) {
        latestRevision += 1
        pending = Request(revision: latestRevision, values: values, resetsControls: resetsControls)
        notice = nil
        error = nil
        guard worker == nil else { return }
        worker = Task { await drain() }
    }

    private func drain() async {
        isSaving = true
        while let request = pending {
            pending = nil
            if !request.resetsControls, request.values == acknowledgedValues { continue }
            do {
                let result = try await save(request.values, acknowledgedValues)
                acknowledgedValues = request.values
                if request.revision == latestRevision {
                    notice = result
                    error = nil
                    if request.resetsControls { resetGeneration += 1 }
                }
            } catch {
                if let gatewayError = error as? GatewayClient.Error,
                   case .serverError(status: 409, _) = gatewayError {
                    latestRevision += 1
                    pending = nil
                    budgetDelay?.cancel()
                    budgetDelay = nil
                    deferredExternalValues = nil
                    hasConflict = true
                    notice = nil
                    self.error = Self.conflictMessage
                } else if request.revision == latestRevision {
                    notice = nil
                    self.error = messageForError(error)
                }
            }
        }
        worker = nil
        isSaving = false
    }
}
