// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation
import UserNotifications

/// Turns a content-free carrier wake into a locally rendered banner by
/// claiming one leased delivery over the phone's pinned gateway connection.
@available(iOSApplicationExtension 17.0, *)
final class NotificationService: UNNotificationServiceExtension {
    private var contentHandler: ((UNNotificationContent) -> Void)?
    private var bestAttemptContent: UNMutableNotificationContent?
    private var claimTask: Task<Void, Never>?
    private var diagnosticAttempt = NotificationClaimDiagnostic.Attempt()
    private var claimCompleted = false
    private var recordedClaimFailure = false
    private let stateLock = NSLock()

    override func didReceive(
        _ request: UNNotificationRequest,
        withContentHandler contentHandler: @escaping (UNNotificationContent) -> Void
    ) {
        stateLock.lock()
        self.contentHandler = contentHandler
        bestAttemptContent = request.content.mutableCopy() as? UNMutableNotificationContent
        claimCompleted = false
        recordedClaimFailure = false
        let attempt = NotificationClaimDiagnostic.Attempt()
        diagnosticAttempt = attempt
        stateLock.unlock()
        claimTask = Task { [weak self] in
            await self?.claimAndRender(attempt: attempt)
        }
    }

    override func serviceExtensionTimeWillExpire() {
        claimTask?.cancel()
        stateLock.lock()
        NotificationClaimDiagnostic.recordTimeoutIfNeeded(
            claimCompleted: claimCompleted,
            recordedFailure: recordedClaimFailure,
            attempt: diagnosticAttempt
        )
        stateLock.unlock()
        finish()
    }

    private func claimAndRender(attempt: NotificationClaimDiagnostic.Attempt) async {
        let center = UNUserNotificationCenter.current()
        guard let claimer = NotificationClaimCredentials.load() else {
            recordFailure(.other, attempt: attempt)
            finish()
            return
        }
        _ = await drainClaimedNotifications(
            session: true,
            maxItems: 1,
            isCurrent: { _ in !Task.isCancelled },
            claim: {
                do {
                    let claimed = try await claimer.claim()
                    self.markClaimCompleted()
                    return claimed
                } catch {
                    if !Task.isCancelled {
                        self.recordFailure(error, attempt: attempt)
                    }
                    throw error
                }
            },
            render: { [weak self] claimed in
                guard self?.apply(claimed) == true else { throw CancellationError() }
            },
            confirm: { try await claimer.confirm(id: $0) },
            canPresent: { await NotificationPresentationPolicy.canVisiblyPresent(using: center) }
        )
        finish()
    }

    /// Applies content while excluding the expiry callback. A timeout may race
    /// the async claim; once it has consumed the handler, late work is ignored.
    private func apply(_ claimed: ClaimedNotification) -> Bool {
        stateLock.lock()
        defer { stateLock.unlock() }
        guard contentHandler != nil, let content = bestAttemptContent else { return false }
        applyClaimedNotification(claimed, to: content)
        return true
    }

    private func markClaimCompleted() {
        stateLock.lock()
        claimCompleted = true
        stateLock.unlock()
    }

    private func recordFailure(_ error: Error, attempt: NotificationClaimDiagnostic.Attempt) {
        stateLock.lock()
        recordedClaimFailure = true
        NotificationClaimDiagnostic.record(error, attempt: attempt)
        stateLock.unlock()
    }

    private func recordFailure(
        _ reason: NotificationClaimDiagnostic.Reason,
        attempt: NotificationClaimDiagnostic.Attempt
    ) {
        stateLock.lock()
        recordedClaimFailure = true
        NotificationClaimDiagnostic.record(reason, attempt: attempt)
        stateLock.unlock()
    }

    private func finish() {
        stateLock.lock()
        guard let handler = contentHandler, let content = bestAttemptContent else {
            stateLock.unlock()
            return
        }
        contentHandler = nil
        stateLock.unlock()
        handler(content)
    }
}
