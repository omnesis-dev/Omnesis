// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath
package dev.omnesis.android.ui.access

import dev.omnesis.android.transport.dto.AccessCapability
import dev.omnesis.android.transport.dto.AccessSourceBoundary
import dev.omnesis.android.transport.dto.AccessSourceMode

/** The form after one of the level editor's steps changed its draft, as the approval's own steps change it. */
internal fun AccessAuthorizationForm.editing(change: (AccessLevelDraft) -> AccessLevelDraft): AccessAuthorizationForm = copy(level = change(level))

/** The draft with [capability] reading exactly the accounts [ids] and no account connected later. */
internal fun AccessLevelDraft.reading(capability: AccessCapability, vararg ids: String): AccessLevelDraft =
    setBoundary(AccessSourceBoundary(AccessSourceMode.ALLOWLIST, ids.sorted()), capability, true)

/** Whether the approval's draft grants [capability]. */
internal fun AccessAuthorizationForm.grants(capability: AccessCapability): Boolean = level.rule(capability) != null
