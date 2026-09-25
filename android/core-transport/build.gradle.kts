// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

plugins {
    alias(libs.plugins.android.library)
    alias(libs.plugins.kotlin.android)
    alias(libs.plugins.kotlin.serialization)
}

android {
    namespace = "dev.omnesis.android.transport"
    compileSdk = 36
    defaultConfig {
        minSdk = 26
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions {
        jvmTarget = "17"
    }
    testOptions {
        unitTests {
            // Plain-JVM tests exercise android.util.Log (SSE skip logging);
            // return defaults instead of throwing "not mocked".
            isReturnDefaultValues = true
        }
    }
}

// The live-gateway E2E (GatewayLiveE2ETest) only runs when invoked with -PomnesisE2e
// (by scripts/run-android-e2e.sh). Plain `./gradlew test` skips it.
tasks.withType<Test>().configureEach {
    if (project.hasProperty("omnesisE2e")) systemProperty("omnesis.android.e2e", "1")
}

dependencies {
    implementation(libs.kotlinx.serialization.json)
    implementation(libs.kotlinx.coroutines.core)
    api(libs.okhttp)

    testImplementation(libs.junit)
    testImplementation(libs.kotlinx.coroutines.test)
    testImplementation(libs.turbine)
    testImplementation(libs.okhttp.mockwebserver)
    testImplementation(libs.okhttp.tls)
}
