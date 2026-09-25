// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

pluginManagement {
    repositories {
        google {
            content {
                includeGroupByRegex("com\\.android.*")
                includeGroupByRegex("com\\.google.*")
                includeGroupByRegex("androidx.*")
            }
        }
        mavenCentral()
        gradlePluginPortal()
    }
}

dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories {
        google()
        mavenCentral()
    }
}

rootProject.name = "OmnesisAndroid"

include(":app")
include(":core-transport")
include(":core-pairing")
include(":core-designsystem")
include(":core-setup")
include(":feature-health")
include(":feature-call-log")
include(":feature-app-usage")
include(":feature-activity-segments")
include(":feature-photos")
