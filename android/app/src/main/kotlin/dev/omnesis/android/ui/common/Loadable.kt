// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.ui.common

/**
 * Loading / content / error wrapper. Error keeps the [Throwable] so the UI can classify it.
 *
 * [Content.refreshing] is what lets a reload keep what is already on screen. The three arms are
 * otherwise exclusive, so a screen with rows had only one way to say "fetching" — go back to
 * [Loading] — and that discards the very rows the reader is holding. Pull to refresh a list and
 * it would vanish behind a full-screen spinner for the duration. The iPhone app keeps the same
 * two facts apart, as a `loading` flag beside the array, and shows its spinner only when
 * loading *and* there is nothing to show.
 */
sealed interface Loadable<out T> {
    data object Loading : Loadable<Nothing>
    data class Content<out T>(val value: T, val refreshing: Boolean = false) : Loadable<T>
    data class Error(val throwable: Throwable) : Loadable<Nothing>
}

/**
 * Begin a reload: keep whatever is on screen and mark it in flight, falling back to [Loadable
 * .Loading] when there is nothing worth keeping. This is what a refresh sets — a first load,
 * which has nothing to preserve, still sets [Loadable.Loading] directly.
 */
fun <T> Loadable<T>.reloading(): Loadable<T> = when (this) {
    is Loadable.Content -> if (refreshing) this else copy(refreshing = true)
    Loadable.Loading, is Loadable.Error -> Loadable.Loading
}

/** True while a reload is running over content that is still on screen. */
val Loadable<*>.isReloading: Boolean
    get() = this is Loadable.Content && refreshing
