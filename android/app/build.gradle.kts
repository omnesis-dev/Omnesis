// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import java.io.File
import java.io.FileFilter
import java.util.Properties
import javax.xml.parsers.DocumentBuilderFactory
import com.android.build.api.artifact.SingleArtifact
import org.gradle.api.DefaultTask
import org.gradle.api.file.ConfigurableFileCollection
import org.gradle.api.file.DirectoryProperty
import org.gradle.api.file.RegularFileProperty
import org.gradle.api.provider.Property
import org.gradle.api.tasks.Input
import org.gradle.api.tasks.InputFile
import org.gradle.api.tasks.InputFiles
import org.gradle.api.tasks.OutputDirectory
import org.gradle.api.tasks.TaskAction
import org.w3c.dom.Element

/**
 * Writes `xml/shortcuts.xml` from its template with the variant's package id
 * substituted as a literal: Google Play's App Actions parser rejects an
 * `android:targetPackage` that is a resource reference.
 */
abstract class GenerateShortcutsResource : DefaultTask() {
    @get:InputFile
    abstract val template: RegularFileProperty

    @get:Input
    abstract val applicationId: Property<String>

    @get:OutputDirectory
    abstract val outputDir: DirectoryProperty

    @TaskAction
    fun generate() {
        val source = template.get().asFile
        val text = source.readText()
        check(PLACEHOLDER in text) { "$source must name the package as $PLACEHOLDER" }
        val output = outputDir.get().dir("xml").file("shortcuts.xml").asFile
        output.parentFile.mkdirs()
        output.writeText(text.replace(PLACEHOLDER, applicationId.get()))
    }

    companion object {
        const val PLACEHOLDER = "__OMNESIS_APPLICATION_ID__"
    }
}

/**
 * Fails when any `xml/shortcuts.xml` a variant compiles gives an intent an
 * `android:targetPackage` other than the literal package id — a resource
 * reference, which Google Play rejects, or another package.
 */
abstract class VerifyShortcutsTargetPackage : DefaultTask() {
    @get:InputFiles
    abstract val resourceDirectories: ConfigurableFileCollection

    @get:Input
    abstract val applicationId: Property<String>

    @TaskAction
    fun verify() {
        val shortcuts = resourceDirectories.files.flatMap { dir ->
            dir.listFiles(FileFilter { it.isDirectory && (it.name == "xml" || it.name.startsWith("xml-")) })
                .orEmpty()
                .map { File(it, "shortcuts.xml") }
                .filter(File::isFile)
        }
        check(shortcuts.isNotEmpty()) { "No xml/shortcuts.xml resource is compiled into this variant" }
        val expected = applicationId.get()
        val parser = DocumentBuilderFactory.newInstance().apply { isNamespaceAware = true }
        var targets = 0
        shortcuts.forEach { file ->
            val intents = parser.newDocumentBuilder().parse(file).getElementsByTagName("intent")
            for (index in 0 until intents.length) {
                val target = (intents.item(index) as Element).getAttributeNS(ANDROID_NAMESPACE, "targetPackage")
                check(target == expected) {
                    "$file: android:targetPackage must be the literal package id $expected, found \"$target\""
                }
                targets += 1
            }
        }
        check(targets > 0) { "xml/shortcuts.xml declares no intents" }
    }

    companion object {
        const val ANDROID_NAMESPACE = "http://schemas.android.com/apk/res/android"
    }
}

abstract class VerifyPlayReleasePolicy : DefaultTask() {
    @get:InputFile
    abstract val mergedManifest: RegularFileProperty

    @get:Input
    abstract val runtimeConfigurationName: Property<String>

    @TaskAction
    fun verify() {
        val manifest = mergedManifest.get().asFile.readText()
        check("android.permission.READ_CALL_LOG" !in manifest) {
            "Play release manifest must not request android.permission.READ_CALL_LOG"
        }
        val components = project.configurations
            .getByName(runtimeConfigurationName.get())
            .incoming.resolutionResult.allComponents
            .map { it.id.displayName }
        check(components.none { it.contains("feature-call-log", ignoreCase = true) }) {
            "Play release runtime must not contain :feature-call-log: ${components.joinToString()}"
        }
    }
}

plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.android)
    alias(libs.plugins.kotlin.compose)
    alias(libs.plugins.kotlin.serialization)
    alias(libs.plugins.ksp)
    alias(libs.plugins.hilt)
    alias(libs.plugins.roborazzi)
}

val localPushProperties = Properties().apply {
    val file = rootProject.file("local.push.properties")
    if (file.isFile) file.inputStream().use(::load)
}

fun firebaseBuildValue(name: String): String =
    (localPushProperties.getProperty(name)
        ?: providers.gradleProperty(name)
            .orElse(providers.environmentVariable(name))
            .orElse("")
            .get())
        .replace("\\", "\\\\")
        .replace("\"", "\\\"")

val appPackageId = (localPushProperties.getProperty("OMNESIS_ANDROID_APPLICATION_ID")
    ?: providers.gradleProperty("OMNESIS_ANDROID_APPLICATION_ID")
        .orElse(providers.environmentVariable("OMNESIS_ANDROID_APPLICATION_ID"))
        .orElse("dev.omnesis.android")
        .get()).trim()
require(Regex("[A-Za-z][A-Za-z0-9_]*(\\.[A-Za-z][A-Za-z0-9_]*)+").matches(appPackageId)) {
    "OMNESIS_ANDROID_APPLICATION_ID must be an Android package id, such as dev.example.omnesis"
}

android {
    namespace = "dev.omnesis.android"
    compileSdk = 36

    defaultConfig {
        applicationId = appPackageId
        minSdk = 26
        targetSdk = 36
        versionCode = 1
        versionName = "0.5.13"
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
        // The UI journeys (src/androidTest, run by scripts/run-mobile-journeys.sh)
        // each start from a fresh install: the orchestrator runs every test in its
        // own instrumentation and clears the app's data first.
        testInstrumentationRunnerArguments["clearPackageData"] = "true"
        // Firebase is configured at build time; no google-services.json or service
        // credential is checked into the repository. Gradle properties take
        // precedence over environment variables with the same names.
        buildConfigField("String", "FIREBASE_APPLICATION_ID", "\"${firebaseBuildValue("OMNESIS_FIREBASE_APPLICATION_ID")}\"")
        buildConfigField("String", "FIREBASE_API_KEY", "\"${firebaseBuildValue("OMNESIS_FIREBASE_API_KEY")}\"")
        buildConfigField("String", "FIREBASE_PROJECT_ID", "\"${firebaseBuildValue("OMNESIS_FIREBASE_PROJECT_ID")}\"")
        buildConfigField("String", "FIREBASE_SENDER_ID", "\"${firebaseBuildValue("OMNESIS_FIREBASE_SENDER_ID")}\"")
    }

    flavorDimensions += "distribution"
    productFlavors {
        create("play") {
            dimension = "distribution"
        }
        create("full") {
            dimension = "distribution"
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro",
            )
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
        buildConfig = true
    }
    testOptions {
        execution = "ANDROIDX_TEST_ORCHESTRATOR"
        unitTests {
            isIncludeAndroidResources = true
            all {
                // NATIVE-graphics Roborazzi captures retain large bitmaps; the default
                // worker heap thrashes GC once a screenshot class accumulates many
                // captures in one fork. A roomier heap keeps the suite from stalling.
                it.maxHeapSize = "4g"
            }
        }
    }
}

roborazzi {
    // The golden PNGs are committed under `src/test/roborazzi/` (the `filePath`
    // each `captureRoboImage` writes to) so `verifyRoborazziPlayDebug` can compare a
    // fresh render against a tracked baseline in CI. Keep the verify run's diff /
    // actual / compare artifacts OUT of that tracked dir — write them to a
    // gitignored build dir so a failing verify never dirties the goldens.
    compare {
        outputDir.set(layout.buildDirectory.dir("outputs/roborazzi-compare"))
    }
}

dependencies {
    implementation(project(":core-designsystem"))
    implementation(project(":core-transport"))
    implementation(project(":core-pairing"))
    implementation(project(":core-setup"))
    implementation(project(":feature-health"))
    // Restricted call-log APIs are intentionally absent from the Google Play
    // artifact. The full flavor remains available to people who build/sideload
    // Omnesis themselves.
    add("fullImplementation", project(":feature-call-log"))
    implementation(project(":feature-app-usage"))
    implementation(project(":feature-activity-segments"))
    implementation(project(":feature-photos"))

    implementation(libs.androidx.core.ktx)
    implementation(libs.androidx.lifecycle.runtime.ktx)
    implementation(libs.androidx.lifecycle.runtime.compose)
    implementation(libs.androidx.lifecycle.viewmodel.compose)
    implementation(libs.androidx.activity.compose)

    implementation(platform(libs.androidx.compose.bom))
    implementation(libs.bundles.compose)
    implementation(libs.androidx.compose.material.icons.extended)
    implementation(libs.androidx.navigation.compose)
    implementation(libs.androidx.hilt.navigation.compose)
    debugImplementation(libs.androidx.compose.ui.tooling)
    debugImplementation(libs.androidx.compose.ui.test.manifest)

    implementation(libs.hilt.android)
    ksp(libs.hilt.compiler)

    implementation(libs.kotlinx.coroutines.android)
    implementation(libs.kotlinx.serialization.json)
    implementation(libs.kotlinx.coroutines.play.services)

    implementation(platform(libs.firebase.bom))
    implementation(libs.firebase.messaging)

    // QR pairing: CameraX preview + ML Kit on-device barcode scanning (bundled
    // model) to *scan*; zxing-core to *generate* a QR when pairing a new device.
    implementation(libs.bundles.camerax)
    implementation(libs.mlkit.barcode.scanning)
    implementation(libs.zxing.core)
    implementation(libs.guava)

    // Screenshot + unit testing (Roborazzi renders Compose to PNGs off-emulator).
    testImplementation(libs.junit)
    testImplementation(libs.robolectric)
    testImplementation(libs.roborazzi)
    testImplementation(libs.roborazzi.compose)
    testImplementation(libs.roborazzi.junit.rule)
    testImplementation(platform(libs.androidx.compose.bom))
    testImplementation(libs.androidx.compose.ui.test.junit4)
    testImplementation(libs.kotlinx.coroutines.test)
    testImplementation(libs.turbine)
    // Offline quick-capture queue tests drive the real NotesClient against a local mock gateway.
    testImplementation(libs.okhttp.mockwebserver)
    // The shell's launch-time navigation is exercised on the real Hilt graph under
    // Robolectric, paired to a leaf-pinned TLS mock gateway (see HomeScaffoldHarness).
    testImplementation(libs.hilt.android.testing)
    kspTest(libs.hilt.compiler)
    testImplementation(libs.okhttp.tls)

    // UI journeys on an emulator against a synthetic gateway (scripts/run-mobile-journeys.sh).
    androidTestImplementation(platform(libs.androidx.compose.bom))
    androidTestImplementation(libs.androidx.compose.ui.test.junit4)
    androidTestImplementation(libs.junit)
    androidTestImplementation(libs.androidx.test.runner)
    androidTestImplementation(libs.androidx.test.rules)
    androidTestImplementation(libs.androidx.test.core.ktx)
    androidTestImplementation(libs.androidx.test.ext.junit)
    androidTestImplementation(libs.androidx.test.uiautomator)
    androidTestUtil(libs.androidx.test.orchestrator)
    androidTestUtil(libs.androidx.test.services)
}

androidComponents {
    onVariants { variant ->
        val suffix = variant.name.replaceFirstChar(Char::uppercaseChar)
        val generateShortcuts = tasks.register<GenerateShortcutsResource>("generate${suffix}ShortcutsResource") {
            template.set(layout.projectDirectory.file("src/main/shortcuts/shortcuts.xml"))
            applicationId.set(variant.applicationId)
        }
        variant.sources.res?.addGeneratedSourceDirectory(generateShortcuts, GenerateShortcutsResource::outputDir)
    }
    onVariants(
        selector()
            .withFlavor("distribution" to "play")
            .withBuildType("release"),
    ) { variant ->
        val verifyShortcuts = tasks.register<VerifyShortcutsTargetPackage>("verifyPlayReleaseShortcuts") {
            group = "verification"
            description = "Proves every Play release shortcut intent names the package id as a literal."
            variant.sources.res?.all?.let { resourceDirectories.from(it) }
            applicationId.set(variant.applicationId)
            dependsOn("generatePlayReleaseShortcutsResource")
        }
        // The bundle Play receives is never built from shortcuts that would fail its App Actions parser.
        tasks.matching { it.name == "bundlePlayRelease" }.configureEach { dependsOn(verifyShortcuts) }
    }
    onVariants(
        selector()
            .withFlavor("distribution" to "play")
            .withBuildType("release"),
    ) { variant ->
        tasks.register<VerifyPlayReleasePolicy>("verifyPlayReleasePolicy") {
            group = "verification"
            description = "Proves the Play artifact excludes Call Log code and permission, and that its shortcuts name the package literally."
            mergedManifest.set(variant.artifacts.get(SingleArtifact.MERGED_MANIFEST))
            runtimeConfigurationName.set("${variant.name}RuntimeClasspath")
            dependsOn("verifyPlayReleaseShortcuts")
        }
    }
}
