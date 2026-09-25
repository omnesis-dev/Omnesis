// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation

#if canImport(SwiftUI) && canImport(UIKit)
import SwiftUI

/// An extra action a step offers beside Next for one of its outcomes, such as
/// adding photos to a selected library.
struct PhoneSetupOutcomeAction {
    let title: String
    /// The label while the action runs the step again, such as "Trying again…".
    var busyTitle: String?
    let run: @MainActor () async -> Void
}

/// What a step draws beyond its copy. Each step contributes its own
/// conformance beside its code; the shared page only asks for these, so it
/// never needs to know which step it is showing. Every member is optional.
@MainActor
protocol PhoneSetupStepVisuals {
    /// Drawn between the example question and the ledger.
    func illustration() -> AnyView?
    /// A ledger section between what is sent and what stays on the phone.
    func extraLedgerSection() -> AnyView?
    /// Replaces the outcome's default secondary action.
    func outcomeAction(for outcome: PhoneSetupOutcome) -> PhoneSetupOutcomeAction?
    /// The page's content before an outcome, for a step whose introduction is
    /// custom.
    func introductionContent() -> AnyView?
    /// The page's actions before an outcome, for a step whose introduction is
    /// custom.
    func introductionActions(coordinator: PhoneSetupCoordinator) -> AnyView?
}

extension PhoneSetupStepVisuals {
    func illustration() -> AnyView? {
        nil
    }

    func extraLedgerSection() -> AnyView? {
        nil
    }

    func outcomeAction(for _: PhoneSetupOutcome) -> PhoneSetupOutcomeAction? {
        nil
    }

    func introductionContent() -> AnyView? {
        nil
    }

    func introductionActions(coordinator _: PhoneSetupCoordinator) -> AnyView? {
        nil
    }
}
#endif
