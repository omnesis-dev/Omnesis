// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.ui.watches

import androidx.lifecycle.SavedStateHandle
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import dagger.hilt.android.lifecycle.HiltViewModel
import dev.omnesis.android.session.SessionManager
import dev.omnesis.android.transport.dto.PrivacySubscriptionFiring
import dev.omnesis.android.transport.dto.WatchDisclosureDto
import dev.omnesis.android.transport.dto.WatchFiringDto
import dev.omnesis.android.ui.privacy.PrivacySubscriptionRevokeOutcome
import dev.omnesis.android.ui.privacy.revokeSubscriptionAndReconcile
import dev.omnesis.android.transport.dto.WatchRecordDto
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import javax.inject.Inject

data class WatchesUiState(
    val loading: Boolean = true,
    val watches: List<WatchRecordDto> = emptyList(),
    val error: Throwable? = null,
)

@HiltViewModel
class WatchesViewModel @Inject constructor(
    private val session: SessionManager,
) : ViewModel() {
    private val _state = MutableStateFlow(WatchesUiState())
    val state = _state.asStateFlow()

    init {
        reload()
    }

    fun reload() {
        viewModelScope.launch {
            _state.value = _state.value.copy(loading = true, error = null)
            try {
                val watches = session.requireSession().watches.list()
                _state.value = WatchesUiState(loading = false, watches = watches)
            } catch (cancellation: CancellationException) {
                throw cancellation
            } catch (error: Throwable) {
                _state.value = WatchesUiState(loading = false, error = error)
            }
        }
    }
}

data class WatchDetailUiState(
    val loading: Boolean = true,
    val watch: WatchRecordDto? = null,
    val firings: List<WatchFiringDto> = emptyList(),
    val error: Throwable? = null,
    /** The DSL, fetched only when the reader asks to see it. */
    val definition: String? = null,
    val definitionLoading: Boolean = false,
    val definitionError: Throwable? = null,
    /** Journal sequence named by a notification deep link, when it belongs to this watch. */
    val targetFiringSeq: Int? = null,
    /** What this watch may tell an integration. Null when it tells nobody anything. */
    val disclosure: WatchDisclosureDto? = null,
    /**
     * The egress ledger's own record of this watch's firings — what actually left. Read
     * separately from the runtime's and folded in beside it, because the two disagreeing is
     * itself worth seeing.
     */
    val sentFirings: List<PrivacySubscriptionFiring> = emptyList(),
    /**
     * The egress ledger could not be read. Said out loud rather than folded into an empty list:
     * on a screen that accounts for what left the machine, "we could not check" and "nothing
     * left" must not look the same.
     */
    val egressUnavailable: Boolean = false,
    val revoking: Boolean = false,
    val actionError: Throwable? = null,
)

/**
 * Orders the detail's reads so a slower one cannot land on top of a newer one.
 *
 * The screen can have two reloads in flight at once — a revoke finishes and reloads while the
 * reader has already pulled to retry — and each read is several sequential requests long, so
 * "whichever finishes last wins" is not the same as "the newest wins". A revoke also
 * invalidates whatever is already in flight, because its result is what the screen must show.
 */
/**
 * Runs a read whose failure the screen can live without, keeping cancellation fatal.
 *
 * `runCatching` would swallow a `CancellationException` too, letting a coroutine that has been
 * told to stop carry on and publish a state.
 */
private suspend fun <T> optional(read: suspend () -> T): T? = try {
    read()
} catch (cancellation: CancellationException) {
    throw cancellation
} catch (_: Throwable) {
    null
}

internal class WatchDetailRequestGate {
    private var load = 0L

    fun beginLoad(): Long = ++load
    fun invalidate(): Long = ++load
    fun ownsLoad(generation: Long): Boolean = generation == load
}

@HiltViewModel
class WatchDetailViewModel @Inject constructor(
    savedStateHandle: SavedStateHandle,
    private val session: SessionManager,
) : ViewModel() {
    private val watchId: String = checkNotNull(savedStateHandle["watchId"])
    private val targetFiringSeq = watchFiringSequence(
        watchId = watchId,
        firingKey = savedStateHandle["firingKey"],
    )
    private val _state = MutableStateFlow(WatchDetailUiState())
    val state = _state.asStateFlow()
    private val gate = WatchDetailRequestGate()

    init {
        reload()
    }

    fun reload() {
        val generation = gate.beginLoad()
        viewModelScope.launch {
            _state.value = _state.value.copy(loading = true, error = null)
            try {
                val gateway = session.requireSession()
                val client = gateway.watches
                // The list read is what names the watch: the firings route
                // carries the name but not the status, the note, or how many
                // times it has fired in total.
                val watch = client.list().firstOrNull { it.id == watchId }
                val firings = client.firings(watchId).firings
                // A gateway that predates the disclosure read answers 404 here. That is not a
                // failure of the screen — it means this build cannot say who the watch reports
                // to, which reads correctly as "nobody is told". Cancellation is rethrown
                // rather than folded into that absence: a coroutine told to stop must not go on
                // to publish a state.
                val disclosure = optional { client.disclosure(watchId) } ?: watch?.disclosure
                val subscriptionId = disclosure?.subscriptionId?.takeIf { it.isNotBlank() }
                val sent = subscriptionId?.let { id ->
                    optional { gateway.admin.privacySubscriptionFirings(id).firings }
                        // The ledger is read per subscription, and a subscription belongs to one
                        // watch — but the rows carry the watch they came from, so a gateway that
                        // ever widened that read cannot leak another watch's disclosures here.
                        ?.filter { it.watchId == null || it.watchId == watchId }
                }
                if (!gate.ownsLoad(generation)) return@launch
                _state.value = WatchDetailUiState(
                    loading = false,
                    watch = watch,
                    firings = firings,
                    disclosure = disclosure,
                    sentFirings = sent.orEmpty(),
                    egressUnavailable = subscriptionId != null && sent == null,
                    targetFiringSeq = targetFiringSeq?.takeIf { seq ->
                        firings.any { it.seq == seq }
                    },
                )
            } catch (cancellation: CancellationException) {
                throw cancellation
            } catch (error: Throwable) {
                if (!gate.ownsLoad(generation)) return@launch
                _state.value = WatchDetailUiState(loading = false, error = error)
            }
        }
    }

    /**
     * Withdraw the integration's access, then re-read.
     *
     * The watch itself stays and simply stops waking anybody. Re-reading rather than patching
     * the state locally keeps the screen showing what the gateway actually recorded, including
     * the egress ledger, which is deliberately not emptied: a ledger with the record removed
     * would describe disclosures nothing accounts for.
     */
    fun revoke() {
        val subscriptionId = _state.value.disclosure?.subscriptionId?.takeIf { it.isNotBlank() } ?: return
        if (_state.value.revoking) return
        val generation = gate.invalidate()
        viewModelScope.launch {
            _state.value = _state.value.copy(revoking = true, actionError = null)
            // Reconciling rather than trusting the call's own result: a revoke that fails
            // because the subscription was already revoked elsewhere has done what was asked,
            // and reporting it as an error would leave the operator pressing a button that can
            // never succeed.
            val outcome = revokeSubscriptionAndReconcile(
                revoke = { session.requireSession().admin.revokePrivacySubscription(subscriptionId) },
                reload = { session.requireSession().admin.privacySubscription(subscriptionId) },
            )
            if (!gate.ownsLoad(generation)) return@launch
            when (outcome) {
                is PrivacySubscriptionRevokeOutcome.Accepted,
                is PrivacySubscriptionRevokeOutcome.Reconciled,
                -> {
                    _state.value = _state.value.copy(revoking = false, actionError = null)
                    reload()
                }
                is PrivacySubscriptionRevokeOutcome.Failed ->
                    _state.value = _state.value.copy(revoking = false, actionError = outcome.error)
            }
        }
    }

    /**
     * Read the definition, once, the first time it is opened.
     *
     * Not fetched with the rest: it is the largest thing on the screen and the
     * one nobody opens by default, and a list of watches should not pay for a
     * DSL document per row on the chance somebody expands one.
     */
    fun loadDefinition() {
        if (_state.value.definition != null || _state.value.definitionLoading) return
        viewModelScope.launch {
            _state.value = _state.value.copy(definitionLoading = true, definitionError = null)
            try {
                val text = session.requireSession().watches.definition(watchId)
                _state.value = _state.value.copy(definitionLoading = false, definition = text)
            } catch (cancellation: CancellationException) {
                throw cancellation
            } catch (error: Throwable) {
                _state.value = _state.value.copy(
                    definitionLoading = false,
                    definitionError = error,
                )
            }
        }
    }
}

/** The runtime's opaque firing key is `${watchId}:${journalSequence}`. */
internal fun watchFiringSequence(watchId: String, firingKey: String?): Int? {
    if (firingKey == null || !firingKey.startsWith("$watchId:")) return null
    return firingKey.removePrefix("$watchId:").toIntOrNull()?.takeIf { it >= 0 }
}
