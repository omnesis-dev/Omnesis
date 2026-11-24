// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

#if DEBUG && canImport(SwiftUI) && canImport(UIKit)
extension PreviewMocks {
    /// Rasterized provider-owned Lucide glyphs from providers/apple/src/icons.ts (ISC; TRADEMARKS.md).
    static let deviceForgetIcons: [String: String] = [
        "apple-notes": "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAADAAAAAwCAYAAABXAvmHAAAABmJLR0QA/wD/AP+gvaeTAAADkElEQV"
            + "Roge2ay2tTURCHv+nDJ7SC+EDFoiAVRRdNfOBOUdDSRRGttUWtbiyoKxH8M1yJClJQ66PVhaAVRHBlaU0i0lbQleCjKy0UFeujGR"
            + "e5ae69zbk5MbmJQn5QOGeYe+eb9syZc5JCReWV5HLQQeYzh1NAJ7ARqC0g3huENokwYow3zBqqOIvQDDQA34A4wlWauCVC0joBjb"
            + "MaeARsKADaK+GRRGjOGi9BG0oPsMDw7BOUAxJlMm2qMsXRQeZTbPgAaZwOlJuY4AGU3UC/aobbmICzbIoN/wY4P4srTgdwDai2eM"
            + "ceErSnJzUBjh2emXCP35yUbXy2Y7WTAf43ymkW0MNPGpjmGrA98xAngJspLPOLp4C5LtMSifKpJPDQIVH6Z/xiNCK8dvlMSpRFEL"
            + "SEvPAUHT7GYSzgU8F573t8YXoQlEBo0hiHEa5jAw8gHPdZ3qYHMzWgCVpQLgMrsgaNo85wHOGkRHhQCniNcxDlgtfIw/RQXI4fgJ"
            + "WWHB8lyqp8wOEv4VPF6t5svpJkg2xNLauSLaG84RO0MRt+GqUrDQ/uBIRuYNyCZdzxLRxe6DTCK72z4OGobOGe2zdoG1WPYzT3uc"
            + "nwnp3AYx9MCj5CnzW8ckS2cMvvH+oSclr+RUKCh7BrIMZ2YL0Hxgx/KF94CDuBat+pU7kbAH+DPOEh7D6gtPgs97O892BWeKFLos"
            + "HwEGIf0CFWUcM7V4xpfrJUdjAx4xOj3dmdvDWS+s3ftgEJOo0Wplr2oZ6da0h2MKHDLKaGvSitwH68yzgveHAnIHQHLSGX7PqAzr"
            + "p1zdMEz1C2oVnP/XnDQ4h9QONMAnWW7r8QjkiEO/nEgHB3Ic3tAsAYsMsPrwk2a4IB52ez6eHwaiB11j+Txa7AS4QB4AFNDItkSV"
            + "bpAxqd2Vq8/WRG4SVQzzkmSQLHHMtTYIAqBqTJ6szVaBh7lNlGc/QBlwq6D9jKtgYzNaBcIjc8wArH959QWa6UxVRJ7gNhKvT7wN"
            + "8q/xr4T1VJoNwq+edCxValD5RblT4Qlip9APjhnugLloTMkon1nOU+03eTb1ACrzyzJFd0iGUFcFlJh1hGNZc9RmHM5B90oekFml"
            + "zzVmpo1XhhgFby389Sn9hllfkv8IWLYM68hBqh3tx3jAnITqZI0kx5kxglSYus89ajW7n/1eAp86ijmySdCJvwffkXgqYQRlF6qe"
            + "dSEHxF/4L+AJRFZa5O9qYGAAAAAElFTkSuQmCC",
        "apple-reminders": "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAADAAAAAwCAYAAABXAvmHAAAABmJLR0QA/wD/AP+gvaeTAAABbUlEQV"
            + "Roge2XzUrEMBRGT8o8RfGR3IhiEQZ0p9AZX8Yp6H7EURQ3PlOfwpm4aLGtSX9jaGDu2TUJt99Nb5PvgiAIgnDMKNcAesMZik3xwK"
            + "1a8fVn/hTFExA7viq3xY9cIuqMBMUbhbgYxaOxqBhzFU9b/MkJ6IwE2AILF1WuTEqgRfw3mrW5mDsgn6SuSV7GamD8A7WahQP3as"
            + "1HY75NPCxVyus/CB2F+QWqmo2J2JWCgfDEQ3/9LoCtzn6fgxIPthJ64JyIHaZQLGOzioeWe2DACROEeOi4yDqSCEY89NzEOuMCeK"
            + "FKYg9cq5Rn38KG0mslGlbBcqwKx46zG+0jaDc6iFDdaCj4T8CzGxXmxntP7BundtDwS8UpceIuazjSE9eG7T2xZ4zdc+qJV3x61G"
            + "pFemKkJ3bDe088ixsthS2pdr7OuJ2fy42WAq9oJrEHbuYumzqd94BKeUdzSeEmcw4koxt6caOCIAiCR34AK36ov59pDroAAAAASU"
            + "VORK5CYII=",
    ]
    static let deviceForgetCatalogImpact = DeviceForgetImpact(
        sources: [
            .init(id: "apple-notes:local", type: "apple-notes", multiDeviceMode: "replicated", otherDeviceCount: 1, deleteScope: "none"),
            .init(
                id: "apple-reminders:local",
                type: "apple-reminders",
                multiDeviceMode: "replicated",
                otherDeviceCount: 1,
                deleteScope: "none"
            ),
        ],
        fingerprint: "preview-device-impact"
    )
}
#endif
