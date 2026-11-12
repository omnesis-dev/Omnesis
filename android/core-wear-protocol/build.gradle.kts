// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

// The contract the Wear OS app and the phone app share for the watch relay:
// Data Layer addressing, wire messages and the pure policies both ends apply.
// A plain JVM library with no Android dependency, so either app can depend on
// it and its tests run without the Android toolchain. Its unit-test task is
// `test`, not `testDebugUnitTest`.
plugins {
    alias(libs.plugins.kotlin.jvm)
    alias(libs.plugins.kotlin.serialization)
}

java {
    sourceCompatibility = JavaVersion.VERSION_17
    targetCompatibility = JavaVersion.VERSION_17
}

kotlin {
    compilerOptions {
        jvmTarget.set(org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17)
    }
}

dependencies {
    implementation(libs.kotlinx.serialization.json)

    testImplementation(libs.junit)
}
