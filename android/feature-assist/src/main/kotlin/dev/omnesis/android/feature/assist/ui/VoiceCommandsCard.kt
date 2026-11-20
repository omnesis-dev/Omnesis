// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.feature.assist.ui

import android.Manifest
import android.content.ActivityNotFoundException
import android.content.pm.PackageManager
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.provider.OpenableColumns
import android.provider.Settings
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.selection.toggleable
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Delete
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.RadioButton
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.scale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import androidx.core.content.ContextCompat
import androidx.hilt.navigation.compose.hiltViewModel
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.ViewModel
import androidx.lifecycle.compose.LifecycleEventEffect
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewModelScope
import dagger.hilt.android.lifecycle.HiltViewModel
import dagger.hilt.android.qualifiers.ApplicationContext
import dev.omnesis.android.designsystem.components.OmSpinner
import dev.omnesis.android.designsystem.components.OmnesisCard
import dev.omnesis.android.designsystem.theme.OmSpacing
import dev.omnesis.android.designsystem.theme.OmTheme
import dev.omnesis.android.feature.assist.AssistCheck
import dev.omnesis.android.feature.assist.AssistConfig
import dev.omnesis.android.feature.assist.AssistPipeline
import dev.omnesis.android.feature.assist.AssistPipelineClient
import dev.omnesis.android.feature.assist.AssistSettings
import dev.omnesis.android.feature.assist.CommandRoute
import dev.omnesis.android.feature.assist.CommandTranscription
import dev.omnesis.android.feature.assist.Destination
import dev.omnesis.android.feature.assist.PhoneActionCatalog
import dev.omnesis.android.feature.assist.PhoneActionKind
import dev.omnesis.android.feature.assist.PhoneActionRunner
import dev.omnesis.android.feature.assist.TranscriberKind
import dev.omnesis.android.feature.assist.TranscriptionTiming
import dev.omnesis.android.feature.assist.WakeWord
import dev.omnesis.android.feature.assist.WakeWordModelCatalog
import dev.omnesis.android.feature.assist.WakeWordModelStore
import dev.omnesis.android.feature.assist.isWebhookUrl
import java.io.IOException
import java.util.UUID
import javax.inject.Inject
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.flowOn
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/** One route as the card shows it. */
data class RouteRow(
    val route: CommandRoute,
    /** Null when the word it names is gone (an imported model deleted). */
    val word: WakeWord?,
    val installed: Boolean,
    val hasSecret: Boolean = false,
)

/** One action of the standard catalogue, as the card shows it. */
data class PhoneActionRow(
    val kind: PhoneActionKind,
    /** The apps on this phone that take it. */
    val apps: List<PhoneActionCatalog.App>,
    /** The app that will carry it out; null when none does or the user must choose. */
    val app: PhoneActionCatalog.App?,
) {
    /** Several apps take it and none is set to: the user picks one before it works. */
    val needsChoice: Boolean get() = app == null && apps.size > 1
}

/** Everything the voice-commands card shows. */
data class VoiceCommandsState(
    val baseUrl: String = "",
    val hasToken: Boolean = false,
    val enabled: Boolean = false,
    val pipelineId: String? = null,
    val routes: List<RouteRow> = CommandRoute.defaults.map { RouteRow(it, WakeWordModelCatalog.OK_HOME, installed = false) },
    val words: List<WakeWord> = WakeWordModelCatalog.words,
    val transcriber: TranscriberKind = TranscriberKind.GATEWAY,
    /** Why each kind cannot transcribe now; absent when it can. */
    val transcriberProblems: Map<TranscriberKind, String> = emptyMap(),
    val timings: Map<TranscriberKind, TranscriptionTiming> = emptyMap(),
    val overlayAllowed: Boolean = false,
    val phoneActions: List<PhoneActionRow> = emptyList(),
    /** Contacts may be read to call people by name, and calls placed without a tap. */
    val callingAllowed: Boolean = false,
    val downloading: Boolean = false,
    val checking: Boolean = false,
    val check: AssistCheck? = null,
    val error: String? = null,
) {
    val configured: Boolean get() = baseUrl.isNotBlank() && hasToken
    val pipelines: List<AssistPipeline> get() = (check as? AssistCheck.Ok)?.pipelines ?: emptyList()

    /** Catalogue words the routes use whose models are not on the phone yet. */
    val missing: List<WakeWord> get() = routes.filter { !it.installed }.mapNotNull { it.word }.filter { !it.custom }.distinctBy { it.id }
    val needsText: Boolean get() = routes.any { it.route.destination.needsText }
    val hasPhoneRoute: Boolean get() = routes.any { it.route.destination == Destination.PhoneAction }
    val canAddRoute: Boolean get() = words.any { w -> routes.none { it.route.wakeWord == w.id } }
    val canEnable: Boolean get() = routes.any { problem(it) == null }

    /** [row] sets timers and alarms, which needs the permission to display over other apps. */
    fun needsOverlay(row: RouteRow): Boolean = row.route.destination == Destination.PhoneAction && !overlayAllowed

    /** What keeps [row] from being heard, or null when it is ready. */
    fun problem(row: RouteRow): String? = when {
        row.word == null -> "Its wake-word model is gone; choose another."
        !row.installed && row.word.custom -> "Its imported model is missing; import it again."
        !row.installed -> "Download its model first."
        else -> when (val d = row.route.destination) {
            Destination.HomeAssistant -> if (configured) null else "Set up Home Assistant first."
            is Destination.Webhook -> if (isWebhookUrl(d.url)) null else "Enter the webhook address."
            Destination.PhoneAction -> if (overlayAllowed) null else OVERLAY_NEEDED
        }
    }

    companion object {
        const val OVERLAY_NEEDED = "Allow display over other apps to carry out phone actions."
    }
}

/** What the card can ask for; each does nothing unless overridden, so a screenshot can pass an empty one. */
interface VoiceCommandsActions {
    fun connect(baseUrl: String, token: String) {}
    fun choosePipeline(id: String?) {}
    fun setEnabled(enabled: Boolean) {}
    fun addRoute() {}
    fun removeRoute(id: String) {}
    fun chooseWord(routeId: String, wordId: String) {}
    fun chooseDestination(routeId: String, destination: Destination) {}
    fun saveWebhook(routeId: String, url: String, secret: String) {}
    fun chooseTranscriber(kind: TranscriberKind) {}
    fun allowOverlay() {}
    fun choosePhoneApp(kind: PhoneActionKind, packageName: String) {}
    fun allowCalling() {}
    fun download() {}
    fun import() {}
    fun forget() {}
}

private data class Local(
    /** Bumped whenever models change on disk, which no flow reports. */
    val models: Int = 0,
    val downloading: Boolean = false,
    val checking: Boolean = false,
    val check: AssistCheck? = null,
    val error: String? = null,
)

@HiltViewModel
class VoiceCommandsViewModel @Inject constructor(
    @ApplicationContext private val context: Context,
    private val settings: AssistSettings,
    private val client: AssistPipelineClient,
    private val models: WakeWordModelStore,
    private val transcription: CommandTranscription,
    private val phone: PhoneActionRunner,
    private val catalog: PhoneActionCatalog,
) : ViewModel() {
    private val local = MutableStateFlow(Local())

    val state: StateFlow<VoiceCommandsState> = combine(
        settings.state,
        local,
        transcription.timings,
        phone.allowed,
    ) { p, l, timings, overlayAllowed ->
        val words = models.words()
        VoiceCommandsState(
            baseUrl = p.baseUrl,
            hasToken = p.hasToken,
            enabled = p.enabled,
            pipelineId = p.pipelineId,
            routes = p.routes.map { route ->
                val word = words.firstOrNull { it.id == route.wakeWord }
                RouteRow(route, word, installed = word != null && models.installed(word), hasSecret = route.id in p.webhookSecrets)
            },
            words = words,
            transcriber = p.transcriber,
            transcriberProblems = TranscriberKind.entries.mapNotNull { k -> transcription.unavailable(k)?.let { k to it } }.toMap(),
            timings = timings,
            overlayAllowed = overlayAllowed,
            phoneActions = if (p.routes.any { it.destination == Destination.PhoneAction }) {
                PhoneActionKind.entries.map { PhoneActionRow(it, catalog.apps(it), catalog.appFor(it)) }
            } else {
                emptyList()
            },
            callingAllowed = granted(Manifest.permission.READ_CONTACTS) && granted(Manifest.permission.CALL_PHONE),
            downloading = l.downloading,
            checking = l.checking,
            check = l.check,
            error = l.error,
        )
    }
        // Asking the package manager which apps take each action is not for the main thread.
        .flowOn(Dispatchers.Default)
        .stateIn(viewModelScope, SharingStarted.Eagerly, VoiceCommandsState())

    private fun granted(permission: String) =
        ContextCompat.checkSelfPermission(context, permission) == PackageManager.PERMISSION_GRANTED

    fun choosePhoneApp(kind: PhoneActionKind, packageName: String) {
        settings.setPhoneApp(kind, packageName)
    }

    private val routes get() = settings.state.value.routes

    /** Look again at what the system settings may have changed while the user was away. */
    fun refresh() {
        phone.refresh()
        local.update { it.copy(models = it.models + 1) }
    }

    /** Save the address (and the token, when one was typed), then test them. */
    fun connect(baseUrl: String, token: String) {
        if (AssistPipelineClient.webSocketUrl(baseUrl) == null) {
            local.update { it.copy(error = "Enter the Home Assistant address as http://… or https://…") }
            return
        }
        settings.setConnection(baseUrl, token.takeIf { it.isNotBlank() })
        val config = settings.config() ?: return
        local.update { it.copy(checking = true, check = null, error = null) }
        viewModelScope.launch {
            val check = client.check(AssistConfig(config.baseUrl, config.token))
            local.update { it.copy(checking = false, check = check) }
        }
    }

    fun choosePipeline(id: String?) = settings.setPipeline(id)

    fun setEnabled(enabled: Boolean) = settings.setEnabled(enabled && state.value.canEnable)

    /** A route for the first word no route uses: the phone, unless a route already goes there. */
    fun addRoute() {
        val used = routes.map { it.wakeWord }.toSet()
        val word = models.words().firstOrNull { it.id !in used } ?: return
        val destination = if (routes.none { it.destination == Destination.PhoneAction }) Destination.PhoneAction else Destination.Webhook()
        settings.setRoutes(routes + CommandRoute(UUID.randomUUID().toString().take(8), word.id, destination))
    }

    fun removeRoute(id: String) = settings.setRoutes(routes.filter { it.id != id })

    fun chooseWord(routeId: String, wordId: String) {
        if (routes.any { it.wakeWord == wordId && it.id != routeId }) return
        settings.setRoutes(routes.map { if (it.id == routeId) it.copy(wakeWord = wordId) else it })
    }

    fun chooseDestination(routeId: String, destination: Destination) =
        settings.setRoutes(routes.map { if (it.id == routeId && it.destination::class != destination::class) it.copy(destination = destination) else it })

    fun saveWebhook(routeId: String, url: String, secret: String) {
        if (!isWebhookUrl(url)) {
            local.update { it.copy(error = "Enter the webhook address as http://… or https://…") }
            return
        }
        local.update { it.copy(error = null) }
        settings.setRoutes(routes.map { if (it.id == routeId) it.copy(destination = Destination.Webhook(url.trim())) else it })
        if (secret.isNotBlank()) settings.setWebhookSecret(routeId, secret)
    }

    fun chooseTranscriber(kind: TranscriberKind) = settings.setTranscriber(kind)

    /** Fetch the models the routes' catalogue words still miss. */
    fun download() {
        val needed = state.value.missing
        local.update { it.copy(downloading = true, error = null) }
        viewModelScope.launch {
            val error = try {
                models.download(needed)
                null
            } catch (e: IOException) {
                "The wake-word models could not be downloaded: ${e.message}"
            }
            local.update { it.copy(downloading = false, models = it.models + 1, error = error) }
        }
    }

    /** Keep the classifier at [uri] as a new wake word. */
    fun import(uri: Uri) {
        local.update { it.copy(error = null) }
        viewModelScope.launch {
            val error = try {
                val (name, bytes) = withContext(Dispatchers.IO) { read(uri) }
                models.import(name, bytes)
                null
            } catch (e: IOException) {
                "That file was not imported: ${e.message}"
            } catch (e: SecurityException) {
                "That file could not be read."
            }
            local.update { it.copy(models = it.models + 1, error = error) }
        }
    }

    fun forget() {
        settings.clear()
        models.remove()
        local.update { Local(models = it.models + 1) }
    }

    private fun read(uri: Uri): Pair<String, ByteArray> {
        val resolver = context.contentResolver
        val name = resolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use { c ->
            if (c.moveToFirst()) c.getString(0) else null
        } ?: uri.lastPathSegment ?: "wake word"
        if (!name.endsWith(".onnx", ignoreCase = true)) throw IOException("choose an openWakeWord .onnx file")
        val bytes = resolver.openInputStream(uri)?.use { it.readBytes() } ?: throw IOException("it could not be opened")
        return name to bytes
    }
}

/** Voice commands, under the pendant's card. */
@Composable
fun VoiceCommandsCard(vm: VoiceCommandsViewModel = hiltViewModel()) {
    val state by vm.state.collectAsStateWithLifecycle()
    val context = LocalContext.current
    LifecycleEventEffect(Lifecycle.Event.ON_RESUME) { vm.refresh() }
    val picker = rememberLauncherForActivityResult(ActivityResultContracts.OpenDocument()) { uri -> uri?.let(vm::import) }
    val calling = rememberLauncherForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) { vm.refresh() }
    VoiceCommandsContent(
        state = state,
        actions = object : VoiceCommandsActions {
            override fun connect(baseUrl: String, token: String) = vm.connect(baseUrl, token)
            override fun choosePipeline(id: String?) = vm.choosePipeline(id)
            override fun setEnabled(enabled: Boolean) = vm.setEnabled(enabled)
            override fun addRoute() = vm.addRoute()
            override fun removeRoute(id: String) = vm.removeRoute(id)
            override fun chooseWord(routeId: String, wordId: String) = vm.chooseWord(routeId, wordId)
            override fun chooseDestination(routeId: String, destination: Destination) {
                vm.chooseDestination(routeId, destination)
                // Ask for the permission the moment it is needed, as a runtime permission would be.
                if (destination == Destination.PhoneAction && !vm.state.value.overlayAllowed) openOverlaySettings(context)
            }
            override fun saveWebhook(routeId: String, url: String, secret: String) = vm.saveWebhook(routeId, url, secret)
            override fun chooseTranscriber(kind: TranscriberKind) = vm.chooseTranscriber(kind)
            override fun allowOverlay() = openOverlaySettings(context)
            override fun choosePhoneApp(kind: PhoneActionKind, packageName: String) = vm.choosePhoneApp(kind, packageName)
            override fun allowCalling() = calling.launch(arrayOf(Manifest.permission.READ_CONTACTS, Manifest.permission.CALL_PHONE))
            override fun download() = vm.download()
            override fun import() = picker.launch(arrayOf("application/octet-stream", "*/*"))
            override fun forget() = vm.forget()
        },
    )
}

private fun openOverlaySettings(context: Context) {
    val intent = Intent(Settings.ACTION_MANAGE_OVERLAY_PERMISSION, Uri.parse("package:${context.packageName}"))
        .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
    try {
        context.startActivity(intent)
    } catch (_: ActivityNotFoundException) {
        context.startActivity(Intent(Settings.ACTION_MANAGE_OVERLAY_PERMISSION).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
    }
}

/** Stateless, for the screenshot tests. */
@Composable
fun VoiceCommandsContent(state: VoiceCommandsState, actions: VoiceCommandsActions) {
    val c = OmTheme.colors
    OmnesisCard(padding = OmSpacing.lg) {
        Text(
            "Say a wake word and a command, and the destination you chose for that word carries it out. The phone " +
                "listens to the pendant for the wake words; only the command after one is sent, and nothing is recorded. " +
                "Three short vibrations mean done, one long one that it did not work.",
            style = MaterialTheme.typography.bodySmall,
            color = c.textSecondary,
        )

        Section("Wake words")
        state.routes.forEachIndexed { i, row ->
            if (i > 0) HorizontalDivider(Modifier.padding(vertical = OmSpacing.sm), color = c.border)
            RouteEditor(state, row, actions)
        }
        if (state.canAddRoute) {
            TextButton(onClick = actions::addRoute) { Text("Add a wake word") }
        }

        Section("Models")
        ModelsSection(state, actions)

        if (state.routes.any { it.route.destination == Destination.HomeAssistant }) {
            Section("Home Assistant")
            HomeAssistantSection(state, actions)
        }
        if (state.hasPhoneRoute && state.phoneActions.isNotEmpty()) {
            Section("Phone actions")
            PhoneActionsSection(state, actions)
        }
        if (state.needsText) {
            Section("Transcription")
            TranscriptionSection(state, actions)
        }

        Spacer(Modifier.height(OmSpacing.md))
        HorizontalDivider(color = c.border)
        Spacer(Modifier.height(OmSpacing.sm))
        Row(
            Modifier
                .fillMaxWidth()
                .toggleable(value = state.enabled, enabled = state.canEnable, role = Role.Switch, onValueChange = actions::setEnabled),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Column(Modifier.weight(1f)) {
                Text("Listen for wake words", style = MaterialTheme.typography.bodyMedium, color = c.textPrimary)
                if (!state.canEnable) {
                    Text("Set up at least one wake word first.", style = MaterialTheme.typography.bodySmall, color = c.textMuted)
                }
            }
            Switch(checked = state.enabled, onCheckedChange = null, enabled = state.canEnable, modifier = Modifier.scale(0.78f))
        }
        state.error?.let {
            Spacer(Modifier.height(OmSpacing.sm))
            Text(it, style = MaterialTheme.typography.bodySmall, color = c.danger)
        }
        if (state.configured || state.routes.any { it.installed } || state.routes != VoiceCommandsState().routes) {
            TextButton(onClick = actions::forget, modifier = Modifier.padding(top = OmSpacing.xs)) { Text("Forget voice commands") }
        }
    }
}

@Composable
private fun Section(title: String) {
    Spacer(Modifier.height(OmSpacing.md))
    Text(title, style = MaterialTheme.typography.titleSmall, fontWeight = FontWeight.SemiBold, color = OmTheme.colors.textPrimary)
    Spacer(Modifier.height(OmSpacing.xs))
}

@Composable
private fun RouteEditor(state: VoiceCommandsState, row: RouteRow, actions: VoiceCommandsActions) {
    val c = OmTheme.colors
    val route = row.route
    Row(verticalAlignment = Alignment.CenterVertically) {
        Picker(
            label = row.word?.let { "“${it.phrase}”" } ?: "Choose a word",
            options = state.words.filter { w -> w.id == route.wakeWord || state.routes.none { it.route.wakeWord == w.id } },
            text = { "“${it.phrase}”" + if (it.custom) " · imported" else "" },
            onChoose = { actions.chooseWord(route.id, it.id) },
        )
        Text("→", style = MaterialTheme.typography.bodyMedium, color = c.textMuted)
        Picker(
            label = destinationName(route.destination),
            options = listOf(
                Destination.HomeAssistant,
                (route.destination as? Destination.Webhook) ?: Destination.Webhook(),
                Destination.PhoneAction,
            ),
            text = ::destinationName,
            onChoose = { actions.chooseDestination(route.id, it) },
        )
        Spacer(Modifier.weight(1f))
        IconButton(onClick = { actions.removeRoute(route.id) }) {
            Icon(Icons.Outlined.Delete, contentDescription = "Remove this wake word", tint = c.textMuted)
        }
    }
    val destination = route.destination
    if (destination is Destination.Webhook) WebhookEditor(row, destination, actions)
    if (destination == Destination.PhoneAction) {
        Text(
            "Timers, alarms, navigation, music, calls and more: see Phone actions below.",
            style = MaterialTheme.typography.bodySmall,
            color = c.textMuted,
        )
    }
    state.problem(row)?.takeIf { it != VoiceCommandsState.OVERLAY_NEEDED }?.let {
        Text(it, style = MaterialTheme.typography.bodySmall, color = c.warning)
    }
    // Asked for here, beside the destination that needs it, whatever else the route still lacks.
    if (state.needsOverlay(row)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(
                VoiceCommandsState.OVERLAY_NEEDED,
                style = MaterialTheme.typography.bodySmall,
                color = c.warning,
                modifier = Modifier.weight(1f),
            )
            TextButton(onClick = actions::allowOverlay) { Text("Allow") }
        }
    }
}

@Composable
private fun WebhookEditor(row: RouteRow, destination: Destination.Webhook, actions: VoiceCommandsActions) {
    var url by remember(row.route.id, destination.url) { mutableStateOf(destination.url) }
    var secret by remember(row.route.id) { mutableStateOf("") }
    OutlinedTextField(
        value = url,
        onValueChange = { url = it },
        label = { Text("Webhook address") },
        placeholder = { Text("https://automation.example.com/hook") },
        singleLine = true,
        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri),
        modifier = Modifier.fillMaxWidth(),
    )
    Spacer(Modifier.height(OmSpacing.xs))
    OutlinedTextField(
        value = secret,
        onValueChange = { secret = it },
        label = { Text(if (row.hasSecret) "Bearer secret (saved, type to replace)" else "Bearer secret (optional)") },
        singleLine = true,
        visualTransformation = PasswordVisualTransformation(),
        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password),
        modifier = Modifier.fillMaxWidth(),
    )
    Row(verticalAlignment = Alignment.CenterVertically) {
        OutlinedButton(
            onClick = {
                actions.saveWebhook(row.route.id, url, secret)
                secret = ""
            },
            enabled = url.isNotBlank() && (url.trim() != destination.url || secret.isNotBlank()),
        ) { Text("Save") }
        Spacer(Modifier.width(OmSpacing.sm))
        Text(
            "Receives the command's text as JSON.",
            style = MaterialTheme.typography.bodySmall,
            color = OmTheme.colors.textMuted,
        )
    }
}

@Composable
private fun ModelsSection(state: VoiceCommandsState, actions: VoiceCommandsActions) {
    val c = OmTheme.colors
    val missing = state.missing
    if (missing.isEmpty()) {
        Text("Every wake word's model is on this phone.", style = MaterialTheme.typography.bodySmall, color = c.textMuted)
    } else {
        Text(
            "The models are not part of the app. They are downloaded to this phone from where they are published and " +
                "checked before use:",
            style = MaterialTheme.typography.bodySmall,
            color = c.textMuted,
        )
        missing.forEach {
            Text("• “${it.phrase}”: ${it.origin}", style = MaterialTheme.typography.bodySmall, color = c.textMuted)
        }
        Spacer(Modifier.height(OmSpacing.xs))
        Row(verticalAlignment = Alignment.CenterVertically) {
            OutlinedButton(onClick = actions::download, enabled = !state.downloading) {
                Text(if (state.downloading) "Downloading…" else "Download the models")
            }
            if (state.downloading) {
                Spacer(Modifier.width(OmSpacing.sm))
                OmSpinner(modifier = Modifier.size(16.dp), strokeWidth = 2.dp)
            }
        }
    }
    Spacer(Modifier.height(OmSpacing.xs))
    Text(
        "Any openWakeWord model works too: one you trained with Home Assistant's wake-word notebook, or one from a " +
            "community collection.",
        style = MaterialTheme.typography.bodySmall,
        color = c.textMuted,
    )
    TextButton(onClick = actions::import) { Text("Import a model (.onnx)") }
}

@Composable
private fun HomeAssistantSection(state: VoiceCommandsState, actions: VoiceCommandsActions) {
    var url by remember(state.baseUrl) { mutableStateOf(state.baseUrl) }
    var token by remember { mutableStateOf("") }
    Text(
        "Home Assistant hears the command itself, with the assistant you choose.",
        style = MaterialTheme.typography.bodySmall,
        color = OmTheme.colors.textMuted,
    )
    Spacer(Modifier.height(OmSpacing.xs))
    OutlinedTextField(
        value = url,
        onValueChange = { url = it },
        label = { Text("Home Assistant address") },
        placeholder = { Text("http://homeassistant.local:8123") },
        singleLine = true,
        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri),
        modifier = Modifier.fillMaxWidth(),
    )
    Spacer(Modifier.height(OmSpacing.xs))
    OutlinedTextField(
        value = token,
        onValueChange = { token = it },
        label = { Text(if (state.hasToken) "Access token (saved, type to replace)" else "Long-lived access token") },
        placeholder = { Text("From your Home Assistant profile") },
        singleLine = true,
        visualTransformation = PasswordVisualTransformation(),
        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password),
        modifier = Modifier.fillMaxWidth(),
    )
    Spacer(Modifier.height(OmSpacing.sm))
    Row(verticalAlignment = Alignment.CenterVertically) {
        OutlinedButton(
            onClick = {
                actions.connect(url, token)
                token = ""
            },
            enabled = url.isNotBlank() && (token.isNotBlank() || state.hasToken) && !state.checking,
        ) { Text("Save and test") }
        if (state.checking) {
            Spacer(Modifier.width(OmSpacing.sm))
            OmSpinner(modifier = Modifier.size(16.dp), strokeWidth = 2.dp)
        }
    }
    CheckLine(state.check)
    if (state.pipelines.isNotEmpty()) {
        Spacer(Modifier.height(OmSpacing.xs))
        PipelinePicker(state, actions::choosePipeline)
    }
}

@Composable
private fun TranscriptionSection(state: VoiceCommandsState, actions: VoiceCommandsActions) {
    val c = OmTheme.colors
    Text(
        "Webhooks and phone actions get the command as text. Choose who transcribes it.",
        style = MaterialTheme.typography.bodySmall,
        color = c.textMuted,
    )
    for (kind in TranscriberKind.entries) {
        val problem = state.transcriberProblems[kind]
        Row(
            Modifier
                .fillMaxWidth()
                .selectable(selected = state.transcriber == kind, role = Role.RadioButton, onClick = { actions.chooseTranscriber(kind) })
                .padding(vertical = OmSpacing.xs),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            RadioButton(selected = state.transcriber == kind, onClick = null)
            Spacer(Modifier.width(OmSpacing.sm))
            Column(Modifier.weight(1f)) {
                Text(
                    when (kind) {
                        TranscriberKind.GATEWAY -> "Gateway"
                        TranscriberKind.PHONE -> "This phone, on-device"
                    },
                    style = MaterialTheme.typography.bodyMedium,
                    color = c.textPrimary,
                )
                val detail = problem?.let { "Unavailable: $it" } ?: state.timings[kind]?.let(::timingLine)
                    ?: when (kind) {
                        TranscriberKind.GATEWAY -> "The audio goes to your gateway, which transcribes it."
                        TranscriberKind.PHONE -> "The audio stays on the phone."
                    }
                Text(detail, style = MaterialTheme.typography.bodySmall, color = if (problem != null) c.warning else c.textMuted)
            }
        }
    }
}

private fun timingLine(t: TranscriptionTiming): String =
    "Last command: ${seconds(t.tookMs)} for ${seconds(t.audioMs)} of audio" + if (t.heard) "." else ", nothing heard."

private fun seconds(ms: Long) = "%.1f s".format(java.util.Locale.ROOT, ms / 1000.0)

@Composable
private fun PhoneActionsSection(state: VoiceCommandsState, actions: VoiceCommandsActions) {
    val c = OmTheme.colors
    Text(
        "What the wake words for this phone can do, and with which app. An action no app on this phone takes is " +
            "not available.",
        style = MaterialTheme.typography.bodySmall,
        color = c.textMuted,
    )
    for (row in state.phoneActions) {
        Spacer(Modifier.height(OmSpacing.xs))
        Row(verticalAlignment = Alignment.CenterVertically) {
            Column(Modifier.weight(1f)) {
                Text(
                    row.kind.label,
                    style = MaterialTheme.typography.bodyMedium,
                    color = if (row.apps.isEmpty()) c.textMuted else c.textPrimary,
                )
                Text(row.kind.example, style = MaterialTheme.typography.bodySmall, color = c.textMuted)
            }
            when {
                row.apps.isEmpty() ->
                    Text("No app on this phone", style = MaterialTheme.typography.bodySmall, color = c.textMuted)
                row.kind == PhoneActionKind.OPEN_APP ->
                    Text("${row.apps.size} apps", style = MaterialTheme.typography.bodySmall, color = c.textMuted)
                row.kind.choosable && row.apps.size > 1 -> Picker(
                    label = row.app?.label ?: "Choose an app",
                    options = row.apps,
                    text = { it.label },
                    onChoose = { actions.choosePhoneApp(row.kind, it.packageName) },
                )
                else -> Text(
                    row.app?.label ?: row.apps.first().label,
                    style = MaterialTheme.typography.bodySmall,
                    color = c.textMuted,
                )
            }
        }
        if (row.needsChoice && row.kind.choosable) {
            Text("Choose the app that takes it.", style = MaterialTheme.typography.bodySmall, color = c.warning)
        }
        if (row.kind == PhoneActionKind.CALL && row.apps.isNotEmpty() && !state.callingAllowed) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(
                    "Allow contacts and calls to call people by name. Without it, spoken numbers open the dialer.",
                    style = MaterialTheme.typography.bodySmall,
                    color = c.warning,
                    modifier = Modifier.weight(1f),
                )
                TextButton(onClick = actions::allowCalling) { Text("Allow") }
            }
        }
    }
}

@Composable
private fun <T> Picker(label: String, options: List<T>, text: (T) -> String, onChoose: (T) -> Unit) {
    var open by remember { mutableStateOf(false) }
    Box {
        TextButton(onClick = { open = true }) { Text("$label ▾", maxLines = 1) }
        DropdownMenu(expanded = open, onDismissRequest = { open = false }) {
            options.forEach { option ->
                DropdownMenuItem(text = { Text(text(option)) }, onClick = { onChoose(option); open = false })
            }
        }
    }
}

private fun destinationName(d: Destination): String = when (d) {
    Destination.HomeAssistant -> "Home Assistant"
    is Destination.Webhook -> "Webhook"
    Destination.PhoneAction -> "This phone"
}

@Composable
private fun CheckLine(check: AssistCheck?) {
    val c = OmTheme.colors
    val (text, bad) = when (check) {
        null -> return
        is AssistCheck.Ok -> "Connected to Home Assistant${check.version?.let { " $it" } ?: ""}." to false
        AssistCheck.BadToken -> "Home Assistant refused the token." to true
        is AssistCheck.Unreachable -> "Home Assistant could not be reached (${check.reason})." to true
    }
    Spacer(Modifier.height(OmSpacing.xs))
    Text(text, style = MaterialTheme.typography.bodySmall, color = if (bad) c.danger else c.success)
}

@Composable
private fun PipelinePicker(state: VoiceCommandsState, onChoose: (String?) -> Unit) {
    val ok = state.check as? AssistCheck.Ok ?: return
    var open by remember { mutableStateOf(false) }
    val preferred = ok.pipelines.firstOrNull { it.id == ok.preferred }?.name
    val current = state.pipelines.firstOrNull { it.id == state.pipelineId }?.name
        ?: ("Preferred" + (preferred?.let { " ($it)" } ?: ""))
    Row(verticalAlignment = Alignment.CenterVertically) {
        Text("Assistant:", style = MaterialTheme.typography.bodySmall, color = OmTheme.colors.textSecondary)
        Box {
            TextButton(onClick = { open = true }) { Text(current) }
            DropdownMenu(expanded = open, onDismissRequest = { open = false }) {
                DropdownMenuItem(text = { Text("Preferred" + (preferred?.let { " ($it)" } ?: "")) }, onClick = { onChoose(null); open = false })
                ok.pipelines.forEach { p ->
                    DropdownMenuItem(
                        text = { Text(p.name + (p.language?.let { " · $it" } ?: "")) },
                        onClick = { onChoose(p.id); open = false },
                    )
                }
            }
        }
    }
}
