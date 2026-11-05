// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.ui.pairing

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Security
import androidx.compose.material3.*
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.dp
import dev.omnesis.android.R
import dev.omnesis.android.designsystem.theme.OmTheme
import dev.omnesis.android.designsystem.theme.OmnesisTheme

@Composable
fun GoogleCloudPairingPane(state: PairingViewModel.State, onSignIn: () -> Unit, onCompare: () -> Unit, onPair: () -> Unit) {
    val colors = OmTheme.colors
    Column(Modifier.fillMaxSize().background(colors.bgPrimary).verticalScroll(rememberScrollState()).padding(24.dp),
        verticalArrangement = Arrangement.spacedBy(24.dp)) {
        Icon(Icons.Outlined.Security, contentDescription = null, tint = colors.accent, modifier = Modifier.size(40.dp))
        Text("Pair securely with Google", style = MaterialTheme.typography.headlineSmall, color = colors.textPrimary)
        Text("Google finds your gateway. Your gateway approves access, and comparing a code makes sure you are connecting to it.", color = colors.textSecondary)
        state.googleHost?.let { Text(it, style = MaterialTheme.typography.bodySmall, fontFamily = FontFamily.Monospace, color = colors.textSecondary) }
        state.googleCode?.let { code ->
            Column(Modifier.fillMaxWidth().background(colors.bgSecondary, RoundedCornerShape(14.dp)).padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                Text("COMPARE THIS CODE", style = MaterialTheme.typography.labelSmall, color = colors.textSecondary)
                if (LocalDensity.current.fontScale >= 1.5f) {
                    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                        for (group in code.split('-')) Text(group, style = MaterialTheme.typography.titleMedium,
                            fontFamily = FontFamily.Monospace, fontWeight = FontWeight.Bold, color = colors.textPrimary)
                    }
                } else {
                    Text(code, style = MaterialTheme.typography.titleMedium, fontFamily = FontFamily.Monospace, fontWeight = FontWeight.Bold, color = colors.textPrimary)
                }
                Text("On the gateway itself, open its local portal or run omnesis cloud requests. Compare every group. If any differ, cancel.", color = colors.textPrimary)
            }
            if (!state.googleCompared) Button(onClick = onCompare, modifier = Modifier.testTag("pairing.google.confirmCode")) {
                Text("The codes match on my trusted device")
            }
        }
        when (state.googlePhase) {
            PairingViewModel.GooglePhase.Idle -> {
                GoogleSignInButton(onClick = onSignIn)
                Text("You can also cancel and pair by QR code. Google sign-in is optional.", color = colors.textSecondary, style = MaterialTheme.typography.bodySmall)
            }
            PairingViewModel.GooglePhase.SigningIn -> Text("Complete sign-in with the Google account picker.", color = colors.textSecondary)
            PairingViewModel.GooglePhase.Finding -> Text("Finding your gateway…", color = colors.textSecondary)
            PairingViewModel.GooglePhase.Comparing -> Text("Compare the code before continuing.", color = colors.textSecondary)
            PairingViewModel.GooglePhase.Waiting -> Text("Waiting for approval on your gateway…", color = colors.textSecondary)
            PairingViewModel.GooglePhase.Ready -> {
                Text("Code compared and gateway approved.", color = colors.textPrimary)
                Button(onClick = onPair, modifier = Modifier.testTag("pairing.google.pair")) { Text("Pair with this gateway") }
            }
            PairingViewModel.GooglePhase.Pairing -> Text("Pairing…", color = colors.textSecondary)
            PairingViewModel.GooglePhase.Failed -> {
                Text(state.error ?: "Pairing did not complete.", color = MaterialTheme.colorScheme.error)
                GoogleSignInButton(text = "Try Google sign-in again", onClick = onSignIn)
            }
        }
    }
}

fun googlePairingPreviewState(phase: PairingViewModel.GooglePhase): PairingViewModel.State {
    val code = phase in listOf(PairingViewModel.GooglePhase.Comparing, PairingViewModel.GooglePhase.Waiting,
        PairingViewModel.GooglePhase.Ready, PairingViewModel.GooglePhase.Pairing)
    return PairingViewModel.State(mode = PairingViewModel.Mode.Google, googleAvailable = true, googlePhase = phase,
        googleCode = if (code) "A1B2-C3D4-E5F6-0718-293A" else null,
        googleHost = if (code) "gateway.example.test" else null,
        googleCompared = phase in listOf(PairingViewModel.GooglePhase.Waiting, PairingViewModel.GooglePhase.Ready, PairingViewModel.GooglePhase.Pairing),
        error = if (phase == PairingViewModel.GooglePhase.Failed) "Could not pair securely. Check the gateway and try again, or scan its QR code." else null)
}

@Preview @Composable private fun GooglePairingComparePreview() {
    OmnesisTheme { GoogleCloudPairingPane(googlePairingPreviewState(PairingViewModel.GooglePhase.Comparing), {}, {}, {}) }
}
@Preview @Composable private fun GooglePairingApprovedPreview() {
    OmnesisTheme(darkTheme = true) { GoogleCloudPairingPane(googlePairingPreviewState(PairingViewModel.GooglePhase.Ready), {}, {}, {}) }
}

@Composable
internal fun GoogleSignInButton(text: String = "Sign in with Google", onClick: () -> Unit) {
    OutlinedButton(
        onClick = onClick,
        colors = ButtonDefaults.outlinedButtonColors(containerColor = Color.White, contentColor = Color(0xFF1F1F1F)),
        border = BorderStroke(1.dp, Color(0xFF747775)),
        shape = RoundedCornerShape(8.dp),
        contentPadding = PaddingValues(horizontal = 12.dp, vertical = 10.dp),
    ) {
        Image(painterResource(R.drawable.google_sign_in_mark), contentDescription = null, modifier = Modifier.size(20.dp).testTag("google.signIn.mark"))
        Spacer(Modifier.width(10.dp))
        Text(text, style = MaterialTheme.typography.labelLarge)
    }
}
