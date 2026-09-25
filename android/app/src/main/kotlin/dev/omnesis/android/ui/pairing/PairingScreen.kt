// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.ui.pairing

import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.QrCodeScanner
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.hilt.navigation.compose.hiltViewModel
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import dev.omnesis.android.designsystem.components.OmSpinner
import dev.omnesis.android.designsystem.components.OmnesisCard
import dev.omnesis.android.designsystem.components.OmnesisPill
import dev.omnesis.android.designsystem.theme.OmRadius
import dev.omnesis.android.designsystem.theme.OmSpacing
import dev.omnesis.android.designsystem.theme.OmTheme
import dev.omnesis.android.designsystem.theme.OmnesisTheme
import dev.omnesis.android.designsystem.theme.pill

@Composable
fun PairingScreen(
    onBack: () -> Unit,
    vm: PairingViewModel = hiltViewModel(),
) {
    val state by vm.state.collectAsStateWithLifecycle()
    PairingContent(
        state = state,
        onBack = onBack,
        onShowScanner = vm::showScanner,
        onShowManual = vm::showManualEntry,
        onQrCode = vm::pairFromQr,
        onUrlChange = vm::onUrlChange,
        onCodeChange = vm::onCodeChange,
        onFingerprintChange = vm::onFingerprintChange,
        onToggleAdvanced = vm::toggleAdvanced,
        onPair = vm::pair,
        onCancelPending = vm::cancelPending,
        onConfirmPending = vm::confirmPending,
    )
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun PairingContent(
    state: PairingViewModel.State,
    onBack: () -> Unit,
    onShowScanner: () -> Unit,
    onShowManual: () -> Unit,
    onQrCode: (String) -> Unit,
    onUrlChange: (String) -> Unit,
    onCodeChange: (String) -> Unit,
    onFingerprintChange: (String) -> Unit,
    onToggleAdvanced: () -> Unit,
    onPair: () -> Unit,
    onCancelPending: () -> Unit = {},
    onConfirmPending: () -> Unit = {},
) {
    val c = OmTheme.colors
    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text("Pair with your gateway", style = MaterialTheme.typography.titleMedium, color = c.textPrimary) },
                navigationIcon = {
                    TextButton(onClick = onBack) { Text("Cancel", color = c.accent) }
                },
                colors = TopAppBarDefaults.topAppBarColors(containerColor = c.bgPrimary),
            )
        },
    ) { padding ->
        Box(
            modifier = Modifier
                .padding(padding)
                .fillMaxSize()
                .background(c.bgPrimary),
        ) {
            when (state.mode) {
                PairingViewModel.Mode.Scan -> ScannerPane(
                    state = state,
                    onQrCode = onQrCode,
                    onShowManual = onShowManual,
                )

                PairingViewModel.Mode.Manual -> ManualPane(
                    state = state,
                    onShowScanner = onShowScanner,
                    onUrlChange = onUrlChange,
                    onCodeChange = onCodeChange,
                    onFingerprintChange = onFingerprintChange,
                    onToggleAdvanced = onToggleAdvanced,
                    onPair = onPair,
                    onPairFromPayload = onQrCode,
                )
            }
        }
    }

    // Anti-MITM confirmation gate: a decoded payload waits here until the user eyeballs the
    // host + fingerprint and taps "Pair". Dismissing the sheet cancels the staged exchange.
    val pending = state.pending
    if (pending != null) {
        val sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true)
        ModalBottomSheet(
            onDismissRequest = { if (!state.isPairing) onCancelPending() },
            sheetState = sheetState,
            containerColor = c.bgPrimary,
        ) {
            PairingConfirmationSheet(
                hostAndPort = pending.hostAndPort,
                versionLabel = pending.versionLabel,
                trustKind = pending.trustKind,
                fingerprint = pending.fingerprint,
                pairing = state.isPairing,
                onCancel = onCancelPending,
                onConfirm = onConfirmPending,
            )
        }
    }
}

/**
 * Scanner-first pane (mirrors iOS `PairingView.scannerStep`). Requests CAMERA on appear via
 * the Activity Result API; on grant it mounts the live [QrScannerPreview] with a reticle and
 * instructions; on denial it shows a rationale plus a path into manual entry. "Enter code
 * manually" is always reachable, so a user who declines the camera can still pair.
 */
@Composable
private fun ScannerPane(
    state: PairingViewModel.State,
    onQrCode: (String) -> Unit,
    onShowManual: () -> Unit,
) {
    val c = OmTheme.colors
    val context = LocalContext.current
    var hasCameraPermission by remember { mutableStateOf(cameraPermissionGranted(context)) }
    var permissionRequested by remember { mutableStateOf(false) }

    val launcher = rememberLauncherForActivityResult(
        ActivityResultContracts.RequestPermission(),
    ) { granted ->
        hasCameraPermission = granted
        permissionRequested = true
    }

    // Ask once on first composition if we don't already hold the permission.
    androidx.compose.runtime.LaunchedEffect(Unit) {
        if (!hasCameraPermission) launcher.launch(android.Manifest.permission.CAMERA)
    }

    Box(modifier = Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
        if (hasCameraPermission) {
            QrScannerPreview(onQrCode = onQrCode)
            ScannerReticle()
            ScannerOverlay(isPairing = state.isPairing, onShowManual = onShowManual)
        } else {
            CameraDeniedPane(
                requested = permissionRequested,
                onRequest = { launcher.launch(android.Manifest.permission.CAMERA) },
                onShowManual = onShowManual,
            )
        }

        if (state.isPairing) {
            Box(
                modifier = Modifier
                    .fillMaxSize()
                    .background(Color.Black.copy(alpha = 0.45f)),
                contentAlignment = Alignment.Center,
            ) {
                Column(horizontalAlignment = Alignment.CenterHorizontally) {
                    OmSpinner(color = Color.White)
                    Spacer(Modifier.height(OmSpacing.md))
                    Text("Pairing…", color = Color.White, style = MaterialTheme.typography.titleMedium)
                }
            }
        }
    }
}

/** Centered square scanning frame drawn over the live preview. */
@Composable
private fun ScannerReticle() {
    Box(
        modifier = Modifier
            .fillMaxWidth(0.7f)
            .aspectRatio(1f)
            .border(2.dp, Color.White.copy(alpha = 0.9f), RoundedCornerShape(OmRadius.large)),
    )
}

/** Instruction card + "Enter code manually" affordance, pinned to the bottom of the preview. */
@Composable
private fun ScannerOverlay(isPairing: Boolean, onShowManual: () -> Unit) {
    Column(
        modifier = Modifier
            .fillMaxSize()
            .padding(OmSpacing.lg),
        verticalArrangement = Arrangement.Bottom,
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .background(Color.Black.copy(alpha = 0.55f), RoundedCornerShape(OmRadius.large))
                .padding(OmSpacing.md),
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.spacedBy(OmSpacing.xs),
        ) {
            // Three lines mirroring the iOS overlay: a prompt, the literal monospaced command the
            // user runs on the gateway host, then the scan instruction. Wording stays host-agnostic.
            Text(
                "On the gateway host, run:",
                style = MaterialTheme.typography.bodySmall,
                color = Color.White,
                textAlign = TextAlign.Center,
            )
            Text(
                "omnesis devices pair",
                style = MaterialTheme.typography.bodySmall.copy(fontFamily = FontFamily.Monospace),
                fontWeight = FontWeight.Bold,
                color = Color.White,
                textAlign = TextAlign.Center,
            )
            Text(
                "Then point the camera at the QR code shown in the terminal.",
                style = MaterialTheme.typography.bodySmall,
                color = Color.White,
                textAlign = TextAlign.Center,
            )
        }
        Spacer(Modifier.height(OmSpacing.md))
        TextButton(onClick = onShowManual, enabled = !isPairing) {
            Text("Enter code manually", color = Color.White, fontWeight = FontWeight.SemiBold)
        }
    }
}

/** Shown when the camera permission isn't granted: rationale + retry + manual fallback. */
@Composable
private fun CameraDeniedPane(
    requested: Boolean,
    onRequest: () -> Unit,
    onShowManual: () -> Unit,
) {
    val c = OmTheme.colors
    Column(
        modifier = Modifier
            .fillMaxSize()
            .padding(OmSpacing.lg),
        verticalArrangement = Arrangement.Center,
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Icon(
            Icons.Outlined.QrCodeScanner,
            contentDescription = null,
            tint = c.textMuted,
            modifier = Modifier.size(48.dp),
        )
        Spacer(Modifier.height(OmSpacing.lg))
        Text(
            if (requested) "Camera access is off" else "Scan the pairing QR code",
            style = MaterialTheme.typography.titleMedium,
            fontWeight = FontWeight.SemiBold,
            color = c.textPrimary,
            textAlign = TextAlign.Center,
        )
        Spacer(Modifier.height(OmSpacing.sm))
        Text(
            "Allow camera access to scan the QR code shown by the gateway, or enter the pairing code manually.",
            style = MaterialTheme.typography.bodyMedium,
            color = c.textSecondary,
            textAlign = TextAlign.Center,
        )
        Spacer(Modifier.height(OmSpacing.xl))
        Button(
            onClick = onRequest,
            modifier = Modifier.fillMaxWidth().height(52.dp),
            colors = ButtonDefaults.buttonColors(containerColor = c.accent, contentColor = Color.White),
        ) {
            Text("Allow camera", style = MaterialTheme.typography.titleSmall, fontWeight = FontWeight.SemiBold)
        }
        Spacer(Modifier.height(OmSpacing.sm))
        TextButton(onClick = onShowManual) {
            Text("Enter code manually", color = c.accent)
        }
    }
}

/** Manual gateway-URL + code form. Always reachable as a fallback to the camera. */
@Composable
private fun ManualPane(
    state: PairingViewModel.State,
    onShowScanner: () -> Unit,
    onUrlChange: (String) -> Unit,
    onCodeChange: (String) -> Unit,
    onFingerprintChange: (String) -> Unit,
    onToggleAdvanced: () -> Unit,
    onPair: () -> Unit,
    onPairFromPayload: (String) -> Unit,
) {
    val c = OmTheme.colors
    Column(
        modifier = Modifier
            .fillMaxSize()
            .padding(OmSpacing.lg)
            .verticalScroll(rememberScrollState()),
    ) {
        Text(
            "On the gateway host, run the pairing command, then enter the gateway address " +
                "and the code shown in the terminal.",
            style = MaterialTheme.typography.bodyMedium,
            color = c.textSecondary,
        )
        Spacer(Modifier.height(OmSpacing.lg))

        // Paste-payload path — the fastest way to pair on a simulator (no camera). Accepts the
        // raw pairing JSON (e.g. {"v":3,"gatewayUrl":...,"pairingCode":...,"fingerprint":...})
        // and decodes it through the same path as a scanned QR.
        var payload by remember { mutableStateOf("") }
        OutlinedTextField(
            value = payload,
            onValueChange = { payload = it },
            label = { Text("Paste pairing JSON") },
            placeholder = { Text("{\"v\":3,\"gatewayUrl\":…}") },
            minLines = 2,
            maxLines = 4,
            textStyle = MaterialTheme.typography.bodySmall.copy(fontFamily = FontFamily.Monospace),
            modifier = Modifier.fillMaxWidth(),
        )
        Spacer(Modifier.height(OmSpacing.sm))
        Button(
            onClick = { onPairFromPayload(payload.trim()) },
            enabled = payload.isNotBlank() && !state.isPairing,
            modifier = Modifier.fillMaxWidth().height(48.dp),
            colors = ButtonDefaults.buttonColors(containerColor = c.accent, contentColor = Color.White),
        ) {
            Text("Pair from payload", style = MaterialTheme.typography.titleSmall, fontWeight = FontWeight.SemiBold)
        }

        Spacer(Modifier.height(OmSpacing.lg))
        Text(
            "— or enter the gateway address + code manually —",
            style = MaterialTheme.typography.labelMedium,
            color = c.textMuted,
            modifier = Modifier.fillMaxWidth(),
            textAlign = TextAlign.Center,
        )
        Spacer(Modifier.height(OmSpacing.lg))

        OutlinedTextField(
            value = state.gatewayUrl,
            onValueChange = onUrlChange,
            label = { Text("Gateway URL") },
            placeholder = { Text("https://gateway.example.com") },
            singleLine = true,
            textStyle = MaterialTheme.typography.bodyMedium.copy(fontFamily = FontFamily.Monospace),
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri),
            modifier = Modifier.fillMaxWidth(),
        )
        Spacer(Modifier.height(OmSpacing.md))

        OutlinedTextField(
            value = state.pairingCode,
            onValueChange = onCodeChange,
            label = { Text("Pairing code") },
            singleLine = true,
            textStyle = MaterialTheme.typography.bodyMedium.copy(fontFamily = FontFamily.Monospace),
            modifier = Modifier.fillMaxWidth(),
        )

        TextButton(onClick = onToggleAdvanced) {
            Text(if (state.showAdvanced) "Hide advanced" else "Advanced", color = c.accent)
        }
        if (state.showAdvanced) {
            OutlinedTextField(
                value = state.fingerprint,
                onValueChange = onFingerprintChange,
                label = { Text("TLS fingerprint (SHA-256)") },
                placeholder = { Text("64 hex characters — optional") },
                singleLine = true,
                textStyle = MaterialTheme.typography.bodyMedium.copy(fontFamily = FontFamily.Monospace),
                modifier = Modifier.fillMaxWidth(),
            )
        }

        if (state.error != null) {
            Spacer(Modifier.height(OmSpacing.lg))
            Text(
                text = state.error,
                style = MaterialTheme.typography.bodyMedium,
                color = c.danger,
            )
        }

        Spacer(Modifier.height(OmSpacing.xl))
        Button(
            onClick = onPair,
            enabled = state.canSubmit,
            modifier = Modifier.fillMaxWidth().height(52.dp),
            colors = ButtonDefaults.buttonColors(containerColor = c.accent, contentColor = Color.White),
        ) {
            if (state.isPairing) {
                OmSpinner(modifier = Modifier.size(18.dp), strokeWidth = 2.dp, color = Color.White)
                Text("  Pairing…")
            } else {
                Text("Pair", style = MaterialTheme.typography.titleSmall, fontWeight = FontWeight.SemiBold)
            }
        }
        Spacer(Modifier.height(OmSpacing.sm))
        TextButton(
            onClick = onShowScanner,
            modifier = Modifier.fillMaxWidth(),
        ) {
            Icon(Icons.Outlined.QrCodeScanner, contentDescription = null, tint = c.accent, modifier = Modifier.size(18.dp))
            Text("  Scan QR code instead", color = c.accent)
        }
    }
}

/**
 * Security confirmation gate shown after a payload decodes and before any token is persisted.
 * Ports the iOS `PairingConfirmationSheet`: the host:port + TLS-version card and the
 * fingerprint card (pinned → formatted digest; legacy → a "legacy" pill + MITM warning), with
 * Cancel / Pair actions. Inputs are plain presentational values so the sheet stays decoupled
 * from the payload type.
 */
@Composable
fun PairingConfirmationSheet(
    hostAndPort: String,
    versionLabel: String,
    trustKind: PairingViewModel.TrustKind,
    fingerprint: String?,
    pairing: Boolean,
    onCancel: () -> Unit,
    onConfirm: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val c = OmTheme.colors
    Column(
        modifier = modifier
            .fillMaxWidth()
            .background(c.bgPrimary)
            .padding(OmSpacing.lg),
        verticalArrangement = Arrangement.spacedBy(OmSpacing.lg),
    ) {
        Text("Confirm pairing", style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.Bold, color = c.textPrimary)
        Text("About to pair with:", style = MaterialTheme.typography.bodyMedium, color = c.textSecondary)

        OmnesisCard {
            Text(
                "HOST",
                style = MaterialTheme.typography.labelSmall.copy(letterSpacing = 0.6.sp),
                fontWeight = FontWeight.Bold,
                color = c.textMuted,
            )
            Spacer(Modifier.height(OmSpacing.xs))
            Text(
                hostAndPort,
                style = MaterialTheme.typography.titleSmall.copy(fontFamily = FontFamily.Monospace),
                fontWeight = FontWeight.SemiBold,
                color = c.textPrimary,
            )
            Spacer(Modifier.height(OmSpacing.xs))
            Text(versionLabel, style = MaterialTheme.typography.bodySmall, color = c.textSecondary)
        }

        OmnesisCard {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(
                    if (trustKind == PairingViewModel.TrustKind.System) "TLS TRUST" else "FINGERPRINT",
                    style = MaterialTheme.typography.labelSmall.copy(letterSpacing = 0.6.sp),
                    fontWeight = FontWeight.Bold,
                    color = c.textMuted,
                )
                Spacer(Modifier.weight(1f))
                if (trustKind == PairingViewModel.TrustKind.Legacy) {
                    OmnesisPill("legacy", c.pill("needs-auth"))
                } else if (trustKind == PairingViewModel.TrustKind.System) {
                    OmnesisPill("WebPKI", c.pill("healthy"))
                }
            }
            Spacer(Modifier.height(OmSpacing.xs))
            if (trustKind == PairingViewModel.TrustKind.System) {
                Text(
                    "System WebPKI",
                    style = MaterialTheme.typography.bodyMedium,
                    fontWeight = FontWeight.Bold,
                    color = c.textPrimary,
                )
                Spacer(Modifier.height(OmSpacing.xs))
                Text(
                    "Android will verify the certificate chain and gateway hostname using the system trust store.",
                    style = MaterialTheme.typography.bodySmall,
                    color = c.textSecondary,
                )
            } else if (fingerprint != null) {
                Text(
                    fingerprintFormatted(fingerprint),
                    style = MaterialTheme.typography.labelMedium.copy(fontFamily = FontFamily.Monospace),
                    fontWeight = FontWeight.Normal,
                    color = c.textPrimary,
                    maxLines = 4,
                )
            } else {
                Text("Not pinned (legacy payload)", style = MaterialTheme.typography.bodyMedium, fontWeight = FontWeight.Bold, color = c.warning)
                Spacer(Modifier.height(OmSpacing.xs))
                Text(
                    "This code carries no certificate fingerprint, so the connection can't be " +
                        "pinned. On an untrusted network, an attacker could impersonate the gateway. " +
                        "Only continue if you trust this network.",
                    style = MaterialTheme.typography.bodySmall,
                    color = c.textSecondary,
                )
            }
        }

        Spacer(Modifier.weight(1f))

        Row(horizontalArrangement = Arrangement.spacedBy(OmSpacing.md)) {
            Button(
                onClick = onCancel,
                modifier = Modifier.weight(1f).height(48.dp),
                shape = RoundedCornerShape(OmRadius.large),
                colors = ButtonDefaults.buttonColors(containerColor = c.bgTertiary, contentColor = c.textPrimary),
            ) { Text("Cancel") }
            Button(
                onClick = onConfirm,
                enabled = !pairing,
                modifier = Modifier.weight(1f).height(48.dp),
                shape = RoundedCornerShape(OmRadius.large),
                colors = ButtonDefaults.buttonColors(containerColor = c.accent, contentColor = Color.White),
            ) { Text(if (pairing) "Pairing…" else "Pair") }
        }
    }
}

/** `aabbcc…` → `aa:bb:cc:…`, lowercased. Ports the iOS `fingerprintFormatted`. */
private fun fingerprintFormatted(raw: String): String =
    raw.filter { it.isLetterOrDigit() }
        .lowercase()
        .chunked(2)
        .joinToString(":")

// --- previews ---

@Preview(name = "Pairing · manual · empty · light")
@Composable
private fun PairingPreviewManualEmpty() {
    OmnesisTheme(darkTheme = false) {
        PairingContent(
            state = PairingViewModel.State(
                mode = PairingViewModel.Mode.Manual,
                gatewayUrl = "https://gateway.example.com",
                pairingCode = "AB-CD-EF",
            ),
            onBack = {}, onShowScanner = {}, onShowManual = {}, onQrCode = {},
            onUrlChange = {}, onCodeChange = {}, onFingerprintChange = {}, onToggleAdvanced = {}, onPair = {},
        )
    }
}

@Preview(name = "Pairing · manual · error · dark")
@Composable
private fun PairingPreviewManualError() {
    OmnesisTheme(darkTheme = true) {
        PairingContent(
            state = PairingViewModel.State(
                mode = PairingViewModel.Mode.Manual,
                gatewayUrl = "https://gateway.example.com",
                pairingCode = "WRONG",
                error = "This pairing code has already been used or has expired. Create a new one on your gateway and scan it again.",
            ),
            onBack = {}, onShowScanner = {}, onShowManual = {}, onQrCode = {},
            onUrlChange = {}, onCodeChange = {}, onFingerprintChange = {}, onToggleAdvanced = {}, onPair = {},
        )
    }
}

@Preview(name = "Pairing · scan · camera denied · dark")
@Composable
private fun PairingScanDeniedPreview() {
    OmnesisTheme(darkTheme = true) {
        CameraDeniedPane(requested = true, onRequest = {}, onShowManual = {})
    }
}

@Preview(name = "Pairing · confirm · pinned · dark")
@Composable
private fun PairingConfirmPinnedPreview() {
    OmnesisTheme(darkTheme = true) {
        PairingConfirmationSheet(
            hostAndPort = "gateway.example.com",
            versionLabel = "TLS-pinned (V3)",
            trustKind = PairingViewModel.TrustKind.PinnedLeaf,
            fingerprint = "9f1a2b3c4d5e6f70819293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8",
            pairing = false, onCancel = {}, onConfirm = {},
        )
    }
}

@Preview(name = "Pairing · confirm · legacy · light")
@Composable
private fun PairingConfirmLegacyPreview() {
    OmnesisTheme(darkTheme = false) {
        PairingConfirmationSheet(
            hostAndPort = "gateway.tailnet.ts.net:7600",
            versionLabel = "Legacy (V1)",
            trustKind = PairingViewModel.TrustKind.Legacy,
            fingerprint = null,
            pairing = false, onCancel = {}, onConfirm = {},
        )
    }
}

@Preview(name = "Pairing · confirm · system trust · light")
@Composable
private fun PairingConfirmSystemPreview() {
    OmnesisTheme(darkTheme = false) {
        PairingConfirmationSheet(
            hostAndPort = "public-gateway.example.com",
            versionLabel = "System-trusted HTTPS (V4)",
            trustKind = PairingViewModel.TrustKind.System,
            fingerprint = null,
            pairing = false, onCancel = {}, onConfirm = {},
        )
    }
}
