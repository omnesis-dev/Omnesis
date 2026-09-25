// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.ui.models

import dev.omnesis.android.transport.dto.ModelBehaviorValues
import dev.omnesis.android.transport.dto.ModelBehaviorSettings
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

internal data class BehaviorSaveRequest(
    val role: String,
    val assignment: String,
    val values: ModelBehaviorValues,
)

/** The last values confirmed by GET or a successful PATCH, never an unsent UI draft. */
internal class BehaviorSaveBaseline {
    private val confirmed = mutableMapOf<String, ModelBehaviorSettings>()

    fun replace(settings: Map<String, ModelBehaviorSettings>, preserveRoles: Set<String> = emptySet()) {
        val preserved = confirmed.filterKeys { it in preserveRoles }
        confirmed.clear()
        confirmed.putAll(settings)
        confirmed.putAll(preserved)
    }

    fun expected(request: BehaviorSaveRequest): ModelBehaviorValues? =
        confirmed[request.role]?.takeIf { it.assignment == request.assignment }?.values

    fun acknowledge(request: BehaviorSaveRequest) {
        confirmed[request.role] = ModelBehaviorSettings(request.assignment, request.values)
    }
}

/** Serialize behavior PATCHes and keep the latest unsent choice for each capability. */
internal class BehaviorSaveQueue(
    private val scope: CoroutineScope,
    private val write: suspend (BehaviorSaveRequest) -> Unit,
    private val onResult: suspend (BehaviorSaveRequest, Throwable?) -> Unit,
) {
    private val pending = linkedMapOf<String, BehaviorSaveRequest>()
    private val budgetDebounceJobs = mutableMapOf<String, Job>()
    private var job: Job? = null
    private var activeRole: String? = null

    val unsentRoles: Set<String> get() = pending.keys + budgetDebounceJobs.keys
    val protectedRoles: Set<String> get() = unsentRoles + listOfNotNull(activeRole)
    val hasUnsent: Boolean get() = unsentRoles.isNotEmpty()
    val hasWork: Boolean get() = job?.isActive == true || hasUnsent

    fun submit(request: BehaviorSaveRequest) {
        budgetDebounceJobs.remove(request.role)?.cancel()
        pending[request.role] = request
        if (job?.isActive != true) start()
    }

    /** A null draft cancels an earlier budget edit that has become invalid. */
    fun submitBudget(role: String, request: BehaviorSaveRequest?) {
        budgetDebounceJobs.remove(role)?.cancel()
        if (request == null) return
        budgetDebounceJobs[role] = scope.launch {
            delay(400)
            budgetDebounceJobs.remove(role)
            submit(request)
        }
    }

    /** A conflict makes already queued taps stale; another deliberate edit may be queued after refresh. */
    fun discard(role: String) {
        pending.remove(role)
        budgetDebounceJobs.remove(role)?.cancel()
    }

    private fun start() {
        job = scope.launch {
            try {
                while (pending.isNotEmpty()) {
                    val request = pending.values.first()
                    pending.remove(request.role)
                    activeRole = request.role
                    try {
                        val error = try {
                            write(request)
                            null
                        } catch (e: CancellationException) {
                            throw e
                        } catch (e: Throwable) {
                            e
                        }
                        onResult(request, error)
                    } finally {
                        activeRole = null
                    }
                }
            } finally {
                job = null
                if (pending.isNotEmpty()) start()
            }
        }
    }
}
