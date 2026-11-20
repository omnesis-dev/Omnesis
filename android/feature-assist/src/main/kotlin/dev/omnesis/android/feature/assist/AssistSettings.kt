// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.feature.assist

import android.content.SharedPreferences
import dev.omnesis.android.pairing.PrefsCipher
import dev.omnesis.android.pairing.PrefsCipherException
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.serialization.SerializationException
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json

/** What the user set for voice commands. */
data class AssistPreferences(
    /** Listen for the wake words while the pendant is linked. */
    val enabled: Boolean = false,
    val baseUrl: String = "",
    val hasToken: Boolean = false,
    val pipelineId: String? = null,
    val routes: List<CommandRoute> = CommandRoute.defaults,
    /** The routes whose webhook has a secret saved. */
    val webhookSecrets: Set<String> = emptySet(),
    val transcriber: TranscriberKind = TranscriberKind.GATEWAY,
    /** The app the user chose for each phone action that several apps take, by package. */
    val phoneApps: Map<PhoneActionKind, String> = emptyMap(),
)

/**
 * Voice-command settings on this phone. The Home Assistant token and each
 * webhook's secret are sealed with [cipher] (a Keystore key on a device);
 * everything else is plain.
 */
class AssistSettings(private val prefs: SharedPreferences, private val cipher: PrefsCipher) {
    private val json = Json { ignoreUnknownKeys = true; encodeDefaults = true }
    private val _state = MutableStateFlow(read())
    val state: StateFlow<AssistPreferences> = _state.asStateFlow()

    /** Where Home Assistant is; null until an address and a token are set. */
    fun config(): AssistConfig? {
        val p = _state.value
        if (p.baseUrl.isBlank()) return null
        val token = open(prefs.getString(KEY_TOKEN, null)) ?: return null
        return AssistConfig(p.baseUrl, token, p.pipelineId)
    }

    fun setEnabled(enabled: Boolean) = edit { putBoolean(KEY_ENABLED, enabled) }

    fun setConnection(baseUrl: String, token: String?) = edit {
        putString(KEY_URL, baseUrl.trim())
        if (token != null) putString(KEY_TOKEN, cipher.seal(token.trim()))
    }

    fun setPipeline(id: String?) = edit { if (id.isNullOrBlank()) remove(KEY_PIPELINE) else putString(KEY_PIPELINE, id) }

    /**
     * Keep [routes]. A wake word can lead to one destination only, so a list
     * naming a word twice is refused; the secrets of routes no longer listed
     * are forgotten.
     */
    fun setRoutes(routes: List<CommandRoute>) {
        require(routes.map { it.wakeWord }.toSet().size == routes.size) { "A wake word appears in two routes" }
        val ids = routes.map { it.id }.toSet()
        edit {
            putString(KEY_ROUTES, json.encodeToString(routes))
            _state.value.webhookSecrets.filter { it !in ids }.forEach { remove(secretKey(it)) }
        }
    }

    fun setWebhookSecret(routeId: String, secret: String?) = edit {
        if (secret.isNullOrBlank()) remove(secretKey(routeId)) else putString(secretKey(routeId), cipher.seal(secret.trim()))
    }

    fun webhookSecret(routeId: String): String? = open(prefs.getString(secretKey(routeId), null))

    fun setTranscriber(kind: TranscriberKind) = edit { putString(KEY_TRANSCRIBER, kind.name) }

    fun setPhoneApp(kind: PhoneActionKind, packageName: String?) = edit {
        if (packageName.isNullOrBlank()) remove(phoneAppKey(kind)) else putString(phoneAppKey(kind), packageName)
    }

    /** Forget every setting and switch listening off. */
    fun clear() = edit { clear() }

    private fun open(sealed: String?): String? = sealed?.let {
        try {
            cipher.open(it)
        } catch (_: PrefsCipherException) {
            null
        }
    }

    private fun edit(block: SharedPreferences.Editor.() -> Unit) {
        prefs.edit().apply(block).apply()
        _state.value = read()
    }

    private fun read() = AssistPreferences(
        enabled = prefs.getBoolean(KEY_ENABLED, false),
        baseUrl = prefs.getString(KEY_URL, "") ?: "",
        hasToken = prefs.contains(KEY_TOKEN),
        pipelineId = prefs.getString(KEY_PIPELINE, null),
        routes = readRoutes(),
        webhookSecrets = prefs.all.keys.filter { it.startsWith(SECRET_PREFIX) }.map { it.removePrefix(SECRET_PREFIX) }.toSet(),
        transcriber = prefs.getString(KEY_TRANSCRIBER, null)
            ?.let { name -> TranscriberKind.entries.firstOrNull { it.name == name } }
            ?: TranscriberKind.GATEWAY,
        phoneApps = PhoneActionKind.entries.mapNotNull { k -> prefs.getString(phoneAppKey(k), null)?.let { k to it } }.toMap(),
    )

    private fun readRoutes(): List<CommandRoute> {
        val raw = prefs.getString(KEY_ROUTES, null) ?: return CommandRoute.defaults
        return try {
            json.decodeFromString<List<CommandRoute>>(raw)
        } catch (_: SerializationException) {
            CommandRoute.defaults
        } catch (_: IllegalArgumentException) {
            CommandRoute.defaults
        }
    }

    private fun secretKey(routeId: String) = "$SECRET_PREFIX$routeId"

    private fun phoneAppKey(kind: PhoneActionKind) = "phone_app:${kind.name}"

    companion object {
        const val PREFS_NAME = "omnesis_assist"
        private const val KEY_ENABLED = "enabled"
        private const val KEY_URL = "base_url"
        private const val KEY_TOKEN = "token"
        private const val KEY_PIPELINE = "pipeline"
        private const val KEY_ROUTES = "routes"
        private const val KEY_TRANSCRIBER = "transcriber"
        private const val SECRET_PREFIX = "webhook_secret:"
    }
}
