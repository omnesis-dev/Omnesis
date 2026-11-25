// swift-tools-version: 5.9
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import PackageDescription

let package = Package(
    name: "OmnesisDesktopCore",
    platforms: [.macOS(.v14)],
    products: [.library(name: "DesktopCore", targets: ["DesktopCore"])],
    targets: [
        .target(name: "DesktopCore"),
        .testTarget(name: "DesktopCoreTests", dependencies: ["DesktopCore"]),
    ]
)
