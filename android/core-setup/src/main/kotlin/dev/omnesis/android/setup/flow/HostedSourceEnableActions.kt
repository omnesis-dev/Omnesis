// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.setup.flow

import dev.omnesis.android.transport.ACTIVATION_COMMIT_FAILED
import dev.omnesis.android.transport.ActivationChoice
import dev.omnesis.android.transport.ActivationStep
import dev.omnesis.android.transport.SourceMembership
import dev.omnesis.android.transport.SourceMultiDeviceMode
import dev.omnesis.android.transport.activationFailureMessage
import dev.omnesis.android.transport.commitActivationStep
import dev.omnesis.android.transport.inspectActivationStep
import kotlin.coroutines.cancellation.CancellationException

/**
 * A phone source's enable halves: the membership inspection, then the
 * membership commit followed by the source's own local opt-in.
 *
 * [sessionGeneration] is read when the commit starts and again once the
 * gateway answered: a commit that outlived its pairing (the phone unpaired or
 * re-paired meanwhile) fails instead of turning the source on locally.
 */
class HostedSourceEnableActions(
    private val membership: SourceMembership,
    private val sourceId: String,
    private val mode: SourceMultiDeviceMode,
    private val optIn: suspend () -> Unit,
    private val sessionGeneration: () -> Long = { 0L },
) : SourceEnableActions {
    override suspend fun inspect(choice: ActivationChoice?): ActivationStep =
        membership.inspectActivationStep(sourceId, mode, choice)

    override suspend fun commit(choice: ActivationChoice?): ActivationStep {
        val generation = sessionGeneration()
        return when (val step = membership.commitActivationStep(sourceId, mode, choice)) {
            ActivationStep.Ready -> when {
                sessionGeneration() != generation -> ActivationStep.Failed(ACTIVATION_COMMIT_FAILED)
                else -> try {
                    optIn()
                    ActivationStep.Ready
                } catch (e: CancellationException) {
                    throw e
                } catch (e: Exception) {
                    ActivationStep.Failed(activationFailureMessage(e, ACTIVATION_COMMIT_FAILED))
                }
            }
            else -> step
        }
    }
}
