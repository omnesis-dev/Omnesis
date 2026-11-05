// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import org.gradle.testing.jacoco.plugins.JacocoPluginExtension
import org.gradle.testing.jacoco.plugins.JacocoTaskExtension
import org.gradle.testing.jacoco.tasks.JacocoReport

apply(plugin = "jacoco")

extensions.configure<JacocoPluginExtension> { toolVersion = "0.8.14" }
val coverageRequested = providers.gradleProperty("omnesisCoverage").map { it == "true" }.orElse(false)
tasks.withType<Test>().configureEach {
    extensions.configure<JacocoTaskExtension> {
        isEnabled = coverageRequested.get()
        isIncludeNoLocationClasses = true
        // Robolectric uses isolated class loaders; never instrument JDK internals.
        excludes = listOf("jdk.internal.*")
    }
}

val variant = if (project.name == "app") "playDebug" else "debug"
val taskVariant = variant.replaceFirstChar { it.uppercase() }
tasks.register<JacocoReport>("logicCoverageReport") {
    val enabled = coverageRequested.get()
    group = "verification"
    description = "Report all application logic executed by this variant's JVM tests."
    dependsOn("test${taskVariant}UnitTest")
    executionData(layout.buildDirectory.file("jacoco/test${taskVariant}UnitTest.exec"))
    sourceDirectories.setFrom(files("src/main/kotlin", "src/main/java"))
    classDirectories.setFrom(files(
        layout.buildDirectory.dir("tmp/kotlin-classes/$variant"),
        layout.buildDirectory.dir("intermediates/javac/$variant/compile${taskVariant}JavaWithJavac/classes"),
    ))
    reports {
        xml.required.set(true)
        xml.outputLocation.set(layout.buildDirectory.file("reports/logic-coverage/coverage.xml"))
        html.required.set(true)
        html.outputLocation.set(layout.buildDirectory.dir("reports/logic-coverage/html"))
    }
    doFirst {
        check(enabled) { "Enable coverage with -PomnesisCoverage=true and run the JVM tests." }
        check(executionData.files.all { it.isFile }) { "Current JVM test coverage data is missing." }
    }
}
