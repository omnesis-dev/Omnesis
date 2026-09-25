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
    namespace = "dev.omnesis.android.feature.health"
    compileSdk = 36
    defaultConfig {
        // The app stays at minSdk 26; Health Connect availability is gated at
        // runtime via HealthConnectClient.getSdkStatus (the provider needs
        // API 28+, and is a framework module on API 34+).
        minSdk = 26
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
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
        // The androidTest APK otherwise defaults its targetSdk to minSdk (26),
        // which makes Android 15 overlay a DeprecatedTargetSdkVersionDialog on
        // top of the Health Connect consent sheet and blocks the Tier B
        // permission automation.
        targetSdk = 35
        unitTests {
            isIncludeAndroidResources = true
            // Non-Robolectric JVM tests touch android.util.Log (sync-path logging);
            // return defaults instead of throwing "not mocked".
            isReturnDefaultValues = true
            all {
                // NATIVE-graphics Roborazzi captures retain large bitmaps; match the
                // app module's roomier worker heap so the suite doesn't thrash GC.
                it.maxHeapSize = "4g"
            }
        }
        managedDevices {
            // CI-style lane for the Tier B instrumented round-trip:
            //   ./gradlew :feature-health:tierbDebugAndroidTest
            // API 34 google image — Health Connect is a framework module there,
            // so the test APK talks to the real provider with no Play install.
            localDevices {
                create("tierb") {
                    device = "Pixel 7"
                    apiLevel = 34
                    systemImageSource = "google"
                }
            }
        }
    }
}

roborazzi {
    // Golden PNGs are committed under `src/test/roborazzi/` (the `filePath` each
    // `captureRoboImage` writes to) so `verifyRoborazziDebug` compares a fresh
    // render against a tracked baseline in CI. Keep the verify run's diff / actual
    // / compare artifacts in a gitignored build dir so a failing verify never
    // dirties the goldens.
    compare {
        outputDir.set(layout.buildDirectory.dir("outputs/roborazzi-compare"))
    }
}

dependencies {
    implementation(project(":core-transport"))
    implementation(project(":core-designsystem"))
    implementation(project(":core-setup"))

    implementation(libs.health.connect.client)
    implementation(libs.androidx.work.runtime)

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
    debugImplementation(libs.androidx.compose.ui.test.manifest)

    testImplementation(libs.junit)
    testImplementation(libs.kotlinx.coroutines.test)
    testImplementation(libs.turbine)
    testImplementation(libs.robolectric)
    testImplementation(libs.health.connect.testing)
    testImplementation(libs.okhttp.mockwebserver)
    testImplementation(libs.androidx.work.testing)
    // Screenshot lane (Roborazzi renders Compose to PNGs off-emulator).
    testImplementation(libs.roborazzi)
    testImplementation(libs.roborazzi.compose)
    testImplementation(platform(libs.androidx.compose.bom))
    testImplementation(libs.androidx.compose.ui.test.junit4)

    // Tier B instrumented round-trip (real Health Connect provider on a device).
    androidTestImplementation(libs.junit)
    androidTestImplementation(libs.androidx.test.runner)
    androidTestImplementation(libs.androidx.test.rules)
    androidTestImplementation(libs.androidx.test.core.ktx)
    androidTestImplementation(libs.androidx.test.ext.junit)
    androidTestImplementation(libs.androidx.test.uiautomator)
    androidTestImplementation(libs.kotlinx.coroutines.test)
}
