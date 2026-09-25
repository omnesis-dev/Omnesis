// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.feature.health

import android.app.Activity

/**
 * Blank activity hosting the Tier B round-trip test. Two jobs:
 *
 *  1. Launchpad for the Health Connect permission-contract intent — fired via
 *     `startActivityForResult` so the consent UI attributes the request to
 *     this (test) package.
 *  2. Foreground anchor: kept RESUMED for the duration of every sync pass so
 *     Health Connect treats the test app as foreground and reads don't need
 *     the `READ_HEALTH_DATA_IN_BACKGROUND` grant.
 */
class TierBHostActivity : Activity()
