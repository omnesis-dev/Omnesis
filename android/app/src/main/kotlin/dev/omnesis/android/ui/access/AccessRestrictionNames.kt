// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath
package dev.omnesis.android.ui.access

import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.text.style.TextOverflow
import dev.omnesis.android.transport.dto.*
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.ensureActive
import kotlin.coroutines.coroutineContext

/** Hydration is for display only. Never changes refs, policies, or Apply validation. */
@Composable
internal fun AccessRestrictionNames(policy: ScopePolicy, source: AccessSourceInstance, session: ScopePreviewSession) {
    val refs = policy.rules.flatMap { it.match }.distinct()
    var labels by remember(session, policy) { mutableStateOf(refs.map { session.label(source.id, it) ?: it.identifiers?.joinToString { id -> id.value } }) }
    var failed by remember(session, policy) { mutableStateOf(false) }
    var retry by remember(session, policy) { mutableIntStateOf(0) }
    LaunchedEffect(session, policy, retry) {
        if (refs.isEmpty() || (retry == 0 && labels.all { it != null })) return@LaunchedEffect
        failed = false
        try {
            session.preview(policy)
            coroutineContext.ensureActive()
            labels = refs.map { session.label(source.id, it) ?: it.identifiers?.joinToString { id -> id.value } }
        } catch (cancelled: CancellationException) { throw cancelled }
        catch (_: Exception) { coroutineContext.ensureActive(); failed = true }
    }
    if (refs.isNotEmpty()) {
        val text = refs.take(3).mapIndexed { index, ref -> labels[index] ?: "${scopeKindTitle(ref.kind, source)} · name unavailable" }.joinToString(" · ") +
            if (refs.size > 3) " · +${refs.size - 3} more" else ""
        Text(text, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant,
            maxLines = 2, overflow = TextOverflow.Ellipsis)
        if (failed) TextButton(enabled = LocalAccessEditingEnabled.current, onClick = { retry++ }) { Text("Retry selection names") }
    }
}
