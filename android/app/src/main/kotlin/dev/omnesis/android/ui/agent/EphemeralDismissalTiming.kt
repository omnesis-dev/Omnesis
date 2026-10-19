// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.ui.agent

import dev.omnesis.android.transport.dto.AgentEvent

/** Only answer text waiting behind a tool card accelerates its dismissal. */
internal fun hasPendingAnswerText(pendingTail: List<AgentEvent>): Boolean =
    pendingTail.any { it is AgentEvent.TextDelta && it.delta.isNotBlank() }

/** Batch children do not gate events; their following answer is already in the turn. */
internal fun lastAnswerTextIndex(parts: List<AgentPart>): Int =
    parts.indexOfLast { it is AgentPart.Text && it.text.isNotBlank() }
