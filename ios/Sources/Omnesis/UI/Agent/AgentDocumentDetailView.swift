// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation
#if canImport(SwiftUI) && canImport(UIKit)
import SwiftUI

/// Trivial wrapper around `DocumentDetailView` that the agent UI uses
/// for `NavigationLink` destinations. Keeping the indirection lets us
/// later add agent-specific context (e.g. "this doc came from a
/// `search_documents` call in conversation X") without forking the
/// shared document screen.
@available(iOS 17.0, *)
struct AgentDocumentDetailView: View {
    let documentId: String

    var body: some View {
        DocumentDetailView(documentId: documentId)
    }
}
#endif
