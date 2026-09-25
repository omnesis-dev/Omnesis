// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.ui.home

import dev.omnesis.android.transport.dto.PrivacyApprovalsPage

/**
 * Whether a held answer read on becoming active is opened.
 *
 * Two rules. Within one foreground episode an explicit launch — a tapped notification, a
 * tile, an app shortcut — owns the surface, whether it is still waiting on its bus or has
 * already been handled: Android delivers a warm start's `onStart()` before its
 * `onNewIntent()`, so the launch can land after the queue read was armed and before its
 * reply arrives, and the reply must not stack a second destination on top of the one the
 * operator asked for. Across the app session there is one presentation only: a decision left
 * undecided is not re-presented every time the app comes back. That budget is spent by a
 * presentation, never by an offer that was dropped.
 */
internal class PendingApprovalPresentation {
    private var explicitLaunchHandled = false
    private var presented = false

    /** A new foreground episode: what an earlier launch did no longer owns the surface. */
    fun beginForeground() {
        explicitLaunchHandled = false
    }

    /** An explicit launch took the surface in this episode. */
    fun recordExplicitLaunch() {
        explicitLaunchHandled = true
    }

    /** Whether reading the queue could still lead to a presentation this session. */
    val canOffer: Boolean get() = !presented

    /**
     * True when [approvalId] is to be opened now. [explicitLaunchPending] is whether a launch
     * is still waiting on its bus at this moment.
     */
    fun present(approvalId: String?, explicitLaunchPending: Boolean): Boolean {
        val open = approvalId != null && !presented && !explicitLaunchPending && !explicitLaunchHandled
        if (open) presented = true
        return open
    }
}

/** The most pages walked to reach the queue's tail. The pending queue expires, so it is short. */
private const val OLDEST_APPROVAL_MAX_PAGES = 4

/**
 * The oldest held answer, from a queue the gateway serves newest first. The single
 * presentation a session gets goes to the decision closest to expiring. [first] is the
 * one-row page already read for the count; a longer queue is walked to its tail through
 * [fetch], which takes the cursor of the page before it.
 */
internal suspend fun oldestPendingApprovalId(
    first: PrivacyApprovalsPage,
    fetch: suspend (cursor: String?) -> PrivacyApprovalsPage,
): String? {
    if (first.totalCount <= 1) return first.approvals.lastOrNull()?.id
    var page = fetch(null)
    var pages = 1
    while (page.nextCursor != null && pages < OLDEST_APPROVAL_MAX_PAGES) {
        val next = fetch(page.nextCursor)
        if (next.approvals.isEmpty()) break
        page = next
        pages += 1
    }
    return page.approvals.lastOrNull()?.id
}
