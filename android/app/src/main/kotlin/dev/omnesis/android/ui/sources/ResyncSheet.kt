// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.ui.sources

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.selection.selectableGroup
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.RadioButton
import androidx.compose.material3.RadioButtonDefaults
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import dev.omnesis.android.designsystem.theme.OmSpacing
import dev.omnesis.android.designsystem.theme.OmTheme
import dev.omnesis.android.designsystem.theme.OmnesisTheme
import dev.omnesis.android.transport.ResyncOffer
import dev.omnesis.android.transport.dto.ResyncMode

/**
 * The Resync sheet of a source: how to resync — in place or from scratch — with what each
 * does in plain words. In place is selected on opening, so confirming without choosing
 * anything deletes nothing; the confirm button turns red only while from scratch is selected.
 * iOS draws the same sheet and the portal the same dialog, in the same words.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun ResyncSheet(
    sourceName: String,
    offer: ResyncOffer.Choice,
    brainNote: Boolean,
    onConfirm: (ResyncMode) -> Unit,
    onDismiss: () -> Unit,
) {
    ModalBottomSheet(
        onDismissRequest = onDismiss,
        sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true),
        containerColor = OmTheme.colors.bgPrimary,
    ) {
        ResyncSheetBody(sourceName, offer, brainNote, onConfirm = onConfirm, onCancel = onDismiss)
    }
}

/**
 * The sheet's content. [initialMode] opens it on a mode other than the default one; previews
 * and screenshots use it to show each selection.
 */
@Composable
internal fun ResyncSheetBody(
    sourceName: String,
    offer: ResyncOffer.Choice,
    brainNote: Boolean,
    onConfirm: (ResyncMode) -> Unit,
    onCancel: () -> Unit,
    modifier: Modifier = Modifier,
    initialMode: ResyncMode = offer.defaultMode,
) {
    val c = OmTheme.colors
    var mode by rememberSaveable { mutableStateOf(initialMode) }
    Column(
        modifier
            .fillMaxWidth()
            .verticalScroll(rememberScrollState())
            .padding(horizontal = OmSpacing.lg)
            .padding(bottom = OmSpacing.lg),
        verticalArrangement = Arrangement.spacedBy(OmSpacing.md),
    ) {
        Text(ResyncCopy.title(sourceName), style = MaterialTheme.typography.titleMedium, color = c.textPrimary)
        Column(Modifier.selectableGroup()) {
            offer.modes.forEachIndexed { index, candidate ->
                if (index > 0) HorizontalDivider(color = c.borderLight)
                OptionRow(
                    option = ResyncCopy.option(candidate, sourceName, brainNote),
                    selected = candidate == mode,
                    onSelect = { mode = candidate },
                )
            }
        }
        ResyncCopy.footnote(offer.modes)?.let { Text(it, fontSize = 13.sp, lineHeight = 18.sp, color = c.textMuted) }
        Row(
            Modifier.fillMaxWidth().padding(top = OmSpacing.xs),
            horizontalArrangement = Arrangement.spacedBy(OmSpacing.sm, Alignment.End),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            TextButton(onClick = onCancel) { Text(ResyncCopy.CANCEL, color = c.accent) }
            val scheme = MaterialTheme.colorScheme
            val destructive = mode == ResyncMode.FROM_SCRATCH
            Button(
                onClick = { onConfirm(mode) },
                colors = ButtonDefaults.buttonColors(
                    containerColor = if (destructive) scheme.error else scheme.primary,
                    contentColor = if (destructive) scheme.onError else scheme.onPrimary,
                ),
            ) {
                Text(ResyncCopy.confirm(mode))
            }
        }
    }
}

@Composable
private fun OptionRow(option: ResyncOption, selected: Boolean, onSelect: () -> Unit) {
    val c = OmTheme.colors
    Row(
        Modifier
            .fillMaxWidth()
            .selectable(selected = selected, role = Role.RadioButton, onClick = onSelect)
            .padding(vertical = OmSpacing.md),
        horizontalArrangement = Arrangement.spacedBy(OmSpacing.sm),
        verticalAlignment = Alignment.Top,
    ) {
        RadioButton(
            selected = selected,
            onClick = null,
            modifier = Modifier.size(24.dp),
            colors = RadioButtonDefaults.colors(selectedColor = c.accent, unselectedColor = c.textSecondary),
        )
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(4.dp)) {
            Text(option.title, fontSize = 15.sp, fontWeight = FontWeight.Medium, color = c.textPrimary)
            Text(option.body, fontSize = 13.sp, lineHeight = 18.sp, color = c.textSecondary)
            option.note?.let { Text(it, fontSize = 13.sp, lineHeight = 18.sp, color = c.warning) }
        }
    }
}

@Preview(name = "Resync sheet · in place · dark")
@Composable
private fun ResyncSheetInPlaceDark() {
    OmnesisTheme(darkTheme = true) {
        ResyncSheetBody("Gmail", ResyncOffer.Choice(ResyncMode.entries), brainNote = false, onConfirm = {}, onCancel = {})
    }
}

@Preview(name = "Resync sheet · from scratch, Brain on · light")
@Composable
private fun ResyncSheetFromScratchBrainLight() {
    OmnesisTheme(darkTheme = false) {
        ResyncSheetBody(
            "Gmail", ResyncOffer.Choice(ResyncMode.entries), brainNote = true,
            onConfirm = {}, onCancel = {}, initialMode = ResyncMode.FROM_SCRATCH,
        )
    }
}
