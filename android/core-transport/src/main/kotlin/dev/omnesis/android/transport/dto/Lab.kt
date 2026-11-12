// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.transport.dto

import kotlinx.serialization.Serializable

@Serializable
data class LabFlags(val brain: Boolean = false, val tasks: Boolean = false, val watches: Boolean = false)

@Serializable
data class LabFeature(val id: String, val name: String, val description: String, val enabled: Boolean, val iconSvg: String = "")

@Serializable
data class LabSnapshot(val experimental: Boolean = false, val features: List<LabFeature> = emptyList())

@Serializable
data class SetLabFeatureBody(val enabled: Boolean)
