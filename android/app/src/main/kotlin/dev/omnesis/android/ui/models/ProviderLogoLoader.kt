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
        overview.presets.mapTo(this) { it.id }
        overview.assignmentDisplays.values.mapTo(this) { it.providerId }
        overview.modelControls.forEach { (_, info) ->
            if (info.providerId.isNotBlank()) {
                add(info.providerId)
            }
        }
    }.filterTo(mutableSetOf()) {
        it !in NON_PROVIDER_IDS && it.matches(Regex("[a-z0-9][a-z0-9-]*"))
    }

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
                    runCatching { id to checkedSvg(admin.providerLogo(id)) }.getOrNull()
                }
            }
        }.awaitAll().filterNotNull().toMap()
        val merged = cached + fetched
        val aliases = overview?.modelControls?.mapNotNull { (assignment, info) ->
            val backend = assignment.substringBefore('/', missingDelimiterValue = "")
            merged[info.providerId]?.let { logo -> backend.takeIf { it.isNotBlank() }?.let { it to logo } }
        }?.toMap().orEmpty()
        merged + aliases
    }

    private fun checkedSvg(svg: String): String {
        require(svg.trimStart().startsWith("<svg")) { "gateway response was not SVG" }
        return svg
    }
}
