// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation

/// The verify and calibration wording the Decision model sheet shows.
extension DecisionModelSetup {
    // MARK: - Verify

    /// Which verify route checks a model.
    enum VerifyTarget: Equatable, Hashable, Sendable {
        case backend(key: String, model: String)
        case typesafe(model: String)

        var model: String {
            switch self {
            case .backend(_, let model), .typesafe(let model): model
            }
        }
    }

    /// The verify target for the current assignment, when it is a model on a
    /// backend's decision API or TypeSafe's.
    static func currentVerifyTarget(_ overview: ModelsOverview) -> VerifyTarget? {
        guard let current = overview.inference.assignments[role], let model = current.model, !model.isEmpty else {
            return nil
        }
        switch current.kind {
        case "decision":
            guard let key = current.backendKey else { return nil }
            return .backend(key: key, model: model)
        case "typesafe":
            return .typesafe(model: model)
        default:
            return nil
        }
    }

    /// "Answered in 240 ms", naming the model that answered when it is not
    /// the one asked for (an alias the server resolved), or the gateway's
    /// reason as written.
    static func verifyText(_ result: DecisionVerifyResult, model: String?) -> String {
        if result.ok {
            var text = result.latencyMs.map { "Answered in \($0) ms" } ?? "Answered"
            if let answeredBy = result.answeredBy, !answeredBy.isEmpty, answeredBy != model {
                text += " by \(answeredBy)"
            }
            return text
        }
        let reason = result.reason?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return reason.isEmpty ? "The model did not answer." : reason
    }

    /// What a model listing says beside the model field: the reason it
    /// failed, or that a listed server has no models; nil otherwise.
    static func probeNote(_ result: DecisionProbeResult) -> String? {
        if !result.ok {
            let reason = result.reason?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            return reason.isEmpty ? "The server did not list its models." : reason
        }
        return result.listed && result.models.isEmpty ? "The server lists no models yet." : nil
    }

    // MARK: - Calibration

    /// The calibration state of the current assignment: only a model on a
    /// backend's decision API is calibrated (TypeSafe's Jev is the reference).
    enum CalibrationState: Equatable {
        case uncalibrated
        case calibrated(DecisionCalibration?)
    }

    static func calibrationState(_ overview: ModelsOverview) -> CalibrationState? {
        guard let current = overview.inference.assignments[role], current.kind == "decision" else { return nil }
        let stored = current.backendKey.flatMap { key in
            current.model.flatMap { overview.inference.backends[key]?.decision?.calibrations[$0] }
        }
        if current.calibrated == true || stored != nil { return .calibrated(stored) }
        return .uncalibrated
    }

    static let uncalibratedText =
        "Thresholds were tuned on TypeSafe's Jev. Calibrate this model so they mean the same thing."

    /// "Calibrated against Jev on Nov 10, 2026: agrees with Jev on 92% of the
    /// reference emails (was 71%)." Parts the calibration lacks are left out.
    static func calibratedText(
        _ calibration: DecisionCalibration?,
        locale: Locale = .current,
        timeZone: TimeZone = .current
    )
        -> String {
        var text = "Calibrated against Jev"
        if let date = calibration?.fittedAt.flatMap(parseISODate) {
            let formatter = DateFormatter()
            formatter.locale = locale
            formatter.timeZone = timeZone
            formatter.dateStyle = .medium
            formatter.timeStyle = .none
            text += " on \(formatter.string(from: date))"
        }
        if let keeps = calibration?.keeps, let skips = calibration?.skips {
            text += ": keeps \(percent(keeps)) of the reference emails Jev keeps and skips \(percent(skips)) of those it skips"
            if let keepsBefore = calibration?.keepsBefore, let skipsBefore = calibration?.skipsBefore {
                text += " (before: \(percent(keepsBefore)) and \(percent(skipsBefore)))"
            }
            return text + "."
        }
        guard let agreement = calibration?.agreement else { return text + "." }
        text += ": agrees with Jev on \(percent(agreement)) of the reference emails"
        if let before = calibration?.agreementBefore { text += " (was \(percent(before)))" }
        return text + "."
    }

    /// The calibration to describe: a run of the current model that just
    /// finished carries the fresh fit, which the overview may not hold yet.
    static func shownCalibration(
        stored: DecisionCalibration?,
        job: DecisionCalibrationStatus?
    )
        -> DecisionCalibration? {
        if job?.state == "done", let result = job?.result { return result }
        return stored
    }

    /// The one line the Decision card in the Models list shows under the
    /// model; nil for every other card.
    static func cardSummary(_ overview: ModelsOverview, role capabilityRole: String) -> String? {
        guard capabilityRole == role else { return nil }
        return switch calibrationState(overview) {
        case .none: nil
        case .uncalibrated: "Not calibrated to Jev's scale"
        case .calibrated(let calibration):
            if let keeps = calibration?.keeps {
                "Calibrated · keeps \(percent(keeps)) of what Jev keeps"
            } else if let agreement = calibration?.agreement {
                "Calibrated · agrees with Jev on \(percent(agreement))"
            } else {
                "Calibrated to Jev's scale"
            }
        }
    }

    /// What starting a calibration does, shown before it starts.
    static func calibrationExplanation(onHost: Bool) -> String {
        let cost = onHost
            ? "On a server running on a CPU it can take several minutes."
            : "On a hosted provider this costs a few cents."
        return "Calibration sends about 300 invented emails (no personal data) to the model and compares its "
            + "answers with Jev's. \(cost)"
    }

    /// The calibration job's status when it concerns the current assignment;
    /// nil for a run of another backend or model, whose progress or outcome
    /// says nothing about this one. An idle job names no assignment.
    static func relevantCalibration(
        _ status: DecisionCalibrationStatus?,
        in overview: ModelsOverview
    )
        -> DecisionCalibrationStatus? {
        guard let status else { return nil }
        guard let assignment = status.assignment else { return status }
        return assignment == currentAssignment(overview) ? status : nil
    }

    /// "120 of 300 reference emails", with the failures when there are any.
    static func calibrationProgressText(_ status: DecisionCalibrationStatus) -> String {
        var text = status.total > 0
            ? "\(status.done) of \(status.total) reference emails"
            : "Starting…"
        if status.failed > 0 { text += " · \(status.failed) failed" }
        return text
    }

    /// The outcome of the last run when it did not succeed; nil otherwise.
    static func calibrationOutcomeText(_ status: DecisionCalibrationStatus) -> String? {
        switch status.state {
        case "failed":
            let error = status.error?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            return error.isEmpty ? "Calibration failed." : error
        case "cancelled":
            return "Calibration cancelled."
        default:
            return nil
        }
    }

    /// The share of `value` (0–1) as a whole percentage.
    static func percent(_ value: Double) -> String {
        "\(Int((value * 100).rounded()))%"
    }

    private static func parseISODate(_ raw: String) -> Date? {
        let fractional = ISO8601DateFormatter()
        fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let date = fractional.date(from: raw) { return date }
        return ISO8601DateFormatter().date(from: raw)
    }
}
