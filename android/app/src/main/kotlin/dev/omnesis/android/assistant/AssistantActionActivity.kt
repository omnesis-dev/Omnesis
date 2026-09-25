// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.assistant

import android.Manifest
import android.app.ComponentCaller
import android.content.pm.PackageManager
import android.content.pm.PackageManager.SIGNATURE_MATCH
import android.os.Build
import android.os.Bundle
import android.speech.tts.TextToSpeech
import android.speech.tts.UtteranceProgressListener
import android.speech.tts.Voice
import android.view.WindowManager
import androidx.activity.ComponentActivity
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.annotation.RequiresApi
import androidx.activity.viewModels
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.CheckCircle
import androidx.compose.material.icons.outlined.Close
import androidx.compose.material.icons.outlined.ErrorOutline
import androidx.compose.material.icons.outlined.Mic
import androidx.compose.material3.Button
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.core.content.ContextCompat
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import dagger.hilt.android.AndroidEntryPoint
import dev.omnesis.android.designsystem.components.OmSpinner
import dev.omnesis.android.designsystem.theme.OmSpacing
import dev.omnesis.android.designsystem.theme.OmTheme
import dev.omnesis.android.designsystem.theme.OmnesisTheme
import java.util.Locale
import java.util.UUID

/** Foreground fulfillment Activity for Google Assistant App Actions. */
@AndroidEntryPoint
class AssistantActionActivity : ComponentActivity() {
    private val viewModel: AssistantActionViewModel by viewModels()
    private var speaker: TextToSpeech? = null
    private var speakerReady = false
    private var pendingSpeech: AssistantActionUiState.Finished? = null
    private var lastSpokenMessage: String? = null
    private var deliveryGeneration = 0L
    private var permissionRequestGeneration = Long.MIN_VALUE

    override fun onCreate(savedInstanceState: Bundle?) {
        restoreAssistantDeliveryState(savedInstanceState).also {
            deliveryGeneration = it.deliveryGeneration
            permissionRequestGeneration = it.permissionRequestGeneration
        }
        // App Actions must target an exported Activity. Keep private answers out of screenshots,
        // screen sharing, and the recent-tasks snapshot even when another app explicitly invokes it.
        window.addFlags(WindowManager.LayoutParams.FLAG_SECURE)
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        initializeSpeaker()
        // Seed the ViewModel before Compose observes its default state. Otherwise a missing-text
        // action can render the same default Listening value without a StateFlow emission, and
        // the recognizer never starts.
        viewModel.handle(
            intent,
            freshDelivery = savedInstanceState == null,
            trustedDelivery = trustedInitialDelivery(),
        )
        setContent {
            OmnesisTheme {
                val state by viewModel.state.collectAsStateWithLifecycle()
                val permission = rememberLauncherForActivityResult(
                    ActivityResultContracts.RequestPermission(),
                ) { granted ->
                    if (permissionRequestGeneration == deliveryGeneration) {
                        permissionRequestGeneration = Long.MIN_VALUE
                        if (granted) {
                            viewModel.microphonePermissionGranted()
                        } else {
                            viewModel.microphoneDenied()
                        }
                    }
                }

                LaunchedEffect(state) {
                    when (state) {
                        is AssistantActionUiState.Listening -> {
                            // Partial transcripts update this state repeatedly. Only the initial
                            // empty state owns recognizer startup; restarting on every partial
                            // result drops the utterance that is already in progress.
                            if ((state as AssistantActionUiState.Listening).partialText.isNotEmpty()) {
                                return@LaunchedEffect
                            }
                            if (ContextCompat.checkSelfPermission(
                                    this@AssistantActionActivity,
                                    Manifest.permission.RECORD_AUDIO,
                                ) == PackageManager.PERMISSION_GRANTED
                            ) {
                                viewModel.startListening()
                            } else {
                                permissionRequestGeneration = deliveryGeneration
                                viewModel.awaitMicrophonePermission()
                                permission.launch(Manifest.permission.RECORD_AUDIO)
                            }
                        }
                        is AssistantActionUiState.Finished -> speak(state as AssistantActionUiState.Finished)
                        is AssistantActionUiState.AwaitingMicrophonePermission,
                        is AssistantActionUiState.ReadyToListen,
                        is AssistantActionUiState.Confirming,
                        is AssistantActionUiState.Working,
                        -> Unit
                    }
                }
                AssistantActionContent(state = state, onClose = ::finish, onConfirm = viewModel::confirm)
            }
        }
    }

    override fun onNewIntent(intent: android.content.Intent) {
        super.onNewIntent(intent)
        handleNewIntent(intent, trustedDelivery = false)
    }

    override fun onSaveInstanceState(outState: Bundle) {
        outState.saveAssistantDeliveryState(
            AssistantDeliveryState(deliveryGeneration, permissionRequestGeneration),
        )
        super.onSaveInstanceState(outState)
    }

    /** Android 15 supplies the caller for this exact delivery instead of the original launch. */
    @RequiresApi(Build.VERSION_CODES.VANILLA_ICE_CREAM)
    override fun onNewIntent(intent: android.content.Intent, caller: ComponentCaller) {
        // Activity's two-argument default dispatches to the one-argument override, which would
        // process this delivery twice. Call the base one-argument hook directly instead.
        super.onNewIntent(intent)
        handleNewIntent(intent, trustedAssistantCaller(caller.getPackage()))
    }

    private fun handleNewIntent(intent: android.content.Intent, trustedDelivery: Boolean) {
        setIntent(intent)
        deliveryGeneration++
        lastSpokenMessage = null
        pendingSpeech = null
        speaker?.stop()
        viewModel.handle(intent, freshDelivery = true, trustedDelivery = trustedDelivery)
    }

    override fun onDestroy() {
        speaker?.stop()
        speaker?.shutdown()
        speaker = null
        super.onDestroy()
    }

    override fun onPause() {
        // The exported voice surface must never retain or restart capture while obscured.
        viewModel.stopListening()
        super.onPause()
    }

    private fun initializeSpeaker() {
        speaker = TextToSpeech(applicationContext) { status ->
            speakerReady = status == TextToSpeech.SUCCESS
            if (speakerReady) {
                val offline = offlineVoice(speaker?.voices.orEmpty(), Locale.getDefault())
                speakerReady = offline != null && speaker?.setVoice(offline) == TextToSpeech.SUCCESS
            }
            if (speakerReady) {
                speaker?.setOnUtteranceProgressListener(object : UtteranceProgressListener() {
                    override fun onStart(utteranceId: String?) = Unit
                    override fun onError(utteranceId: String?) {
                        runOnUiThread {
                            // Check after crossing to the UI thread: onNewIntent may have advanced
                            // the generation while this callback was queued.
                            if (isCurrentUtterance(utteranceId, deliveryGeneration)) finish()
                        }
                    }
                    override fun onDone(utteranceId: String?) {
                        runOnUiThread {
                            if (
                                isCurrentUtterance(utteranceId, deliveryGeneration) &&
                                utteranceId?.endsWith(FINAL_UTTERANCE_SUFFIX) == true
                            ) {
                                finish()
                            }
                        }
                    }
                })
                pendingSpeech?.let(::speak)
                pendingSpeech = null
            } else {
                // The result remains visible with a Done button when this device cannot speak it.
                pendingSpeech = null
            }
        }
    }

    private fun speak(state: AssistantActionUiState.Finished) {
        if (lastSpokenMessage == state.message) return
        if (!speakerReady) {
            pendingSpeech = state
            return
        }
        lastSpokenMessage = state.message
        val chunks = ttsChunks(state.message)
        chunks.forEachIndexed { index, chunk ->
            val suffix = if (index == chunks.lastIndex) FINAL_UTTERANCE_SUFFIX else "-$index"
            val result = speaker?.speak(
                chunk,
                TextToSpeech.QUEUE_ADD,
                null,
                utteranceId(deliveryGeneration, UUID.randomUUID().toString(), suffix),
            )
            if (result == TextToSpeech.ERROR) {
                finish()
                return
            }
        }
    }

    companion object {
        const val ACTION_OPEN_FEATURE = "dev.omnesis.android.action.OPEN_ASSISTANT_FEATURE"
        const val ACTION_ASK = "dev.omnesis.android.action.ASK_OMNESIS"
        const val ACTION_CAPTURE = "dev.omnesis.android.action.CAPTURE_NOTE"
        const val EXTRA_FEATURE = "assistant_feature"
        const val EXTRA_QUESTION = "question"
        const val EXTRA_NOTE = "note"
        private const val FINAL_UTTERANCE_SUFFIX = "-final"
        private val TRUSTED_ASSISTANT_PACKAGES = setOf(
            "com.google.android.googlequicksearchbox",
            "com.google.android.apps.bard",
        )
        private const val GOOGLE_PLAY_SERVICES_PACKAGE = "com.google.android.gms"

        internal fun trustedAssistantPackage(packageName: String?, signatureMatchesGoogle: Boolean): Boolean =
            packageName in TRUSTED_ASSISTANT_PACKAGES && signatureMatchesGoogle

        internal fun offlineVoice(voices: Set<Voice>, locale: Locale): Voice? = voices
            .asSequence()
            .filter { !it.isNetworkConnectionRequired }
            .filter { it.locale.language == locale.language }
            .sortedWith(
                compareByDescending<Voice> { it.locale == locale }
                    .thenByDescending { it.quality }
                    .thenBy { it.latency }
                    .thenBy { it.name },
            )
            .firstOrNull()

        internal fun utteranceId(generation: Long, nonce: String, suffix: String): String =
            "omnesis-$generation-$nonce$suffix"

        internal fun isCurrentUtterance(id: String?, generation: Long): Boolean =
            id?.startsWith("omnesis-$generation-") == true

        fun ttsChunks(text: String, limit: Int = TextToSpeech.getMaxSpeechInputLength()): List<String> {
            require(limit > 0) { "Speech chunk limit must be positive" }
            if (text.isEmpty()) return listOf("")
            val chunks = mutableListOf<String>()
            var remaining = text
            while (remaining.length > limit) {
                val window = remaining.take(limit)
                val sentenceEnd = window.lastIndexOf(". ").takeIf { it > 0 }?.plus(1)
                val wordEnd = window.lastIndexOf(' ').takeIf { it > 0 }
                val endExclusive = sentenceEnd ?: wordEnd ?: limit
                chunks += remaining.take(endExclusive).trim()
                remaining = remaining.drop(endExclusive).trimStart()
            }
            if (remaining.isNotEmpty()) chunks += remaining
            return chunks
        }
    }

    private fun trustedInitialDelivery(): Boolean {
        // Only Android 15's ComponentCaller contract reliably identifies a startActivity caller.
        // Older APIs may report the original launcher or null, so they stay confirmation-gated.
        val callerPackage = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.VANILLA_ICE_CREAM) {
            runCatching { initialCaller.getPackage() }.getOrNull()
        } else null
        return trustedAssistantCaller(callerPackage)
    }

    private fun trustedAssistantCaller(callerPackage: String?): Boolean {
        val signaturesMatch = callerPackage != null &&
            packageManager.checkSignatures(callerPackage, GOOGLE_PLAY_SERVICES_PACKAGE) == SIGNATURE_MATCH
        return trustedAssistantPackage(callerPackage, signaturesMatch)
    }

}

internal data class AssistantDeliveryState(
    val deliveryGeneration: Long = 0,
    val permissionRequestGeneration: Long = Long.MIN_VALUE,
)

internal fun restoreAssistantDeliveryState(bundle: Bundle?): AssistantDeliveryState =
    if (bundle == null) {
        AssistantDeliveryState()
    } else {
        AssistantDeliveryState(
            deliveryGeneration = bundle.getLong(ASSISTANT_DELIVERY_GENERATION_KEY, 0),
            permissionRequestGeneration = bundle.getLong(
                ASSISTANT_PERMISSION_REQUEST_GENERATION_KEY,
                Long.MIN_VALUE,
            ),
        )
    }

internal fun Bundle.saveAssistantDeliveryState(state: AssistantDeliveryState) {
    putLong(ASSISTANT_DELIVERY_GENERATION_KEY, state.deliveryGeneration)
    putLong(ASSISTANT_PERMISSION_REQUEST_GENERATION_KEY, state.permissionRequestGeneration)
}

private const val ASSISTANT_DELIVERY_GENERATION_KEY = "assistant_delivery_generation"
private const val ASSISTANT_PERMISSION_REQUEST_GENERATION_KEY =
    "assistant_permission_request_generation"

@Composable
fun AssistantActionContent(
    state: AssistantActionUiState,
    onClose: () -> Unit,
    onConfirm: () -> Unit = {},
) {
    val colors = OmTheme.colors
    Scaffold(containerColor = colors.bgPrimary) { padding ->
        Box(Modifier.fillMaxSize().padding(padding)) {
            IconButton(onClick = onClose, modifier = Modifier.align(Alignment.TopEnd).padding(OmSpacing.sm)) {
                Icon(Icons.Outlined.Close, contentDescription = "Close", tint = colors.textSecondary)
            }
            Column(
                modifier = Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(OmSpacing.xl),
                horizontalAlignment = Alignment.CenterHorizontally,
                verticalArrangement = Arrangement.Center,
            ) {
                when (state) {
                    is AssistantActionUiState.AwaitingMicrophonePermission -> {
                        Icon(
                            Icons.Outlined.Mic,
                            contentDescription = null,
                            tint = colors.accent,
                            modifier = Modifier.size(56.dp),
                        )
                        Spacer(Modifier.height(OmSpacing.lg))
                        Text(
                            "Waiting for microphone permission…",
                            color = colors.textPrimary,
                            fontWeight = FontWeight.SemiBold,
                            textAlign = TextAlign.Center,
                        )
                    }
                    is AssistantActionUiState.ReadyToListen -> {
                        Icon(
                            Icons.Outlined.Mic,
                            contentDescription = null,
                            tint = colors.accent,
                            modifier = Modifier.size(56.dp),
                        )
                        Spacer(Modifier.height(OmSpacing.lg))
                        Text(
                            if (state.kind == AssistantActionKind.ASK) {
                                "Ready to ask Omnesis?"
                            } else {
                                "Ready to tell Omnesis?"
                            },
                            color = colors.textPrimary,
                            fontWeight = FontWeight.Bold,
                            textAlign = TextAlign.Center,
                        )
                        Spacer(Modifier.height(OmSpacing.sm))
                        Text(
                            "Your microphone starts only after you tap below.",
                            color = colors.textSecondary,
                            textAlign = TextAlign.Center,
                        )
                        Spacer(Modifier.height(OmSpacing.xl))
                        Button(onClick = onConfirm) { Text("Start listening") }
                    }
                    is AssistantActionUiState.Confirming -> {
                        Icon(
                            Icons.Outlined.Mic,
                            contentDescription = null,
                            tint = colors.accent,
                            modifier = Modifier.size(56.dp),
                        )
                        Spacer(Modifier.height(OmSpacing.lg))
                        Text(
                            if (state.kind == AssistantActionKind.ASK) "Ask Omnesis?" else "Save this note?",
                            color = colors.textPrimary,
                            fontWeight = FontWeight.Bold,
                        )
                        Spacer(Modifier.height(OmSpacing.sm))
                        Text(state.text, color = colors.textSecondary, textAlign = TextAlign.Center)
                        Spacer(Modifier.height(OmSpacing.xl))
                        Button(onClick = onConfirm) { Text("Continue") }
                    }
                    is AssistantActionUiState.Listening -> {
                        Box(
                            Modifier.size(88.dp).clip(CircleShape).background(colors.accent.copy(alpha = 0.14f)),
                            contentAlignment = Alignment.Center,
                        ) {
                            Icon(Icons.Outlined.Mic, "Listening", tint = colors.accent, modifier = Modifier.size(42.dp))
                        }
                        Spacer(Modifier.height(OmSpacing.lg))
                        Text(
                            if (state.kind == AssistantActionKind.ASK) "What would you like to ask?" else "What should Omnesis remember?",
                            color = colors.textPrimary,
                            fontWeight = FontWeight.SemiBold,
                            textAlign = TextAlign.Center,
                        )
                        if (state.partialText.isNotBlank()) {
                            Spacer(Modifier.height(OmSpacing.md))
                            Text(state.partialText, color = colors.textSecondary, textAlign = TextAlign.Center)
                        }
                    }
                    is AssistantActionUiState.Working -> {
                        OmSpinner(modifier = Modifier.size(48.dp))
                        Spacer(Modifier.height(OmSpacing.lg))
                        Text(
                            if (state.kind == AssistantActionKind.ASK) "Omnesis is answering…" else "Saving your note…",
                            color = colors.textPrimary,
                            fontWeight = FontWeight.SemiBold,
                        )
                    }
                    is AssistantActionUiState.Finished -> {
                        Icon(
                            if (state.successful) Icons.Outlined.CheckCircle else Icons.Outlined.ErrorOutline,
                            contentDescription = null,
                            tint = if (state.successful) colors.accent else colors.danger,
                            modifier = Modifier.size(56.dp),
                        )
                        Spacer(Modifier.height(OmSpacing.lg))
                        Text(state.title, color = colors.textPrimary, fontWeight = FontWeight.Bold)
                        Spacer(Modifier.height(OmSpacing.sm))
                        Text(
                            state.message,
                            color = colors.textSecondary,
                            textAlign = TextAlign.Center,
                            modifier = Modifier.fillMaxWidth(),
                        )
                        Spacer(Modifier.height(OmSpacing.xl))
                        Button(onClick = onClose) { Text("Done") }
                    }
                }
            }
        }
    }
}
