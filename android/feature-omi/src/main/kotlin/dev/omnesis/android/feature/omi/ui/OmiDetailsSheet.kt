// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.feature.omi.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.style.TextAlign
import dev.omnesis.android.designsystem.theme.OmSpacing
import dev.omnesis.android.designsystem.theme.OmTheme
import dev.omnesis.android.feature.omi.OmiDetails
import dev.omnesis.android.feature.omi.OmiLinkService
import dev.omnesis.android.feature.omi.OmiStatus
import java.util.Locale

/**
 * Everything the pendant reports about itself, in the order its owner looks
 * for it: what it is, how it is doing, how it is linked, its settings, what it
 * keeps on its own storage, and what its firmware supports. Stateless, so the
 * screenshot tests render it with invented values.
 */
@Composable
fun OmiDetailsContent(status: OmiStatus, details: OmiDetails?, onFind: () -> Unit) {
    val c = OmTheme.colors
    Column(
        Modifier
            .fillMaxWidth()
            .verticalScroll(rememberScrollState())
            .padding(horizontal = OmSpacing.lg)
            .padding(bottom = OmSpacing.xl),
    ) {
        Text("Omi pendant", style = MaterialTheme.typography.titleLarge, color = c.textPrimary)
        Spacer(Modifier.height(OmSpacing.xs))
        Text(OmiLinkService.statusLine(status), style = MaterialTheme.typography.bodyMedium, color = c.textSecondary)
        if (details == null) {
            Spacer(Modifier.height(OmSpacing.lg))
            Text(
                "The pendant has not linked since the app started. Its details appear once it is connected.",
                style = MaterialTheme.typography.bodyMedium,
                color = c.textMuted,
            )
            return@Column
        }
        Section("Device") {
            Row("Name", details.name)
            Row("Manufacturer", details.manufacturer)
            Row("Model", details.model)
            Row("Hardware", details.hardware)
            Row("Firmware", details.firmware)
            Row("Serial number", details.serial)
            Row("Bluetooth address", details.address)
        }
        Section("Status") {
            Row("Battery", details.battery?.let { "$it%" })
            Row("Charging", details.charging?.let { if (it) "Yes" else "No" })
            Row("Microphone off between recordings", if (details.canMute) "Supported" else "Not supported by this firmware")
        }
        Section("Link") {
            Row("Encryption", if (details.encrypted) "Paired, encrypted" else "Not encrypted")
            Row("Signal", details.rssi?.let { "$it dBm · ${signalWord(it)}" })
            Row("Packet size", details.mtu?.let { "$it bytes" })
            Row("Audio", "Opus, 16 kHz mono")
            Row("Frames lost this recording", details.framesLost?.toString())
        }
        Section("Settings") {
            Row("LED brightness", details.ledBrightness?.let { "$it%" })
            Row("Microphone gain", details.micGain?.let { "Level $it of 8" })
        }
        details.storage?.let { storage ->
            Section("Storage on the pendant") {
                Row("Used", bytes(storage.usedBytes))
                Row("Free", bytes(storage.freeBytes))
                Row("Audio not yet read", "${storage.unreadPackets} packets")
                Row("Clock", if (storage.clockSet) "Set" else "Not set")
            }
            Spacer(Modifier.height(OmSpacing.sm))
            Text(
                "Audio the pendant recorded while away from the phone. Omnesis does not download it yet.",
                style = MaterialTheme.typography.bodySmall,
                color = c.textMuted,
            )
        }
        details.features?.let { features ->
            Section("Supported by the firmware") {
                Text(
                    features.joinToString(" · ").ifEmpty { "Nothing reported" },
                    style = MaterialTheme.typography.bodyMedium,
                    color = c.textPrimary,
                )
            }
        }
        Spacer(Modifier.height(OmSpacing.lg))
        OutlinedButton(onClick = onFind, enabled = status is OmiStatus.Ready, modifier = Modifier.fillMaxWidth()) {
            Text("Find the pendant (vibrate)")
        }
    }
}

@Composable
private fun Section(title: String, content: @Composable () -> Unit) {
    val c = OmTheme.colors
    Spacer(Modifier.height(OmSpacing.lg))
    Text(title.uppercase(Locale.ROOT), style = MaterialTheme.typography.labelMedium, color = c.textMuted)
    Spacer(Modifier.height(OmSpacing.xs))
    HorizontalDivider(color = c.border)
    Column(verticalArrangement = Arrangement.spacedBy(OmSpacing.xs), modifier = Modifier.padding(top = OmSpacing.sm)) {
        content()
    }
}

/** A label and its value; a value the pendant did not report is left out. */
@Composable
private fun Row(label: String, value: String?) {
    value ?: return
    val c = OmTheme.colors
    androidx.compose.foundation.layout.Row(Modifier.fillMaxWidth()) {
        Text(label, style = MaterialTheme.typography.bodyMedium, color = c.textSecondary, modifier = Modifier.weight(1f))
        Spacer(Modifier.width(OmSpacing.md))
        Text(
            value,
            style = MaterialTheme.typography.bodyMedium,
            color = c.textPrimary,
            textAlign = TextAlign.End,
            modifier = Modifier.weight(1f),
        )
    }
}

internal fun signalWord(rssi: Int): String = when {
    rssi >= -60 -> "strong"
    rssi >= -75 -> "good"
    rssi >= -85 -> "weak"
    else -> "very weak"
}

internal fun bytes(n: Long): String = when {
    n >= 1_000_000_000 -> String.format(Locale.ROOT, "%.1f GB", n / 1e9)
    n >= 1_000_000 -> String.format(Locale.ROOT, "%.1f MB", n / 1e6)
    n >= 1_000 -> String.format(Locale.ROOT, "%.0f kB", n / 1e3)
    else -> "$n bytes"
}
