// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

// The Wear OS app's logic: the ask, note and recorder flows, the outbox, and
// the routing of what the phone sends, on interfaces for everything the device
// provides. A plain JVM library with no Android dependency, so its tests run
// without the Android toolchain and the phone app's tests can run the real
// watch logic against the real phone relay. Its unit-test task is `test`, not
// `testDebugUnitTest`.
plugins {
    alias(libs.plugins.kotlin.jvm)
    `java-test-fixtures`
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
    // The contract's types appear in this library's own API.
    api(project(":core-wear-protocol"))
    api(libs.kotlinx.coroutines.core)

    // The fakes the logic runs on in tests, here and in the phone app's
    // loopback tests.
    testFixturesApi(libs.kotlinx.coroutines.test)

    testImplementation(libs.junit)
    testImplementation(libs.kotlinx.coroutines.test)
}
