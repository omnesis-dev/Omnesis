// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.transport

import dev.omnesis.android.transport.dto.SourceRecord

sealed interface ActivationPlan {
    data object Ready : ActivationPlan
    data object Join : ActivationPlan
    data object AddPartition : ActivationPlan
    data class Choose(val mode: SourceMultiDeviceMode) : ActivationPlan
    data class Incompatible(
        val current: SourceMultiDeviceMode,
        val desired: SourceMultiDeviceMode,
    ) : ActivationPlan
}

enum class ActivationChoice { KEEP_OTHER, USE_BOTH, TAKE_OVER }

sealed interface ActivationOutcome {
    data object Ready : ActivationOutcome
    data object KeptOther : ActivationOutcome
    data class ChoiceRequired(val mode: SourceMultiDeviceMode) : ActivationOutcome
    data class Incompatible(
        val current: SourceMultiDeviceMode,
        val desired: SourceMultiDeviceMode,
    ) : ActivationOutcome
}

data class ActivationOperations(
    val setMode: suspend (String, SourceMultiDeviceMode) -> Unit,
    val join: suspend (String, String) -> Unit,
    val transfer: suspend (String, String) -> Unit,
)

class InvalidActivationChoice(choice: ActivationChoice, mode: SourceMultiDeviceMode) :
    IllegalArgumentException("The $choice choice is not valid for a ${mode.wireValue} source")

class SourceModeTransitionNotConfirmed(mode: SourceMultiDeviceMode) :
    IllegalStateException("The gateway did not confirm ${mode.wireValue} mode. Update the gateway, then try again.")

/**
 * Turns a source-contract refusal into the gateway's actionable guidance while
 * leaving connectivity, authentication, and unexpected failures to the
 * source screen's context-specific fallback. The gateway message identifies
 * the incompatible device; preserving it is more useful than misreporting a
 * deliberate 409 as a network failure.
 */
fun activationFailureMessage(failure: Throwable, fallback: String): String {
    if (failure is SourceModeTransitionNotConfirmed) return failure.message ?: fallback
    val serverError = failure as? GatewayException.ServerError ?: return fallback
    if (serverError.code != "MULTI_DEVICE_CONTRACT_UNSUPPORTED") return fallback
    return serverError.body
        ?.trim()
        ?.takeIf(String::isNotEmpty)
        ?.replaceFirstChar { it.uppercase() }
        ?: "Another device hosting this source must update Omnesis before this phone can join it."
}

/**
 * One gateway half of a phone source's explicit enable, reduced to what the
 * screen that asked acts on: carry on, stop because the user kept another
 * device, ask the user how this phone should contribute, or say why it failed.
 */
sealed interface ActivationStep {
    data object Ready : ActivationStep
    data object KeptOther : ActivationStep
    data class ChoiceRequired(val mode: SourceMultiDeviceMode) : ActivationStep
    data class Failed(val message: String) : ActivationStep
}

const val ACTIVATION_PREPARE_FAILED = "The gateway could not prepare this phone. Check the connection and try again."
const val ACTIVATION_COMMIT_FAILED = "The gateway could not finish enabling this phone. Try again."
const val ACTIVATION_INCOMPATIBLE = "This source uses a different multi-device mode on the gateway."

/** The inspection before Android is asked for access, with every failure folded into a step. */
suspend fun SourceMembership.inspectActivationStep(
    sourceId: String,
    desiredMode: SourceMultiDeviceMode,
    choice: ActivationChoice? = null,
): ActivationStep = try {
    when (val outcome = inspectActivation(sourceId, desiredMode, choice)) {
        ActivationOutcome.Ready -> ActivationStep.Ready
        ActivationOutcome.KeptOther -> ActivationStep.KeptOther
        is ActivationOutcome.ChoiceRequired -> ActivationStep.ChoiceRequired(outcome.mode)
        is ActivationOutcome.Incompatible -> ActivationStep.Failed(ACTIVATION_INCOMPATIBLE)
    }
} catch (e: kotlin.coroutines.cancellation.CancellationException) {
    throw e
} catch (e: Exception) {
    ActivationStep.Failed(activationFailureMessage(e, ACTIVATION_PREPARE_FAILED))
}

/**
 * The commit after Android granted access. A decision that changed while the
 * system dialog was open cannot be carried out on the user's earlier answer,
 * so it fails rather than asking again behind their back.
 */
suspend fun SourceMembership.commitActivationStep(
    sourceId: String,
    desiredMode: SourceMultiDeviceMode,
    choice: ActivationChoice? = null,
): ActivationStep = try {
    when (commitActivation(sourceId, desiredMode, choice)) {
        ActivationOutcome.Ready -> ActivationStep.Ready
        ActivationOutcome.KeptOther -> ActivationStep.KeptOther
        is ActivationOutcome.ChoiceRequired,
        is ActivationOutcome.Incompatible,
        -> ActivationStep.Failed(ACTIVATION_COMMIT_FAILED)
    }
} catch (e: kotlin.coroutines.cancellation.CancellationException) {
    throw e
} catch (e: Exception) {
    ActivationStep.Failed(activationFailureMessage(e, ACTIVATION_COMMIT_FAILED))
}

/** Determines the device-owned enable flow from the persisted source contract. */
object MobileSourceActivation {
    /**
     * Prepare an already-contributing device without joining it implicitly.
     * A missing source/member is not permission to recreate it in the background.
     */
    suspend fun prepareHostedPartition(
        source: SourceRecord?,
        deviceId: String,
        setMode: suspend (String, SourceMultiDeviceMode) -> Unit,
    ) {
        check(source != null && source.hosts(deviceId)) { "This device is not contributing to the source" }
        when (source.multiDeviceMode ?: SourceMultiDeviceMode.EXCLUSIVE.wireValue) {
            SourceMultiDeviceMode.PARTITIONED.wireValue -> Unit
            SourceMultiDeviceMode.EXCLUSIVE.wireValue -> setMode(source.id, SourceMultiDeviceMode.PARTITIONED)
            else -> throw IllegalStateException("This source requires a device-local partition before syncing")
        }
    }

    fun plan(
        source: SourceRecord?,
        deviceId: String,
        desiredMode: SourceMultiDeviceMode,
    ): ActivationPlan {
        if (source == null) return ActivationPlan.Ready
        val currentMode = SourceMultiDeviceMode.entries.firstOrNull {
            it.wireValue == (source.multiDeviceMode ?: SourceMultiDeviceMode.EXCLUSIVE.wireValue)
        } ?: SourceMultiDeviceMode.EXCLUSIVE
        // A device-local source must use its own storage stream even when
        // this device already owns a legacy exclusive source. Do not apply
        // this upgrade rule to shared sources whose owner chose exclusivity.
        if (desiredMode == SourceMultiDeviceMode.PARTITIONED) {
            if (currentMode == SourceMultiDeviceMode.EXCLUSIVE) return ActivationPlan.AddPartition
            if (currentMode != desiredMode) return ActivationPlan.Incompatible(currentMode, desiredMode)
        }
        if (source.hosts(deviceId)) return ActivationPlan.Ready
        if (currentMode == desiredMode) {
            return if (currentMode == SourceMultiDeviceMode.EXCLUSIVE) {
                ActivationPlan.Choose(SourceMultiDeviceMode.EXCLUSIVE)
            } else {
                ActivationPlan.Join
            }
        }
        if (currentMode == SourceMultiDeviceMode.EXCLUSIVE) {
            return if (desiredMode == SourceMultiDeviceMode.PARTITIONED) {
                ActivationPlan.AddPartition
            } else {
                ActivationPlan.Choose(desiredMode)
            }
        }
        return ActivationPlan.Incompatible(currentMode, desiredMode)
    }

    suspend fun execute(
        source: SourceRecord?,
        deviceId: String,
        desiredMode: SourceMultiDeviceMode,
        choice: ActivationChoice? = null,
        operations: ActivationOperations,
    ): ActivationOutcome {
        val activationPlan = plan(source, deviceId, desiredMode)
        if (source == null) return ActivationOutcome.Ready
        return when (activationPlan) {
            ActivationPlan.Ready -> ActivationOutcome.Ready
            ActivationPlan.Join -> {
                operations.join(source.id, deviceId)
                ActivationOutcome.Ready
            }
            ActivationPlan.AddPartition -> {
                operations.setMode(source.id, SourceMultiDeviceMode.PARTITIONED)
                operations.join(source.id, deviceId)
                ActivationOutcome.Ready
            }
            is ActivationPlan.Incompatible -> ActivationOutcome.Incompatible(
                activationPlan.current,
                activationPlan.desired,
            )
            is ActivationPlan.Choose -> when (choice) {
                null -> ActivationOutcome.ChoiceRequired(activationPlan.mode)
                ActivationChoice.KEEP_OTHER -> ActivationOutcome.KeptOther
                ActivationChoice.USE_BOTH -> {
                    if (desiredMode == SourceMultiDeviceMode.EXCLUSIVE || activationPlan.mode != desiredMode) {
                        throw InvalidActivationChoice(choice, activationPlan.mode)
                    }
                    operations.setMode(source.id, desiredMode)
                    operations.join(source.id, deviceId)
                    ActivationOutcome.Ready
                }
                ActivationChoice.TAKE_OVER -> {
                    val persistedMode = SourceMultiDeviceMode.entries.firstOrNull {
                        it.wireValue == (source.multiDeviceMode ?: SourceMultiDeviceMode.EXCLUSIVE.wireValue)
                    } ?: SourceMultiDeviceMode.EXCLUSIVE
                    if (persistedMode != SourceMultiDeviceMode.EXCLUSIVE) {
                        throw InvalidActivationChoice(choice, persistedMode)
                    }
                    operations.transfer(source.id, deviceId)
                    ActivationOutcome.Ready
                }
            }
        }
    }
}
