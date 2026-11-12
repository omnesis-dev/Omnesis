// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import com.android.build.api.dsl.ApplicationExtension

// The Wear OS companion app. It relays every question, note and recording
// through the phone app over the Wearable Data Layer, which only connects two
// apps that share an application id and a signing key.
plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.android)
    alias(libs.plugins.kotlin.compose)
    alias(libs.plugins.roborazzi)
}

// The application id and version are read from the phone app's evaluated
// configuration rather than derived a second time, so a custom
// OMNESIS_ANDROID_APPLICATION_ID or a release's version bump reaches both apps.
evaluationDependsOn(":app")
val phoneApp = project(":app").extensions.getByType<ApplicationExtension>().defaultConfig

android {
    namespace = "dev.omnesis.android.wear"
    compileSdk = 36

    defaultConfig {
        applicationId = requireNotNull(phoneApp.applicationId) { ":app declares no application id" }
        // Wear OS 3, the first release with the Tiles and Data Layer APIs this app uses.
        minSdk = 30
        // Wear OS 5.1. Wear Compose 1.4 predates the Android 16 back-gesture
        // changes a higher target opts into.
        targetSdk = 35
        versionCode = requireNotNull(phoneApp.versionCode) { ":app declares no version code" }
        versionName = requireNotNull(phoneApp.versionName) { ":app declares no version name" }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
        }
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
            isReturnDefaultValues = true
            all {
                // NATIVE-graphics Roborazzi captures retain large bitmaps.
                it.maxHeapSize = "4g"
            }
        }
    }
}

roborazzi {
    // Goldens are committed under `src/test/roborazzi/`; a verify run's diff
    // and actual images go to a gitignored build directory.
    compare {
        outputDir.set(layout.buildDirectory.dir("outputs/roborazzi-compare"))
    }
}

dependencies {
    implementation(project(":core-wear-protocol"))

    implementation(libs.androidx.core.ktx)
    implementation(libs.androidx.activity.compose)
    implementation(libs.androidx.lifecycle.runtime.ktx)
    implementation(libs.androidx.lifecycle.runtime.compose)
    implementation(libs.androidx.lifecycle.viewmodel.compose)
    implementation(libs.androidx.work.runtime)

    implementation(platform(libs.androidx.compose.bom))
    implementation(libs.androidx.compose.ui)
    implementation(libs.androidx.compose.ui.graphics)
    implementation(libs.androidx.compose.ui.tooling.preview)
    implementation(libs.androidx.wear.compose.material)
    implementation(libs.androidx.wear.compose.foundation)
    implementation(libs.androidx.wear.input)
    debugImplementation(libs.androidx.compose.ui.tooling)
    debugImplementation(libs.androidx.compose.ui.test.manifest)

    // Tile and complication, the watch-face entry points to the recorder.
    implementation(libs.androidx.wear.tiles)
    implementation(libs.androidx.wear.protolayout)
    implementation(libs.androidx.wear.protolayout.material)
    implementation(libs.androidx.wear.watchface.complications.data.source)
    // Tiles return Guava futures; the graph pins the empty listenablefuture
    // artifact, so full Guava supplies the class.
    implementation(libs.guava)

    implementation(libs.play.services.wearable)
    constraints {
        implementation(libs.androidx.fragment) {
            because("Play services brings in a Fragment library older than the Activity Result APIs need")
        }
    }
    implementation(libs.kotlinx.coroutines.android)
    implementation(libs.kotlinx.coroutines.play.services)

    testImplementation(libs.junit)
    testImplementation(libs.kotlinx.coroutines.test)
    testImplementation(libs.robolectric)
    testImplementation(libs.roborazzi)
    testImplementation(libs.roborazzi.compose)
    testImplementation(platform(libs.androidx.compose.bom))
    testImplementation(libs.androidx.compose.ui.test.junit4)
    testImplementation(libs.androidx.test.core.ktx)
    testImplementation(libs.androidx.work.testing)
    // The renderers the tile and complication screenshot tests draw with. They
    // carry Android resources, which a unit test only sees for dependencies of
    // the variant under test, so they are debug dependencies, not test ones.
    debugImplementation(libs.androidx.wear.tiles.renderer)
    debugImplementation(libs.androidx.wear.watchface.complications.rendering)
}
