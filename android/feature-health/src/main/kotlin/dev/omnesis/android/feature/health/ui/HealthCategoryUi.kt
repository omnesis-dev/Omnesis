// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.feature.health.ui

import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.DirectionsRun
import androidx.compose.material.icons.outlined.Bedtime
import androidx.compose.material.icons.outlined.CalendarMonth
import androidx.compose.material.icons.outlined.FitnessCenter
import androidx.compose.material.icons.outlined.MonitorHeart
import androidx.compose.material.icons.outlined.MonitorWeight
import androidx.compose.material.icons.outlined.Restaurant
import androidx.compose.material.icons.outlined.SelfImprovement
import androidx.compose.ui.graphics.vector.ImageVector
import dev.omnesis.android.feature.health.HealthCategory

/**
 * Display metadata for one [HealthCategory] — the Android counterpart of the
 * iOS onboarding sheet's static category list. Subtitles name the headline
 * record types the catalog actually reads for that category.
 */
data class HealthCategoryUi(
    val category: HealthCategory,
    val icon: ImageVector,
    val title: String,
    val subtitle: String,
)

/** Every category, in [HealthCategory] declaration (= sync) order. */
val healthCategoryUi: List<HealthCategoryUi> = listOf(
    HealthCategoryUi(
        HealthCategory.BODY,
        Icons.Outlined.MonitorWeight,
        "Body measurements",
        "Weight, height, body fat, lean mass, BMR.",
    ),
    HealthCategoryUi(
        HealthCategory.ACTIVITY,
        Icons.AutoMirrored.Outlined.DirectionsRun,
        "Activity",
        "Steps, distance, calories, floors, VO₂ max.",
    ),
    HealthCategoryUi(
        HealthCategory.VITALS,
        Icons.Outlined.MonitorHeart,
        "Vitals",
        "Heart rate, HRV, blood pressure, SpO₂, glucose.",
    ),
    HealthCategoryUi(
        HealthCategory.SLEEP,
        Icons.Outlined.Bedtime,
        "Sleep",
        "Sleep sessions and stages from your tracker.",
    ),
    HealthCategoryUi(
        HealthCategory.NUTRITION,
        Icons.Outlined.Restaurant,
        "Nutrition",
        "Calories, macronutrients, and hydration.",
    ),
    HealthCategoryUi(
        HealthCategory.MINDFULNESS,
        Icons.Outlined.SelfImprovement,
        "Mindfulness",
        "Meditation and mindful session durations.",
    ),
    HealthCategoryUi(
        HealthCategory.EXERCISE,
        Icons.Outlined.FitnessCenter,
        "Workouts",
        "Runs, rides, swims, strength — every exercise session.",
    ),
    HealthCategoryUi(
        HealthCategory.CYCLE,
        Icons.Outlined.CalendarMonth,
        "Cycle tracking",
        "Menstruation, cervical mucus, ovulation, and sexual activity.",
    ),
)
