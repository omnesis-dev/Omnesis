// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

// Root build script. Plugin versions are declared here (apply false) and applied
// per-module. All versions live in gradle/libs.versions.toml (the single source of truth).
plugins {
    alias(libs.plugins.android.application) apply false
    alias(libs.plugins.android.library) apply false
    alias(libs.plugins.kotlin.android) apply false
    alias(libs.plugins.kotlin.compose) apply false
    alias(libs.plugins.kotlin.serialization) apply false
    alias(libs.plugins.ksp) apply false
    alias(libs.plugins.hilt) apply false
    alias(libs.plugins.roborazzi) apply false
}

// ── One time zone and locale for every JVM test ─────────────────────────────
// Screenshots render dates and times through the JVM defaults, so a golden
// recorded on one machine would drift on a machine in another zone. Every unit
// test JVM runs in the zone and locale the committed goldens were recorded in.
subprojects {
    tasks.withType<Test>().configureEach {
        systemProperty("user.timezone", "Europe/London")
        systemProperty("user.language", "en")
        systemProperty("user.country", "US")
    }
}

// ── Roborazzi zero-capture guard ─────────────────────────────────────────────
// A Roborazzi record/verify run that captured ZERO images is a silent no-op: the
// committed goldens under src/test/roborazzi/ are still present, so neither the unit
// test task nor verifyRoborazzi reddens — yet nothing was actually rendered (every
// screenshot test skipped, a `--tests` filter matched nothing, or the capture lane
// hung before writing). After each record/verify run, read Roborazzi's
// results-summary.json and fail loud unless it captured at least one image, so the
// screenshot lane can never pass while doing nothing. The summary-parsing decision
// (`summary.total == 0` ⇒ fail) is unit-tested in
// `app/src/test/.../RoborazziCaptureGateTest.kt`.
subprojects {
    plugins.withId("io.github.takahirom.roborazzi") {
        val assertCaptured =
            tasks.register("assertRoborazziCapturedImages") {
                description = "Fail loud if the Roborazzi lane captured zero images (a silent no-op)."
                doLast {
                    val summary =
                        layout.buildDirectory
                            .file("test-results/roborazzi/results-summary.json")
                            .get()
                            .asFile
                    if (!summary.exists()) {
                        throw GradleException(
                            "Roborazzi wrote no results-summary.json in ${project.path} — the " +
                                "screenshot lane ran zero captures (silent no-op).",
                        )
                    }
                    @Suppress("UNCHECKED_CAST")
                    val parsed = groovy.json.JsonSlurper().parse(summary) as Map<String, Any?>
                    val total = ((parsed["summary"] as Map<String, Any?>)["total"] as Number).toInt()
                    if (total == 0) {
                        throw GradleException(
                            "Roborazzi captured 0 images in ${project.path} — the screenshot lane is a " +
                                "silent no-op (skipped tests or a capture hang). Expected at least 1.",
                        )
                    }
                    logger.lifecycle("Roborazzi captured $total image(s) in ${project.path}.")
                }
            }
        tasks
            .matching { it.name.startsWith("recordRoborazzi") || it.name.startsWith("verifyRoborazzi") }
            .configureEach { finalizedBy(assertCaptured) }
    }
}
