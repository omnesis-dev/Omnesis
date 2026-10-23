// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation

/// Owns one Live call and its media. Canonical conversation state remains in
/// AgentCoordinator; ending a call detaches rather than cancelling accepted work.
@MainActor
final class LiveVoiceSession {
    struct State {
        var connected = false
        var ending = false
        var status = "Connecting…"
        var error: RealtimeCallFailure?
        var replyFailure: RealtimeCallFailure?
        var captions = LiveVoiceCaptions()
        var inputLevel = 0.0
        var outputLevel = 0.0
        var conversationID: String?
    }

    private let api: LiveVoiceAPI
    private let media: any LiveVoiceMedia
    private let publish: (State) -> Void
    private let permission: @MainActor () async -> Bool
    private var state = State()
    private var call: LiveVoiceCall?
    private var generation = UUID()
    private var started = false
    private var starting = false
    private var finished = false
    private var startup: CheckedContinuation<Void, Error>?
    private var deadline: Task<Void, Never>?
    private var failureTask: Task<Void, Never>?
    private var statusTask: Task<Void, Never>?
    private var statusReady = false
    private var statusDeadline: Task<Void, Never>?
    private var statusWaiter: CheckedContinuation<Void, Error>?

    init(
        api: LiveVoiceAPI,
        media: any LiveVoiceMedia,
        permission: @escaping @MainActor () async -> Bool,
        publish: @escaping (State) -> Void
    ) {
        self.api = api
        self.media = media
        self.publish = publish
        self.permission = permission
    }

    func start(conversationID: String?, onReady: (@MainActor (String) async throws -> Void)?) async {
        guard !starting, !finished, call == nil else { return }
        starting = true
        defer { starting = false }
        let epoch = generation
        media.onEvent = { [weak self] data in self?.receive(data, generation: epoch) }
        media.onFailure = { [weak self] error in self?.failed(error, generation: epoch) }
        media.onLevels = { [weak self] input, output in
            guard let self, self.generation == epoch, self.state.connected, !self.state.ending else { return }
            guard input != self.state.inputLevel || output != self.state.outputLevel else { return }
            self.state.inputLevel = input
            self.state.outputLevel = output
            self.publish(self.state)
        }
        do {
            let granted = await permission()
            try check(epoch)
            guard granted else { throw RealtimeCallFailure(code: "microphone_permission", fatal: true, retryable: false) }
            let offer = try await media.offer()
            try check(epoch)
            let created = try await api.create(sdp: offer, conversationID: conversationID, clientSessionID: epoch.uuidString)
            // A cancelled creation still owns an orphan that must be detached.
            guard generation == epoch, !Task.isCancelled else {
                Task { _ = try? await api.end(id: created.id) }
                throw CancellationError()
            }
            call = created
            observeStatus(id: created.id, generation: epoch)
            state.conversationID = created.conversationId
            try await media.connect(answer: created.transport.sdp)
            try check(epoch)
            try await waitForStarted()
            try check(epoch)
            try await waitForStatus()
            try check(epoch)
            try await onReady?(created.conversationId)
            try check(epoch)
            try await api.ready(id: created.id)
            try check(epoch)
            media.enableMicrophone(true)
            guard failureTask == nil else {
                await failureTask?.value
                return
            }
            state.connected = true
            state.status = "Listening"
            publish(state)
        } catch {
            guard generation == epoch, !(error is CancellationError) else { return }
            failed(error, generation: epoch)
            await failureTask?.value
        }
    }

    private func observeStatus(id: String, generation epoch: UUID) {
        statusTask = Task { [weak self] in
            guard let self else { return }
            for attempt in 0 ..< 3 {
                do {
                    for try await status in api.events(id: id) {
                        guard generation == epoch, !Task.isCancelled else { return }
                        if let failure = status.failure {
                            terminate(failure.presentation)
                            return
                        }
                        guard status.status != "failed", status.status != "ended" else {
                            terminate(RealtimeCallFailure(code: "connection_error", fatal: true, retryable: true))
                            return
                        }
                        let notice = status.replyFailure?.presentation
                        let replyFailure = notice.map { RealtimeCallFailure(code: $0.code, fatal: false, retryable: $0.retryable) }
                        if state.replyFailure != replyFailure {
                            state.replyFailure = replyFailure
                            publish(state)
                        }
                        statusReady = true
                        finishStatus(.success(()))
                    }
                    throw URLError(.networkConnectionLost)
                } catch {
                    guard generation == epoch, !Task.isCancelled else { return }
                    // A fresh snapshot closes the race between a stream drop and
                    // gateway revocation; no repeated status polling is used.
                    if let current = try? await api.status(id: id) {
                        if let failure = current.failure {
                            terminate(failure.presentation)
                            return
                        }
                        if current.status == "ended" || current.status == "failed" {
                            terminate(RealtimeCallFailure(code: "connection_error", fatal: true, retryable: true))
                            return
                        }
                    }
                    if error is RealtimeCallFailure || attempt == 2 {
                        terminate(RealtimeCallFailure.local(error))
                        return
                    }
                    do { try await Task.sleep(for: .milliseconds(attempt == 0 ? 250 : 1000)) } catch { return }
                }
            }
        }
    }

    private func waitForStatus() async throws {
        if statusReady { return }
        try await withCheckedThrowingContinuation { continuation in
            statusWaiter = continuation
            statusDeadline = Task { [weak self] in
                do { try await Task.sleep(for: .seconds(20)) } catch { return }
                self?.terminate(RealtimeCallFailure(code: "timeout", fatal: true, retryable: true))
            }
        }
    }

    private func finishStatus(_ result: Result<Void, Error>) {
        statusDeadline?.cancel()
        statusDeadline = nil
        let waiter = statusWaiter
        statusWaiter = nil
        waiter?.resume(with: result)
    }

    private func check(_ epoch: UUID) throws {
        try Task.checkCancellation()
        guard generation == epoch else { throw CancellationError() }
    }

    private func waitForStarted() async throws {
        if started { return }
        try await withCheckedThrowingContinuation { continuation in
            startup = continuation
            deadline = Task { [weak self] in
                do { try await Task.sleep(for: .seconds(20)) } catch { return }
                self?.finishStartup(.failure(RealtimeCallFailure(code: "timeout", fatal: true, retryable: true)))
            }
        }
    }

    private func finishStartup(_ result: Result<Void, Error>) {
        deadline?.cancel()
        deadline = nil
        let continuation = startup
        startup = nil
        continuation?.resume(with: result)
    }

    private func receive(_ data: Data, generation epoch: UUID) {
        guard generation == epoch, !state.ending else { return }
        guard let event = RealtimeProtocol.event(data) else {
            failed(RealtimeCallFailure(code: "protocol_error", fatal: true, retryable: true), generation: epoch)
            return
        }
        switch event["type"] as? String {
        case "session.started":
            started = true
            finishStartup(.success(()))
        case "session.closed":
            failed(URLError(.networkConnectionLost), generation: epoch)
        case "error":
            failed(RealtimeCallFailure.server(event), generation: epoch)
        default:
            let previous = state.captions.fragments.last?.id
            state.captions.receive(event)
            if state.captions.fragments.last?.id != previous { publish(state) }
        }
    }

    private func failed(_ error: Error, generation epoch: UUID) {
        guard generation == epoch, !state.ending, state.error == nil, failureTask == nil else { return }
        media.close()
        state.connected = false
        state.inputLevel = 0
        state.outputLevel = 0
        state.status = "Checking voice connection…"
        publish(state)
        failureTask = Task { [weak self] in
            guard let self else { return }
            var failure = RealtimeCallFailure.local(error)
            if let call, let status = try? await api.status(id: call.id), let reported = status.failure {
                failure = reported.presentation
            }
            guard generation == epoch else { return }
            terminate(failure)
        }
    }

    private func terminate(_ failure: RealtimeCallFailure) {
        finished = true
        generation = UUID()
        media.close()
        state.error = state.error ?? failure
        state.connected = false
        state.status = "Call interrupted"
        statusTask?.cancel()
        finishStatus(.failure(failure))
        finishStartup(.failure(failure))
        publish(state)
        if let call { Task { _ = try? await api.end(id: call.id) } }
    }

    func mute(_ muted: Bool) {
        media.enableMicrophone(!muted && state.connected && !state.ending)
        if muted { state.inputLevel = 0
            publish(state)
        }
    }

    func end() async {
        guard !state.ending else { return }
        finished = true
        generation = UUID()
        state.ending = true
        state.connected = false
        state.inputLevel = 0
        state.outputLevel = 0
        state.status = "Ending call…"
        media.close()
        statusTask?.cancel()
        finishStatus(.failure(CancellationError()))
        finishStartup(.failure(CancellationError()))
        publish(state)
        if let call {
            do {
                let ended = try await api.end(id: call.id)
                guard ended.ended else { throw RealtimeCallFailure(code: "session_end_failed", fatal: true, retryable: true) }
                if let failure = ended.failure { state.error = failure.presentation }
            } catch { state.error = RealtimeCallFailure.local(error) }
        }
        call = nil
        generation = UUID()
        state.ending = false
        state.status = state.error == nil ? "Call ended" : "Call interrupted"
        publish(state)
    }

    func stop() {
        finished = true
        generation = UUID()
        media.close()
        failureTask?.cancel()
        statusTask?.cancel()
        finishStatus(.failure(CancellationError()))
        finishStartup(.failure(CancellationError()))
        if let call { Task { _ = try? await api.end(id: call.id) } }
    }
}
