// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.ui.devices

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import dagger.hilt.android.lifecycle.HiltViewModel
import dev.omnesis.android.session.SessionManager
import dev.omnesis.android.transport.GatewayException
import dev.omnesis.android.transport.dto.TailscaleJoinApproving
import dev.omnesis.android.transport.dto.TailscaleJoinRequest
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import javax.inject.Inject

/** Said when a decision finds its request gone: it expired, or another administrator decided it. */
internal const val TAILSCALE_JOIN_GONE_MESSAGE = "That request expired or was already decided."

/**
 * The admin client that reviews Tailscale join requests: only an administrator's phone, and only
 * while the gateway says it runs its own Tailscale device ([SessionManager.tailscaleEmbed]), so a
 * gateway without the feature is never asked.
 */
fun tailscaleJoinClient(session: SessionManager): TailscaleJoinApproving? =
    session.session?.takeIf { session.tailscaleEmbed.value && "admin" in it.pairing.scopes }?.admin

/**
 * The devices on the owner's Tailscale network that wait to join the gateway, as an
 * administrator's phone reads and decides them in the Devices approvals sheet.
 *
 * A phone that may not review them, or a gateway that does not advertise them, asks nothing and
 * reads as unavailable. A 404 on the list (a gateway that stopped serving the route) reads the
 * same way rather than as a failure.
 */
@HiltViewModel
class TailscaleJoinRequestsViewModel internal constructor(
    /**
     * The paired admin client while the gateway advertises Tailscale joins, read on every call so
     * a re-pair is never decided on the old gateway; null when this phone must not ask.
     */
    private val client: () -> TailscaleJoinApproving?,
) : ViewModel() {
    @Inject constructor(session: SessionManager) : this({ tailscaleJoinClient(session) })

    data class State(
        val requests: List<TailscaleJoinRequest> = emptyList(),
        /** A read is under way. */
        val loading: Boolean = false,
        /** At least one read finished, so an empty list means nothing is waiting. */
        val loaded: Boolean = false,
        /** The request whose decision is being sent. */
        val deciding: String? = null,
        val error: Throwable? = null,
        /** A short line about the last decision, such as [TAILSCALE_JOIN_GONE_MESSAGE]. */
        val notice: String? = null,
        /**
         * Whether this phone reviews Tailscale joins on this gateway: null until the first read,
         * false when this phone may not ask or the gateway does not serve the route. A read that
         * fails any other way keeps what the last answer showed.
         */
        val available: Boolean? = null,
    ) {
        val busy: Boolean get() = loading || deciding != null
    }

    private val mutable = MutableStateFlow(State())
    val state = mutable.asStateFlow()

    /** Only the latest read lands, so a slow one never overwrites what a decision refreshed. */
    private var generation = 0L

    /** The sheet opened: forget the last visit's notice and read the list. */
    fun open() {
        mutable.update { it.copy(notice = null, error = null) }
        refresh()
    }

    fun refresh() {
        val read = ++generation
        val approving = client()
        if (approving == null) {
            mutable.update { it.copy(requests = emptyList(), loading = false, loaded = true, error = null, available = false) }
            return
        }
        mutable.update { it.copy(loading = true) }
        viewModelScope.launch {
            val result = try {
                Result.success(approving.tailscaleJoinRequests())
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (error: Exception) {
                Result.failure(error)
            }
            if (read != generation) return@launch
            mutable.update { current ->
                result.fold(
                    onSuccess = { current.copy(requests = it, loading = false, loaded = true, error = null, available = true) },
                    onFailure = { error ->
                        if (error is GatewayException.NotFound) {
                            current.copy(requests = emptyList(), loading = false, loaded = true, error = null, available = false)
                        } else {
                            current.copy(loading = false, loaded = true, error = error)
                        }
                    },
                )
            }
        }
    }

    /**
     * Approve or deny [request]. A request that is gone (404) is dropped with a short notice; any
     * other failure keeps the row so the decision can be made again. The list is read again after
     * every decision, since another administrator may have decided others meanwhile.
     */
    fun decide(request: TailscaleJoinRequest, approve: Boolean) {
        if (mutable.value.deciding != null) return
        val approving = client() ?: return
        mutable.update { it.copy(deciding = request.id, notice = null, error = null) }
        viewModelScope.launch {
            try {
                approving.decideTailscaleJoin(request.id, approve)
                mutable.update { current -> current.copy(requests = current.requests.filterNot { it.id == request.id }, deciding = null) }
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (_: GatewayException.NotFound) {
                mutable.update { current ->
                    current.copy(
                        requests = current.requests.filterNot { it.id == request.id },
                        deciding = null,
                        notice = TAILSCALE_JOIN_GONE_MESSAGE,
                    )
                }
            } catch (error: Exception) {
                mutable.update { it.copy(deciding = null, error = error) }
                return@launch
            }
            refresh()
        }
    }
}
