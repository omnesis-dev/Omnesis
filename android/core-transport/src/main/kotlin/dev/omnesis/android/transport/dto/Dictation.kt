// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.transport.dto

import kotlinx.serialization.Serializable

/**
 * `PATCH /admin/config` body that switches gateway dictation on or off:
 * `{ "inference": { "dictation": { "transcribeOnGateway": <bool> } } }`.
 */
@Serializable
data class DictationConfigPatch(val inference: Inference) {
    @Serializable
    data class Inference(val dictation: Dictation)

    @Serializable
    data class Dictation(val transcribeOnGateway: Boolean)

    companion object {
        fun transcribeOnGateway(enabled: Boolean) = DictationConfigPatch(Inference(Dictation(enabled)))
    }
}
