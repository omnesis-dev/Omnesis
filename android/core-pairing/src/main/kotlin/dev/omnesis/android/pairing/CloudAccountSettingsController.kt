// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.pairing

import dev.omnesis.android.transport.GatewayException
import dev.omnesis.android.transport.dto.CloudRelayManaging
import dev.omnesis.android.transport.dto.CloudRelayStatus
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow

/**
 * Whether Settings offers "Omnesis account" for this gateway. A gateway without the feature
 * answers 404, and one that can't be asked or refuses the read offers nothing.
 */
suspend fun cloudAccountOffered(client: CloudRelayManaging): Boolean =
    try {
        client.cloudRelayStatus()
        true
    } catch (cancelled: CancellationException) {
        throw cancelled
    } catch (_: Exception) {
        false
    }

/**
 * Settings' "Omnesis account". The gateway owns every value; this mirrors its last answer.
 * One change runs at a time, and a change outranks a status read already in flight, so an
 * older answer never replaces a newer one.
 */
class CloudAccountSettingsController {
    data class State(
        val status: CloudRelayStatus? = null,
        /** No answer yet, of either kind. */
        val loading: Boolean = true,
        /** The gateway has no such settings (it answered 404), so the app shows no way in. */
        val absent: Boolean = false,
        /** The last status read failed and there is nothing older to show. */
        val unreachable: Boolean = false,
        /** Why there is no status to show. Null while an earlier status is on screen. */
        val loadError: Throwable? = null,
        /** The operation in flight, as its path under `/admin/cloud-relay`. */
        val busy: String? = null,
        val error: String? = null,
        /** The `intent` of the connect in flight, which says which of the two buttons is working. */
        val connectIntent: String? = null,
        /** The sign-in address to open in the browser once; the screen calls [launched] when it has. */
        val launchUrl: String? = null,
    ) {
        val phase: CloudAccountPhase? get() = status?.let(::cloudAccountPhase)
    }

    private val mutable = MutableStateFlow(State())
    val state = mutable.asStateFlow()
    private var generation = 0
    private var reading = false

    suspend fun refresh(client: CloudRelayManaging) {
        if (reading || mutable.value.busy != null) return
        reading = true
        val attempt = ++generation
        try {
            val status = client.cloudRelayStatus()
            if (attempt == generation) {
                mutable.value = mutable.value.copy(status = status, loading = false, absent = false, unreachable = false, loadError = null)
            }
        } catch (cancelled: CancellationException) {
            throw cancelled
        } catch (error: Exception) {
            if (attempt == generation) {
                mutable.value = when (error) {
                    is GatewayException.NotFound -> State(loading = false, absent = true)
                    // A missed poll keeps the last answer on screen.
                    else -> mutable.value.copy(loading = false, unreachable = mutable.value.status == null, loadError = error.takeIf { mutable.value.status == null })
                }
            }
        } finally {
            reading = false
        }
    }

    suspend fun connect(client: CloudRelayManaging, intent: String) {
        mutable.value = mutable.value.copy(connectIntent = intent)
        val status = change("connect") { client.connectCloudRelay(intent) } ?: return
        val address = cloudAccountHttpsUrl(status.connect?.authorizeUrl)
        if (cloudAccountPhase(status) == CloudAccountPhase.Waiting && address != null) {
            mutable.value = mutable.value.copy(launchUrl = address)
        }
    }

    suspend fun cancelConnect(client: CloudRelayManaging) {
        change("connect/cancel") { client.cancelCloudRelayConnect() }
    }

    /** `enable`, `disable`, `reconnect` or `account/unlink`. */
    suspend fun run(client: CloudRelayManaging, operation: String) {
        change(operation) { client.cloudRelayOperation(operation) }
    }

    suspend fun setPolicy(client: CloudRelayManaging, policy: String) {
        if (policy !in setOf("automatic", "ask") || mutable.value.status?.deviceEnrollment?.policy == policy) return
        change("enrollment") { client.setCloudRelayEnrollmentPolicy(policy) }
    }

    fun launched() { mutable.value = mutable.value.copy(launchUrl = null) }

    fun clear() {
        generation++
        mutable.value = State()
    }

    /** Runs an operation that answers with the new status. Null when it was refused, failed or skipped. */
    private suspend fun change(operation: String, call: suspend () -> CloudRelayStatus): CloudRelayStatus? {
        if (mutable.value.busy != null) return null
        generation++
        mutable.value = mutable.value.copy(busy = operation, error = null)
        try {
            val status = call()
            mutable.value = mutable.value.copy(status = status, loading = false, unreachable = false, loadError = null)
            return status
        } catch (cancelled: CancellationException) {
            throw cancelled
        } catch (error: Exception) {
            mutable.value = when (error) {
                is GatewayException.NotFound -> State(loading = false, absent = true)
                else -> mutable.value.copy(error = operationError(error))
            }
            return null
        } finally {
            mutable.value = mutable.value.copy(busy = null)
        }
    }

    /** The portal's text for a refusal whose code it knows; any other failure reads as a connection problem. */
    private fun operationError(error: Exception): String =
        cloudAccountKnownErrorText((error as? GatewayException.ServerError)?.code) ?: CLOUD_ACCOUNT_REQUEST_FAILED
}
