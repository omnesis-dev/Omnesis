// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.ui.models

import dev.omnesis.android.transport.client.AdminClient
import dev.omnesis.android.transport.dto.ModelsOverview
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.sync.Semaphore
import kotlinx.coroutines.sync.withPermit

/** Loads provider art from the paired gateway, never from Models.dev on the device. */
internal object ProviderLogoLoader {
    private const val MAX_CONCURRENT_FETCHES = 4
    private val NON_PROVIDER_IDS = setOf("local", "http", "none", "replay", "unresolved")

    fun providers(overview: ModelsOverview): Set<String> = buildSet {
        addAll(presetLogoSources(overview).values)
        overview.assignmentDisplays.values.mapTo(this) { it.providerId }
        overview.modelControls.forEach { (_, info) ->
            if (info.providerId.isNotBlank()) {
                add(info.providerId)
            }
        }
    }.filterTo(mutableSetOf()) {
        it !in NON_PROVIDER_IDS && it.matches(Regex("[a-z0-9][a-z0-9-]*"))
    }

    /**
     * Presets by id, mapped to the id their logo is served under: the
     * models.dev provider id when the preset (or its decision API) names one.
     * TypeSafe's built-in slot is left out; "Other server" is no preset at all.
     */
    fun presetLogoSources(overview: ModelsOverview): Map<String, String> =
        overview.providers
            .filter { it.builtIn == null && it.id.isNotBlank() }
            .associate { it.id to it.logoId }

    /**
     * Fetch the logos not yet in [cached]. A provider the gateway has no logo
     * for is recorded as an empty entry, so it is not asked for again; the
     * icon then shows its neutral glyph.
     */
    suspend fun load(
        admin: AdminClient,
        ids: Set<String>,
        cached: Map<String, String>,
        overview: ModelsOverview? = null,
    ): Map<String, String> = coroutineScope {
        val missing = ids - cached.keys
        val semaphore = Semaphore(MAX_CONCURRENT_FETCHES)
        val fetched = missing.map { id ->
            async {
                semaphore.withPermit {
                    id to (runCatching { checkedSvg(admin.providerLogo(id)) }.getOrNull() ?: MISSING)
                }
            }
        }.awaitAll().toMap()
        val merged = cached + fetched
        val aliases = overview?.modelControls?.mapNotNull { (assignment, info) ->
            val backend = assignment.substringBefore('/', missingDelimiterValue = "")
            merged[info.providerId]?.let { logo -> backend.takeIf { it.isNotBlank() }?.let { it to logo } }
        }?.toMap().orEmpty()
        val presetAliases = overview?.let(::presetLogoSources).orEmpty()
            .mapNotNull { (presetId, source) -> merged[source]?.let { presetId to it } }
            .toMap()
        merged + aliases + presetAliases
    }

    private const val MISSING = ""

    private fun checkedSvg(svg: String): String {
        require(svg.trimStart().startsWith("<svg")) { "gateway response was not SVG" }
        return svg
    }
}
