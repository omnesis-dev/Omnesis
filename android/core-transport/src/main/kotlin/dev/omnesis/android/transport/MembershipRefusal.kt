// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.transport

import kotlin.coroutines.cancellation.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.launch

/**
 * One phone-hosted source's opt-in, reachable with no screen in the picture.
 * Implemented inside the source's own feature module, so what "this phone
 * stops hosting it" means — which persisted flag, which schedulers, which
 * platform subscriptions — never leaks into shared code.
 */
interface HostedSourceOptIn {
    /** The gateway-side source id this opt-in governs. */
    val sourceId: String

    /** Source-owned storage/cursor contract announced by the device. */
    val hostedSourceContract: HostedSourceContract
        get() = HostedSourceContract(sourceId.substringBefore(':'))

    /** Explicit pending opt-in may register a missing row; ordinary sync never calls this. */
    suspend fun registerForResume(admin: dev.omnesis.android.transport.client.AdminClient, deviceId: String) {
        admin.createSource(
            type = hostedSourceContract.sourceType,
            accountId = sourceId.substringAfter(':', missingDelimiterValue = ""),
            deviceId = deviceId,
        )
    }

    /**
     * Withdraws the phone's opt-in: the persisted switch goes off and
     * everything scheduled or subscribed against the source stops. Called
     * whenever a refusal for [sourceId] stands, so it must be idempotent, and
     * must not block — anything slow belongs on the implementor's own scope.
     */
    fun withdraw()

    /**
     * Forgets the source's local preferences on this phone — the opt-in,
     * remembered permission answers and choices — and stops its background
     * work. Called when the phone unpairs: the next pairing is a new device
     * on its gateway, whose source state lives there, so nothing the old
     * pairing chose carries over.
     */
    fun forget()
}

/**
 * The one place a membership refusal is acted on.
 *
 * A refusal means the gateway will not have this phone host the source
 * however its switch reads, so the switch has to go back off and the periodic
 * work with it. That has to happen whenever a refusal arrives, not only while
 * the source's settings screen happens to be open: every foreground drains
 * whatever [SourceMembership] still owes the gateway, and a resume refused in
 * that drain would otherwise leave behind a persisted opt-in and a periodic
 * worker running against a source the gateway refuses. So this holder lives
 * for the process, and the screens are left with nothing to do but show the
 * reason.
 *
 * Every standing refusal is re-applied on each change to the set, rather than
 * once when it appears. [HostedSourceOptIn.withdraw] is idempotent, so
 * re-asserting costs nothing and removes the need to remember what was
 * already handled — a memory a conflated emission could otherwise leave
 * pointing at a refusal that has since been cleared and earned again.
 */
class MembershipRefusalCoordinator(
    private val membership: SourceMembership,
    private val optIns: () -> Collection<HostedSourceOptIn>,
    private val scope: CoroutineScope,
    /**
     * Where this object narrates what it did. Source ids are deliberately
     * absent from what it is handed: logcat is readable by anything holding
     * `READ_LOGS` or an adb cable, and what this phone hosts is the user's
     * business, not a debugging convenience.
     */
    private val log: (String) -> Unit = {},
) {
    /** Starts watching for refusals. Returns the watching job, for the caller to hold. */
    fun start(): Job = scope.launch {
        membership.refusals.collect { bySource ->
            // Removal reconciliation already withdrew these opt-ins atomically
            // with its activation fence. Replaying that write later could undo
            // a new activation while this collector was waiting to run.
            apply(bySource.filterValues { it.code != "SOURCE_REMOVED" })
        }
    }

    private fun apply(refused: Map<String, SourceMembership.Outcome.Refused>) {
        for (optIn in optIns()) {
            val expected = refused[optIn.sourceId] ?: continue
            try {
                membership.applyRefusalIfCurrent(optIn.sourceId, expected, optIn::withdraw)
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                log("Could not turn a refused source back off: ${e::class.simpleName}")
            }
        }
    }
}
