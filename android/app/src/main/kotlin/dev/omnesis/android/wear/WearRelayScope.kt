// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.wear

import javax.inject.Qualifier

/** The app-owned coroutine scope the watch relay's work runs in. */
@Qualifier
@Retention(AnnotationRetention.BINARY)
annotation class WearRelayScope
