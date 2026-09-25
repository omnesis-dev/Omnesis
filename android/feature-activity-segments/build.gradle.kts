// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

plugins {
    alias(libs.plugins.android.library)
    alias(libs.plugins.kotlin.android)
    alias(libs.plugins.kotlin.compose)
    alias(libs.plugins.kotlin.serialization)
    alias(libs.plugins.ksp)
    alias(libs.plugins.hilt)
    alias(libs.plugins.roborazzi)
}

android {
    namespace = "dev.omnesis.android.feature.activitysegments"
    compileSdk = 36
    defaultConfig {
        minSdk = 26
        // A custom runner swaps in HiltTestApplication so the instrumented
        // ActivityTransitionReceiverRoundTripTest can resolve the same Hilt
        // @EntryPoint the production receiver uses. Only affects
        // connectedAndroidTest — Robolectric's testDebugUnitTest lane never
        // reads this.
        testInstrumentationRunner = "dev.omnesis.android.feature.activitysegments.HiltTestRunner"
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions {
        jvmTarget = "17"
    }
    buildFeatures {
        compose = true
    }
    testOptions {
        unitTests {
            isIncludeAndroidResources = true
            // Non-Robolectric JVM tests touch android.util.Log (sync-path logging);
            // return defaults instead of throwing "not mocked".
            isReturnDefaultValues = true
            all {
                it.maxHeapSize = "4g"
            }
        }
    }
}

roborazzi {
    compare {
        outputDir.set(layout.buildDirectory.dir("outputs/roborazzi-compare"))
    }
}

dependencies {
    implementation(project(":core-transport"))
    implementation(project(":core-designsystem"))
    implementation(project(":core-setup"))

    implementation(libs.androidx.work.runtime)
    // ActivityRecognitionClient + GoogleApiAvailability — scoped to this module
    // only, never project-wide (see android/AGENTS.md task spec).
    implementation(libs.play.services.location)
    implementation(libs.kotlinx.coroutines.play.services)

    implementation(platform(libs.androidx.compose.bom))
    implementation(libs.bundles.compose)
    implementation(libs.androidx.compose.material.icons.extended)
    implementation(libs.androidx.activity.compose)
    implementation(libs.androidx.lifecycle.viewmodel.compose)
    implementation(libs.androidx.lifecycle.runtime.compose)
    implementation(libs.androidx.hilt.navigation.compose)
    implementation(libs.kotlinx.coroutines.android)
    implementation(libs.kotlinx.serialization.json)
    implementation(libs.hilt.android)
    ksp(libs.hilt.compiler)
    debugImplementation(libs.androidx.compose.ui.tooling)

    testImplementation(libs.junit)
    testImplementation(libs.kotlinx.coroutines.test)
    testImplementation(libs.turbine)
    testImplementation(libs.robolectric)
    testImplementation(libs.okhttp.mockwebserver)
    testImplementation(libs.androidx.work.testing)
    testImplementation(libs.roborazzi)
    testImplementation(libs.roborazzi.compose)
    testImplementation(platform(libs.androidx.compose.bom))
    testImplementation(libs.androidx.compose.ui.test.junit4)

    androidTestImplementation(libs.androidx.test.runner)
    androidTestImplementation(libs.androidx.test.rules)
    androidTestImplementation(libs.androidx.test.core.ktx)
    androidTestImplementation(libs.androidx.test.ext.junit)
    androidTestImplementation(libs.kotlinx.coroutines.test)
    androidTestImplementation(libs.hilt.android)
    androidTestImplementation(libs.hilt.android.testing)
    kspAndroidTest(libs.hilt.compiler)
}
