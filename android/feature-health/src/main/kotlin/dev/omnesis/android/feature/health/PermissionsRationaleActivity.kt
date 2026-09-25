// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.feature.health

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import dev.omnesis.android.designsystem.theme.OmnesisTheme

/**
 * The privacy-policy / permissions-rationale screen Health Connect deep-links to
 * from its permission sheet (`androidx.health.ACTION_SHOW_PERMISSIONS_RATIONALE`
 * pre-14, `VIEW_PERMISSION_USAGE` + HEALTH_PERMISSIONS on Android 14+). Health
 * Connect refuses to list an app in its permission UI without this entry point.
 */
class PermissionsRationaleActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContent {
            OmnesisTheme {
                Surface(Modifier.fillMaxSize()) {
                    Column(
                        Modifier
                            .fillMaxSize()
                            .verticalScroll(rememberScrollState())
                            .padding(24.dp),
                        verticalArrangement = Arrangement.spacedBy(16.dp),
                    ) {
                        Text("How Omnesis uses your health data", style = MaterialTheme.typography.headlineSmall)
                        Text(
                            "Omnesis reads the health and fitness data you allow — activity, " +
                                "vitals, body measurements, sleep, nutrition, mindfulness, and " +
                                "workouts — to index it alongside the rest of your digital life.",
                            style = MaterialTheme.typography.bodyMedium,
                        )
                        Text(
                            "Your data is sent only to your own Omnesis gateway — a server you " +
                                "run and control — over an end-to-end encrypted connection pinned " +
                                "to your gateway's certificate. Nothing is shared with Omnesis " +
                                "developers or any third party, there are no analytics or ads, " +
                                "and no cloud service ever sees your data.",
                            style = MaterialTheme.typography.bodyMedium,
                        )
                        Text(
                            "Omnesis only reads from Health Connect; it never writes or modifies " +
                                "health records. You can revoke access for any data type at any " +
                                "time in Health Connect settings, and remove all synced data by " +
                                "deleting the Health Connect source from your gateway.",
                            style = MaterialTheme.typography.bodyMedium,
                        )
                    }
                }
            }
        }
    }
}
