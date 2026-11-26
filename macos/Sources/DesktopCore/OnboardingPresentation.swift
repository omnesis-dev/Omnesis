// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation

extension DesktopState {
    public var waitingForLocalLibrary: Bool {
        phase == .waiting && mode == "home" && retired != true
    }

    /// A missing mode is the sidecar's observed no-install choice, not an installed joined library.
    public var canChangeUnpreparedChoice: Bool {
        phase == .waiting && mode == nil && retired != true
    }
}

extension DesktopState.Signup {
    public var readableTermsURL: URL? {
        guard let acmeTermsUrl, acmeTermsUrl.scheme == "https", acmeTermsUrl.host != nil,
              acmeTermsUrl.user == nil, acmeTermsUrl.password == nil else { return nil }
        return acmeTermsUrl
    }
}
