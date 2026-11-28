// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation
import Observation
import Omnesis

@MainActor @Observable
final class DesktopChat {
    struct Row: Identifiable { let id: String
        let role: String
        var text: String
    }

    var rows: [Row] = []
    var sessionId: String?
    private(set) var conversationId: String?
    private(set) var references: [AgentDocRef] = []
    private(set) var opening = false
    private(set) var terminalFailure: String?
    private var openGeneration = UUID()
    private var snapshotCursor: Int?
    private(set) var announcement = ""
    private(set) var announcementRevision = 0
    private var lastAnnouncedTerminal: String?
    var input = ""
    var busy = false
    var failure: String?
    private(set) var historyRevision = 0
    private(set) var model: ModelDisplay?
    private(set) var checkingModel = false
    private(set) var modelCheckFailure: String?
    private var modelGeneration = UUID()
    private(set) var lastAnswerStopped = false
    var needsModel: Bool {
        model.map { !$0.configured || !$0.available } ?? false
    }

    private struct Binding {
        let api: DesktopAPI
        let context: DesktopAPIContext?
        let generation: UUID
    }

    /// Authority to use one session belongs to the exact binding and draft that accepted it.
    struct AcceptedSession {
        let api: DesktopAPI
        let context: DesktopAPIContext?
        let bindingGeneration: UUID
        let draftGeneration: UUID
        let openGeneration: UUID
        let sessionId: String
    }

    private var boundAPI: DesktopAPI?
    private var boundContext: DesktopAPIContext?
    private var attached = false
    private var bindingGeneration = UUID()
    private var draftGeneration = UUID()
    private struct ActionSnapshot {
        let binding: Binding
        let draftGeneration: UUID
        let openGeneration: UUID
        let sessionId: String?
        let question: String
    }

    private enum WorkKind { case stream, conversation, metadata }
    private struct Work {
        let task: Task<Void, Never>
        let kind: WorkKind
        let context: DesktopAPIContext?
        var cleanup: UUID?
    }

    private var work: [UUID: Work] = [:]
    private var streamID: UUID?
    private var cursor: String?

    private var currentBinding: Binding? {
        guard attached, let api = boundAPI, boundContext?.isCurrent != false else { return nil }
        return Binding(api: api, context: boundContext, generation: bindingGeneration)
    }

    private var currentAction: ActionSnapshot? {
        guard let binding = currentBinding, accepts(binding), acceptsDraft(draftGeneration) else { return nil }
        return ActionSnapshot(
            binding: binding, draftGeneration: draftGeneration, openGeneration: openGeneration,
            sessionId: sessionId, question: input
        )
    }

    private func action(in context: DesktopAPIContext?) -> ActionSnapshot? {
        guard let snapshot = currentAction, snapshot.binding.context === context else { return nil }
        return snapshot
    }

    private func accepts(_ snapshot: ActionSnapshot) -> Bool {
        accepts(snapshot.binding) && acceptsDraft(snapshot.draftGeneration) &&
            openGeneration == snapshot.openGeneration && sessionId == snapshot.sessionId
    }

    /// Pending actions revoke conversation work before the view applies their local reset.
    private func acceptsDraft(_ generation: UUID) -> Bool {
        DesktopActionRouter.shared.pending == nil && draftGeneration == generation
    }

    /// A registered task owns cancellation and remains retained until its body finishes, even before first dispatch.
    @discardableResult private func launch(
        _ kind: WorkKind,
        binding: Binding,
        finished: @escaping @MainActor () -> Void = {},
        operation: @escaping @MainActor () async -> Void
    )
        -> Task<Void, Never>? {
        guard accepts(binding) else { return nil }
        let id = UUID()
        let task = Task { @MainActor [self] in
            defer {
                finished()
                if let owned = work.removeValue(forKey: id), let token = owned.cleanup {
                    owned.context?.releaseCleanup(token)
                }
                if streamID == id { streamID = nil }
            }
            guard accepts(binding) else { return }
            await operation()
        }
        work[id] = Work(task: task, kind: kind, context: binding.context)
        if let context = binding.context {
            do {
                let token = try context.retainCleanup {
                    task.cancel()
                    await task.value
                }
                work[id]?.cleanup = token
            } catch { task.cancel() }
        }
        if kind == .stream { streamID = id }
        return task
    }

    @discardableResult func requestSend(in context: DesktopAPIContext?) -> Task<Void, Never>? {
        guard let snapshot = action(in: context) else { return nil }
        return launch(.conversation, binding: snapshot.binding) { [self] in await send(snapshot) }
    }

    @discardableResult func requestCancel(in context: DesktopAPIContext?) -> Task<Void, Never>? {
        guard let snapshot = action(in: context) else { return nil }
        return launch(.conversation, binding: snapshot.binding) { [self] in await cancel(snapshot) }
    }

    @discardableResult func requestOpen(_ id: String, in context: DesktopAPIContext?) -> Task<Void, Never>? {
        guard !id.isEmpty, let captured = action(in: context) else { return nil }
        let generation = UUID()
        openGeneration = generation
        opening = true
        let snapshot = ActionSnapshot(
            binding: captured.binding, draftGeneration: captured.draftGeneration, openGeneration: generation,
            sessionId: captured.sessionId, question: captured.question
        )
        return launch(.conversation, binding: snapshot.binding, finished: { [self] in
            if isBound(snapshot.binding), openGeneration == generation { opening = false }
        }) { [self] in
            _ = await open(snapshot, id: id)
        }
    }

    @discardableResult func requestModelCheck(in context: DesktopAPIContext?) -> Task<Void, Never>? {
        guard let binding = currentBinding, binding.context === context else { return nil }
        return launch(.metadata, binding: binding) { [self] in await checkModel(binding) }
    }

    private func isBound(_ binding: Binding) -> Bool {
        attached && boundAPI === binding.api && boundContext === binding.context &&
            bindingGeneration == binding.generation && binding.context?.isCurrent != false
    }

    private func accepts(_ binding: Binding) -> Bool {
        !Task.isCancelled && isBound(binding)
    }

    private func accepts(_ receipt: AcceptedSession) -> Bool {
        accepts(Binding(api: receipt.api, context: receipt.context, generation: receipt.bindingGeneration)) &&
            acceptsDraft(receipt.draftGeneration) && openGeneration == receipt.openGeneration && sessionId == receipt.sessionId
    }

    private func perform<T>(_ binding: Binding, _ operation: @escaping @MainActor (DesktopAPI) async throws -> T) async throws -> T {
        guard accepts(binding) else { throw CancellationError() }
        let scoped: @MainActor (DesktopAPI) async throws -> T = { [self] api in
            guard accepts(binding) else { throw CancellationError() }
            return try await operation(api)
        }
        let result: T = if let context = binding.context { try await context.perform(scoped) }
        else { try await scoped(binding.api) }
        guard accepts(binding) else { throw CancellationError() }
        return result
    }

    func attach(_ api: DesktopAPI, context: DesktopAPIContext? = nil) {
        guard context == nil || (context?.api === api && context?.isCurrent == true) else { detach()
            return
        }
        if attached, boundAPI === api, boundContext === context, streamID != nil { return }
        let replaced = boundAPI !== api || boundContext !== context
        detach()
        boundAPI = api
        boundContext = context
        attached = true
        if replaced {
            prepareLocalDraft(question: nil)
            model = nil
            modelCheckFailure = nil
            cursor = nil
        }
        checkingModel = model == nil
        guard let binding = currentBinding else { return }
        launch(.stream, binding: binding) { [self] in await listen(binding) }
    }

    /// Preparing a draft neither submits a question nor changes an existing server conversation.
    func prepareLocalDraft(question: String?) {
        for owned in work.values where owned.kind == .conversation {
            owned.task.cancel()
        }
        draftGeneration = UUID()
        openGeneration = UUID()
        opening = false
        sessionId = nil
        conversationId = nil
        rows = []
        references = []
        snapshotCursor = nil
        terminalFailure = nil
        failure = nil
        busy = false
        input = question ?? ""
        lastAnswerStopped = false
        lastAnnouncedTerminal = nil
        announcement = ""
    }

    @discardableResult func open(_ id: String? = nil) async -> AcceptedSession? {
        guard let snapshot = currentAction else { return nil }
        return await open(snapshot, id: id)
    }

    @discardableResult private func open(_ snapshot: ActionSnapshot, id: String?) async -> AcceptedSession? {
        guard accepts(snapshot) else { return nil }
        let binding = snapshot.binding
        guard id != nil || (!needsModel && !checkingModel && modelCheckFailure == nil) else { return nil }
        let generation = UUID(), draft = draftGeneration
        openGeneration = generation
        opening = true
        defer { if isBound(binding), openGeneration == generation { opening = false } }
        failure = nil
        do {
            let session = try await perform(binding) { [self] api in
                guard acceptsDraft(draft), openGeneration == generation else { throw CancellationError() }
                return try await api.agent.createSession(resumeFromId: id)
            }
            guard accepts(binding), acceptsDraft(draft), openGeneration == generation else { return nil }
            sessionId = session.sessionId
            conversationId = session.conversationId ?? session.sessionId
            terminalFailure = session.terminalFailure?.message
            lastAnswerStopped = !session.busy && session.lastTurnFailure?.code == "canceled"
            if !session.busy, !lastAnswerStopped, let lastFailure = session.lastTurnFailure { failure = lastFailure.message }
            busy = session.busy
            snapshotCursor = session.eventCursor
            rows = Self.project(session.messages)
            references = DesktopChatEvidence.references(in: session.messages)
            for event in session.replayEvents {
                observeEvidence(event)
            }
            historyRevision += 1
            return AcceptedSession(
                api: binding.api, context: binding.context, bindingGeneration: binding.generation,
                draftGeneration: draft, openGeneration: generation, sessionId: session.sessionId
            )
        } catch {
            guard accepts(binding), acceptsDraft(draft), openGeneration == generation else { return nil }
            failure = error.localizedDescription
            return nil
        }
    }

    func checkModel(_ api: DesktopAPI) async {
        guard let binding = currentBinding, binding.api === api else { return }
        await checkModel(binding)
    }

    private func checkModel(_ binding: Binding) async {
        guard accepts(binding) else { return }
        let generation = UUID()
        modelGeneration = generation
        checkingModel = true
        defer { if isBound(binding), modelGeneration == generation { checkingModel = false } }
        do {
            let display: ModelDisplay = try await perform(binding) { api in try await api.request("GET", "agent/model") }
            guard accepts(binding), modelGeneration == generation else { return }
            model = display
            modelCheckFailure = nil
        } catch is CancellationError {} catch {
            guard accepts(binding), modelGeneration == generation else { return }
            model = nil
            modelCheckFailure = "Could not check your answer model. Check the connection and try again."
        }
    }

    func send() async {
        guard let snapshot = currentAction else { return }
        await send(snapshot)
    }

    private func send(_ snapshot: ActionSnapshot) async {
        guard accepts(snapshot) else { return }
        let binding = snapshot.binding
        let question = snapshot.question.trimmingCharacters(in: .whitespacesAndNewlines)
        let draft = snapshot.draftGeneration
        guard !question.isEmpty, !busy, !opening, terminalFailure == nil, !needsModel, !checkingModel,
              modelCheckFailure == nil else { return }
        let receipt: AcceptedSession? = if let sessionId = snapshot.sessionId {
            AcceptedSession(
                api: binding.api, context: binding.context, bindingGeneration: binding.generation,
                draftGeneration: draft, openGeneration: snapshot.openGeneration, sessionId: sessionId
            )
        } else { await open(snapshot, id: nil) }
        guard let receipt, receipt.bindingGeneration == binding.generation, receipt.draftGeneration == draft,
              accepts(receipt), !busy, !opening, terminalFailure == nil, !needsModel, !checkingModel,
              modelCheckFailure == nil else { return }
        failure = nil
        busy = true
        do {
            _ = try await perform(binding) { [self] api in
                guard accepts(receipt) else { throw CancellationError() }
                return try await api.agent.sendMessage(sessionId: receipt.sessionId, text: question)
            }
            guard accepts(receipt) else { return }
            if input.trimmingCharacters(in: .whitespacesAndNewlines) == question { input = "" }
            historyRevision += 1
        } catch {
            guard accepts(receipt) else { return }
            // Do not resend automatically: the server may already have accepted it.
            failure = "Your message may not have reached Omnesis. Reopen this conversation before trying again. \(error.localizedDescription)"
            busy = false
        }
    }

    func cancel() async {
        guard let snapshot = currentAction else { return }
        await cancel(snapshot)
    }

    private func cancel(_ snapshot: ActionSnapshot) async {
        guard accepts(snapshot), let sessionId = snapshot.sessionId, !opening else { return }
        let binding = snapshot.binding
        let receipt = AcceptedSession(
            api: binding.api, context: binding.context, bindingGeneration: binding.generation,
            draftGeneration: snapshot.draftGeneration, openGeneration: snapshot.openGeneration, sessionId: sessionId
        )
        do {
            _ = try await perform(binding) { [self] api in
                guard accepts(receipt) else { throw CancellationError() }
                return try await api.agent.cancel(sessionId: receipt.sessionId)
            }
        } catch {
            guard accepts(receipt) else { return }
            failure = error.localizedDescription
        }
    }

    func detach() {
        attached = false
        bindingGeneration = UUID()
        for owned in work.values {
            owned.task.cancel()
        }
        streamID = nil
        openGeneration = UUID()
        modelGeneration = UUID()
        opening = false
        checkingModel = false
    }

    func stopAndJoin() async {
        detach()
        for owned in Array(work.values) {
            await owned.task.value
        }
    }

    private func listen(_ binding: Binding) async {
        while accepts(binding) {
            do {
                let position = cursor
                try await perform(binding) { [self] api in
                    let subscription = api.agent.eventSubscription(lastEventId: position)
                    try await withTaskCancellationHandler {
                        do { try await consume(subscription, binding: binding) }
                        catch {
                            subscription.cancel()
                            await subscription.join()
                            throw error
                        }
                        subscription.cancel()
                        await subscription.join()
                    } onCancel: { subscription.cancel() }
                }
                guard accepts(binding) else { return }
                failure = "Reconnecting to your conversation…"
            } catch is CancellationError { return }
            catch {
                guard accepts(binding) else { return }
                failure = "Your connection was interrupted. Reconnecting…"
            }
            do { try await Task.sleep(for: .seconds(2)) } catch { return }
        }
    }

    private func consume(_ subscription: AgentEventSubscription, binding: Binding) async throws {
        for try await item in subscription.stream {
            guard accepts(binding) else { return }
            if let id = item.id { cursor = id }
            if let sequence = item.id.flatMap(Int.init), let snapshotCursor, sequence <= snapshotCursor { continue }
            if case .resync = item.event {
                if let id = conversationId ?? sessionId { await open(id) }
            } else if item.event.sessionId == sessionId {
                await reduce(item.event, binding: binding)
            }
        }
    }

    private func reduce(_ event: AgentEvent, binding: Binding) async {
        guard accepts(binding), acceptsDraft(draftGeneration), event.sessionId == sessionId else { return }
        observeEvidence(event)
        switch event {
        case .userMessage(_, let id, let text, _):
            if !rows.contains(where: { $0.id == id }) { rows.append(Row(id: id, role: "user", text: text)) }
        case .messageStart(_, let id):
            busy = true
            failure = nil
            lastAnswerStopped = false
            if !rows.contains(where: { $0.id == id }) { rows.append(Row(id: id, role: "assistant", text: "")) }
        case .textDelta(_, let id, let delta):
            if let index = rows.firstIndex(where: { $0.id == id }) { rows[index].text += delta }
            else if busy, let index = rows.indices.last, rows[index].role == "assistant", rows[index].id.hasPrefix("saved-"),
                    snapshotCursor != nil {
                rows[index] = Row(id: id, role: "assistant", text: rows[index].text + delta)
            }
        case .messageEnd(let session, let message, let reason, _):
            let key = session + ":" + message + ":" + reason
            if key != lastAnnouncedTerminal {
                lastAnnouncedTerminal = key
                announcement = reason == "end_turn" ? "Omnesis finished answering." : reason == "canceled" ?
                    "Response stopped. The answer is incomplete." : "The response was interrupted. Review the conversation before trying again."
                announcementRevision += 1
            }
            lastAnswerStopped = reason == "canceled" || reason == "cancelled"
            busy = false
            if let id = conversationId ?? sessionId { await open(id) }
        case .outputTruncated, .contextWindowExceeded:
            busy = false
            if let id = conversationId ?? sessionId { await open(id) }
        case .error(_, _, _, let message, _):
            busy = false
            failure = message
        default: break
        }
    }

    private func observeEvidence(_ event: AgentEvent) {
        switch event {
        case .citation(_, _, _, let ref, _, _, _, _):
            references = DesktopChatEvidence.merging(references, [ref])
        case .citationsUpdate(_, let added, let removed):
            references = DesktopChatEvidence.merging(references, added, removing: removed)
        case .toolResult(_, _, _, let result, _):
            references = DesktopChatEvidence.merging(references, DesktopChatEvidence.annotations(in: result))
        default: break
        }
    }

    private static func project(_ messages: [ChatMessage]) -> [Row] {
        messages.enumerated().compactMap { index, message in
            let text: String
            switch message {
            case .user(let parts): text = parts.compactMap { if case .text(let t) = $0 { return t }
                    return nil
                }.joined(separator: "\n")
            case .assistant(let parts): text = parts.compactMap { if case .text(let t) = $0 { return t }
                    return nil
                }.joined(separator: "\n")
            default: return nil
            }
            return text.isEmpty ? nil : Row(id: "saved-\(index)", role: message.role, text: text)
        }
    }
}
