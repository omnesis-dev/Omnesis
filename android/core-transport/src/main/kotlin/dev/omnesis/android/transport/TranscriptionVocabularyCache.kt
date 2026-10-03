// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.transport

import dev.omnesis.android.transport.client.TranscriptionVocabularySnapshot
import java.text.Normalizer
import java.util.Locale
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.launch

/** Memory-only cache. Reads never wait for HTTP; reset invalidates even uncancellable old replies. */
class TranscriptionVocabularyCache(private val now: () -> Long = { System.nanoTime() / 1_000_000 }) {
    private data class Key(val purpose: String, val locale: String)
    private data class Cached(val phrases: List<String>, val refreshAt: Long, val expiresAt: Long)
    private var generation = 0L
    private var owner = 0L
    private var enabled = false
    private var denied = false
    private var cachedLocale: String? = null
    private val values = mutableMapOf<Key, Cached>()
    private val pending = mutableSetOf<Key>()
    private val retryAt = mutableMapOf<Key, Long>()

    @Synchronized fun ownerToken(): Long = owner

    @Synchronized fun reset(expectedOwner: Long? = null) {
        if (expectedOwner != null && expectedOwner != owner) return
        owner++
        generation++
        enabled = false
        denied = false
        cachedLocale = null
        values.clear()
        pending.clear()
        retryAt.clear()
    }

    @Synchronized fun phrases(purpose: String, locale: String): List<String> {
        if (!enabled || denied) return emptyList()
        return values[Key(purpose, locale)]?.takeIf { now() < it.expiresAt }?.phrases.orEmpty()
    }

    /** Called after authenticated status/foreground polls, in the pairing-owned coroutine scope. */
    @Synchronized fun warm(
        active: Boolean,
        locale: String,
        scope: CoroutineScope,
        ownerToken: Long? = null,
        fetch: suspend (String, String) -> TranscriptionVocabularySnapshot,
    ) {
        if (ownerToken != null && ownerToken != owner) return
        if (!active) {
            generation++
            enabled = false
            values.clear()
            pending.clear()
            retryAt.clear()
            return
        }
        enabled = true
        if (denied || !validLocale(locale)) return
        if (cachedLocale != locale) {
            generation++
            cachedLocale = locale
            values.clear()
            pending.clear()
            retryAt.clear()
        }
        for (purpose in listOf("dictation", "agent")) {
            val key = Key(purpose, locale)
            if (key in pending || now() < (retryAt[key] ?: Long.MIN_VALUE) || now() < (values[key]?.refreshAt ?: Long.MIN_VALUE)) continue
            pending.add(key)
            val captured = generation
            scope.launch {
                try {
                    val reply = fetch(purpose, locale)
                    val phrases = if (reply.enabled) boundedPhrases(reply) else emptyList()
                    synchronized(this@TranscriptionVocabularyCache) {
                        if (generation != captured || !enabled || denied) return@synchronized
                        if (!reply.enabled) {
                            generation++
                            enabled = false
                            values.clear()
                            pending.clear()
                            retryAt.clear()
                        } else {
                            val received = now()
                            values[key] = Cached(
                                phrases,
                                received + reply.refreshAfterSeconds.coerceIn(300, 1800) * 1000,
                                received + reply.expiresAfterSeconds.coerceIn(0, 86400) * 1000,
                            )
                            retryAt.remove(key)
                        }
                    }
                } catch (e: CancellationException) {
                    throw e
                } catch (e: Exception) {
                    synchronized(this@TranscriptionVocabularyCache) {
                        if (generation == captured) {
                            if (e is GatewayException.Unauthorized || e is GatewayException.Forbidden || e is GatewayException.NotFound) {
                                generation++
                                denied = true
                                values.clear()
                                pending.clear()
                            } else retryAt[key] = now() + 300_000
                        }
                    }
                } finally {
                    synchronized(this@TranscriptionVocabularyCache) {
                        if (generation == captured) pending.remove(key)
                    }
                }
            }
        }
    }

    private fun validLocale(tag: String): Boolean =
        tag.length <= 32 && Regex("[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*").matches(tag) && Locale.forLanguageTag(tag).language.isNotEmpty()

    private fun boundedPhrases(reply: TranscriptionVocabularySnapshot): List<String> {
        val seen = mutableSetOf<String>()
        var bytes = 0
        return reply.entries.take(1000).filter { it.score.isFinite() }.sortedByDescending { it.score }
            .mapNotNull { entry ->
                val text = Normalizer.normalize(entry.text.takeIf { it.length <= 512 } ?: return@mapNotNull null, Normalizer.Form.NFC).trim()
                if (text.isEmpty() || text.any { Character.isISOControl(it) || Character.getType(it) == Character.FORMAT.toInt() }) return@mapNotNull null
                val size = text.toByteArray(Charsets.UTF_8).size
                if (bytes + size > 8192 || !seen.add(text.lowercase(Locale.ROOT))) return@mapNotNull null
                bytes += size
                text
            }.take(100)
    }
}
