// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation
import Observation
import Omnesis

@MainActor @Observable
final class DesktopLibraryConnectionFlow {
    private(set) var status: CloudRelayStatus?
    private(set) var working = false
    private(set) var failure: String?
    private(set) var recheckRequested = false
    private var context: DesktopAPIContext?
    private var generation = UUID()
    private var request: Task<Void, Never>?

    func bind(_ context: DesktopAPIContext?) {
        guard self.context !== context else { return }
        cancel()
        self.context = context
        status = nil
        failure = nil
        recheckRequested = false
    }

    func cancel() {
        generation = UUID()
        request?.cancel()
        request = nil
        working = false
    }

    func load() async {
        await perform(reconnect: false, refresh: {})
    }

    func reconnect(refresh: @escaping () -> Void) async {
        await perform(reconnect: true, refresh: refresh)
    }

    private func perform(reconnect: Bool, refresh: @escaping () -> Void) async {
        if let request { await request.value
            return
        }
        guard let context, context.isCurrent else { return }
        let epoch = generation
        working = true
        failure = nil
        recheckRequested = false
        let task = Task { [weak self] in
            do {
                let fresh: CloudRelayStatus = if reconnect { try await context.perform { try await $0.admin.cloudRelay(.reconnect) } }
                else { try await context.perform { try await $0.admin.cloudRelayStatus() } }
                guard let self, !Task.isCancelled, self.generation == epoch, self.context === context, context.isCurrent else { return }
                self.status = fresh
                if reconnect { self.recheckRequested = true
                    refresh()
                }
            } catch {
                guard let self, !Task.isCancelled, self.generation == epoch, self.context === context, context.isCurrent else { return }
                self.status = nil
                self.failure = "The library’s remote connection could not be confirmed. Check this Mac’s internet connection and try again. Information already available here is kept."
            }
            guard let self, self.generation == epoch else { return }
            self.working = false
            self.request = nil
        }
        request = task
        await task.value
    }
}
