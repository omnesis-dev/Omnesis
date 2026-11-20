// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.feature.assist

import android.util.Log
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.Serializable
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import java.io.IOException
import java.util.concurrent.TimeUnit

/** The JSON a webhook receives for one command. */
@Serializable
data class WebhookCommand(
    /** What was said after the wake word. */
    val text: String,
    /** The wake word's id, so one receiver can serve several words. */
    val wakeWord: String,
    /** The phone's language, as a BCP 47 tag. */
    val locale: String?,
    /** When the command was heard, ISO 8601 in UTC. */
    val at: String,
)

/**
 * Posts a command to a webhook the user set up (n8n, Node-RED, a script of
 * their own). A 2xx answer counts as done; anything else, or no answer within
 * [timeoutMs], as failed. Nothing is retried: a command that cannot be
 * delivered now is never delivered later.
 */
class WebhookClient(http: OkHttpClient, timeoutMs: Long = 10_000) {
    private val http = http.newBuilder().callTimeout(timeoutMs, TimeUnit.MILLISECONDS).build()
    private val json = Json { encodeDefaults = true }

    suspend fun send(url: String, secret: String?, command: WebhookCommand): AssistOutcome {
        if (!isWebhookUrl(url)) return AssistOutcome.Failed("no webhook address")
        val request = try {
            Request.Builder()
                .url(url.trim())
                .post(json.encodeToString(command).toRequestBody(JSON))
                .apply { if (!secret.isNullOrBlank()) header("Authorization", "Bearer $secret") }
                .build()
        } catch (e: IllegalArgumentException) {
            return AssistOutcome.Failed("bad webhook address")
        }
        return withContext(Dispatchers.IO) {
            try {
                http.newCall(request).execute().use { response ->
                    if (response.isSuccessful) AssistOutcome.Done(null) else AssistOutcome.Failed("HTTP ${response.code}")
                }
            } catch (e: IOException) {
                Log.w(TAG, "Webhook could not be reached: ${e.message}")
                AssistOutcome.Failed("unreachable")
            }
        }
    }

    private companion object {
        const val TAG = "Omnesis:Assist"
        val JSON = "application/json; charset=utf-8".toMediaType()
    }
}
