// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.ui.settings

import android.content.Context
import dagger.hilt.android.qualifiers.ApplicationContext
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import javax.inject.Inject
import javax.inject.Singleton

/** Theme override. SYSTEM follows the device's light/dark setting. */
enum class AppearanceMode(val label: String) {
    SYSTEM("System"),
    LIGHT("Light"),
    DARK("Dark"),
}

/**
 * Persists the user's theme choice and re-themes every surface live. The root
 * composable observes [mode] and resolves it against the system setting when SYSTEM.
 */
@Singleton
class AppearanceStore @Inject constructor(@ApplicationContext context: Context) {

    private val prefs = context.getSharedPreferences("omnesis_appearance", Context.MODE_PRIVATE)

    private val _mode = MutableStateFlow(read())
    val mode: StateFlow<AppearanceMode> = _mode.asStateFlow()

    fun set(mode: AppearanceMode) {
        prefs.edit().putString(KEY, mode.name).apply()
        _mode.value = mode
    }

    private fun read(): AppearanceMode =
        runCatching { AppearanceMode.valueOf(prefs.getString(KEY, null) ?: AppearanceMode.SYSTEM.name) }
            .getOrDefault(AppearanceMode.SYSTEM)

    private companion object {
        const val KEY = "mode"
    }
}
