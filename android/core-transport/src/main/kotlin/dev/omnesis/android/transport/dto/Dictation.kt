// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.transport.dto

import kotlinx.serialization.Serializable

/**
 * `PATCH /admin/config` body that changes one gateway dictation setting:
 * `{ "inference": { "dictation": { "<setting>": <bool> } } }`. Only the setting
 * being changed is sent, so the other keeps the value the gateway holds.
 */
@Serializable
data class DictationConfigPatch(val inference: Inference) {
    @Serializable
    data class Inference(val dictation: Dictation)

    @Serializable
    data class Dictation(
        val transcribeOnGateway: Boolean? = null,
        val useDecisionGateForWatch: Boolean? = null,
    )

    companion object {
        /** Whether Tell Omnesis voice notes are transcribed by the gateway. */
        fun transcribeOnGateway(enabled: Boolean) =
            DictationConfigPatch(Inference(Dictation(transcribeOnGateway = enabled)))

        /** Whether a watch recording's question-or-note decision is made by the gateway's decision model. */
        fun useDecisionGateForWatch(enabled: Boolean) =
            DictationConfigPatch(Inference(Dictation(useDecisionGateForWatch = enabled)))
    }
}
