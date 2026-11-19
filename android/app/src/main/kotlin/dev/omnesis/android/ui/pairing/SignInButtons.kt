// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.ui.pairing

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.Image
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Key
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import dev.omnesis.android.R
import dev.omnesis.android.designsystem.theme.OmTheme

/** The shape and size every sign-in button shares. */
internal val SignInButtonShape = RoundedCornerShape(8.dp)
internal val SignInButtonPadding = PaddingValues(horizontal = 12.dp, vertical = 10.dp)
internal val SignInButtonMinHeight = 48.dp

internal const val CLOUD_ACCOUNT_SIGN_IN = "Sign in with cloud account"

/** The pairing entry's one way into the Omnesis account. The next step asks how to sign in. */
@Composable
internal fun CloudAccountSignInButton(onClick: () -> Unit, modifier: Modifier = Modifier) {
    Button(
        onClick = onClick,
        modifier = modifier.heightIn(min = SignInButtonMinHeight),
        shape = SignInButtonShape,
        colors = ButtonDefaults.buttonColors(containerColor = OmTheme.colors.accent, contentColor = Color.White),
        contentPadding = SignInButtonPadding,
    ) {
        Text(CLOUD_ACCOUNT_SIGN_IN, style = MaterialTheme.typography.labelLarge, textAlign = TextAlign.Center)
    }
}

/** Google's own sign-in button style: white, with its mark, in both themes. */
@Composable
internal fun GoogleSignInButton(text: String = "Sign in with Google", modifier: Modifier = Modifier, onClick: () -> Unit) {
    OutlinedButton(
        onClick = onClick,
        modifier = modifier.heightIn(min = SignInButtonMinHeight),
        colors = ButtonDefaults.outlinedButtonColors(containerColor = Color.White, contentColor = Color(0xFF1F1F1F)),
        border = BorderStroke(1.dp, Color(0xFF747775)),
        shape = SignInButtonShape,
        contentPadding = SignInButtonPadding,
    ) {
        Image(painterResource(R.drawable.google_sign_in_mark), contentDescription = null, modifier = Modifier.size(20.dp).testTag("google.signIn.mark"))
        Spacer(Modifier.width(10.dp))
        Text(text, style = MaterialTheme.typography.labelLarge, textAlign = TextAlign.Center)
    }
}

@Composable
internal fun PasskeySignInButton(onClick: () -> Unit, modifier: Modifier = Modifier) {
    val colors = OmTheme.colors
    OutlinedButton(
        onClick = onClick,
        shape = SignInButtonShape,
        border = BorderStroke(1.dp, colors.border),
        colors = ButtonDefaults.outlinedButtonColors(containerColor = colors.bgSecondary, contentColor = colors.accent),
        contentPadding = SignInButtonPadding,
        modifier = modifier.heightIn(min = SignInButtonMinHeight),
    ) {
        Icon(Icons.Filled.Key, contentDescription = null, modifier = Modifier.size(20.dp))
        Spacer(Modifier.width(10.dp))
        Text("Sign in with Passkey", style = MaterialTheme.typography.labelLarge, textAlign = TextAlign.Center)
    }
}
