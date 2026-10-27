// swift-tools-version:5.3
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import PackageDescription

let package = Package(
    name: "WebRTC",
    platforms: [.iOS(.v14)],
    products: [.library(name: "WebRTC", targets: ["WebRTC"])],
    targets: [
        .binaryTarget(
            name: "WebRTC",
            url: "https://github.com/shiguredo-webrtc-build/webrtc-build/releases/download/m155.8059.4.1/WebRTC.xcframework.zip",
            checksum: "dd76daf2045629e8c56d029ab42cb8041578f0b07d255a7b65a7180239ed5869"
        ),
    ]
)
