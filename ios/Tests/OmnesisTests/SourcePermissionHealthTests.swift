// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

@testable import Omnesis
import XCTest

@MainActor
final class SourcePermissionHealthTests: XCTestCase {
    func testLimitedPhotosIsRequiredDegradation() {
        let capability = PhotosPermissionHealth.report(
            access: .limited, backgroundRefresh: .available
        ).capabilities[0]
        XCTAssertEqual(capability.state, .permissionDegraded)
        XCTAssertEqual(capability.requirement, .required)
        XCTAssertEqual(capability.repairAction, .openAppSettings)
    }

    func testLocationWhenInUseLosesBackgroundAccessAndTracksReducedAccuracySeparately() {
        let capabilities = CoreLocationVisitsPermissionHealth.report(
            state: .whenInUse, precise: false
        ).capabilities
        XCTAssertEqual(capabilities[0].state, .backgroundAccessMissing)
        XCTAssertEqual(capabilities[0].requirement, .required)
        XCTAssertEqual(capabilities[1].state, .permissionDegraded)
        XCTAssertEqual(capabilities[1].requirement, .optional)
        XCTAssertEqual(
            capabilities[1].impact,
            "Visit place names and stored coordinates may be less accurate."
        )
    }

    func testLocationAccuracyIsUnknownWithoutUsableBaseAuthorization() {
        for state in [LocationVisitsPermissionState.notDetermined, .denied, .restricted] {
            let capabilities = CoreLocationVisitsPermissionHealth.report(
                state: state, precise: true
            ).capabilities
            XCTAssertEqual(capabilities[1].state, .unknown)
            XCTAssertEqual(capabilities[1].repairAction, .none)
            XCTAssertFalse(capabilities[1].impact?.contains("resolved accurately") == true)
        }
    }

    func testRestrictedCapabilitiesDoNotPromiseAnAppSettingsRepair() {
        let photos = PhotosPermissionHealth.report(access: .restricted, backgroundRefresh: .available)
        XCTAssertEqual(photos.capabilities[0].repairAction, .none)
        let activity = ActivitySegmentsPermissionHealth.report(
            state: .restricted,
            backgroundRefresh: .available
        )
        XCTAssertEqual(activity.capabilities[0].repairAction, .none)
    }

    func testHealthReadPermissionStaysUnknownBecauseHealthKitDoesNotExposeIt() {
        let report = AppleHealthPermissionHealth.report(backgroundRefresh: .available)
        XCTAssertEqual(report.capabilities[0].state, .unknown)
        XCTAssertFalse(report.capabilities[0].state.isDegraded)
    }

    func testBackgroundRefreshLossIsActionable() {
        let report = ActivitySegmentsPermissionHealth.report(
            state: .authorized, backgroundRefresh: .denied
        )
        XCTAssertEqual(report.capabilities[0].state, .healthy)
        XCTAssertEqual(report.capabilities[1].state, .backgroundAccessMissing)
        XCTAssertEqual(report.capabilities[1].repairAction, .openAppSettings)
    }

    func testPhotosReportsBackgroundRefreshLossAndRestrictionTruthfully() {
        let denied = PhotosPermissionHealth.report(access: .full, backgroundRefresh: .denied)
        XCTAssertEqual(denied.capabilities[1].state, .backgroundAccessMissing)
        XCTAssertEqual(denied.capabilities[1].repairAction, .openAppSettings)

        let restricted = PhotosPermissionHealth.report(access: .full, backgroundRefresh: .restricted)
        XCTAssertEqual(restricted.capabilities[1].state, .unavailable)
        XCTAssertEqual(restricted.capabilities[1].repairAction, .none)
    }

    func testAvailableBackgroundRefreshDoesNotOfferARepair() {
        let report = AppleHealthPermissionHealth.report(backgroundRefresh: .available)
        let capability = report.capabilities[1]
        XCTAssertEqual(capability.state, .healthy)
        XCTAssertNil(capability.remediation)
        XCTAssertEqual(capability.repairAction, .none)
    }

    func testRestrictedBackgroundRefreshIsUnavailableWithoutFalseRepairPromise() {
        let report = AppleHealthPermissionHealth.report(backgroundRefresh: .restricted)
        let capability = report.capabilities[1]
        XCTAssertEqual(capability.state, .unavailable)
        XCTAssertEqual(capability.repairAction, .none)
    }

    func testDisplayNameIsSourceOwned() {
        XCTAssertEqual(
            PhotosPermissionHealth.report(access: .full, backgroundRefresh: .available).displayName,
            "Photos"
        )
        XCTAssertEqual(
            CoreLocationVisitsPermissionHealth.report(state: .always, precise: true).displayName,
            "Location Visits"
        )
    }

    func testCoordinatorExposesColdLoadingAndEvaluatedStatesThroughInjectedSeams() async {
        let coordinator = PermissionHealthCoordinator()
        XCTAssertEqual(coordinator.evaluation, .notEvaluated)
        let gate = PermissionEvaluationGate()
        let reports = [PhotosPermissionHealth.report(access: .limited, backgroundRefresh: .available)]
        let published = PermissionReportRecorder()

        let refresh = Task {
            await coordinator.refresh(
                evaluate: {
                    await gate.wait()
                    return reports
                },
                report: { report in await published.append(report) }
            )
        }
        await Task.yield()
        XCTAssertEqual(coordinator.evaluation, .loading)
        await gate.release()
        await refresh.value

        XCTAssertEqual(coordinator.evaluation, .evaluated(reports))
        let publishedReports = await published.values
        XCTAssertEqual(publishedReports, reports)
    }

    func testCoordinatorResetPreventsAnObsoleteEvaluationFromPublishing() async {
        let coordinator = PermissionHealthCoordinator()
        let gate = PermissionEvaluationGate()
        let obsolete = [PhotosPermissionHealth.report(access: .limited, backgroundRefresh: .available)]

        let refresh = Task {
            await coordinator.refresh(
                evaluate: {
                    await gate.wait()
                    return obsolete
                },
                report: nil
            )
        }
        await Task.yield()
        XCTAssertEqual(coordinator.evaluation, .loading)

        coordinator.reset()
        await gate.release()
        await refresh.value

        XCTAssertEqual(coordinator.evaluation, .notEvaluated)
    }

    func testGatewayReportFailureStaysVisibleUntilARetrySucceeds() async {
        let coordinator = PermissionHealthCoordinator()
        let reports = [
            PhotosPermissionHealth.report(access: .limited, backgroundRefresh: .available),
        ]

        await coordinator.refresh(
            evaluate: { reports },
            report: { _ in throw PermissionHealthTestError.unreachable }
        )
        XCTAssertEqual(coordinator.evaluation, .evaluated(reports))
        XCTAssertEqual(coordinator.delivery, .deferred(Set(["photos:local"])))

        await coordinator.refresh(evaluate: { reports }, report: { _ in })
        XCTAssertEqual(coordinator.delivery, .idle)
    }

    func testCancelledReportNeverLeavesDeliveryStuckReporting() async {
        let coordinator = PermissionHealthCoordinator()
        let reports = [PhotosPermissionHealth.report(access: .limited, backgroundRefresh: .available)]
        let refresh = Task {
            await coordinator.refresh(
                evaluate: { reports },
                report: { _ in try await Task.sleep(nanoseconds: 30_000_000_000) }
            )
        }
        for _ in 0 ..< 20 where coordinator.delivery != .reporting {
            await Task.yield()
        }
        XCTAssertEqual(coordinator.delivery, .reporting)
        refresh.cancel()
        await refresh.value
        XCTAssertEqual(coordinator.delivery, .idle)
    }

    func testSupersedingRefreshOwnsFinalDeliveryState() async {
        let coordinator = PermissionHealthCoordinator()
        let reports = [PhotosPermissionHealth.report(access: .limited, backgroundRefresh: .available)]
        let obsolete = Task {
            await coordinator.refresh(
                evaluate: { reports },
                report: { _ in try await Task.sleep(nanoseconds: 30_000_000_000) }
            )
        }
        for _ in 0 ..< 20 where coordinator.delivery != .reporting {
            await Task.yield()
        }

        await coordinator.refresh(evaluate: { reports }, report: nil)
        XCTAssertEqual(coordinator.delivery, .idle)
        obsolete.cancel()
        await obsolete.value
        XCTAssertEqual(coordinator.delivery, .idle)
    }

    func testNonCooperativeObsoleteReporterCannotOverwriteSupersedingDeliveryState() async {
        let coordinator = PermissionHealthCoordinator()
        let gate = PermissionEvaluationGate()
        let reports = [PhotosPermissionHealth.report(access: .limited, backgroundRefresh: .available)]
        let obsolete = Task {
            await coordinator.refresh(
                evaluate: { reports },
                report: { _ in await gate.wait() }
            )
        }
        for _ in 0 ..< 20 where coordinator.delivery != .reporting {
            await Task.yield()
        }

        await coordinator.refresh(
            evaluate: { reports },
            report: { _ in throw PermissionHealthTestError.unreachable }
        )
        XCTAssertEqual(coordinator.delivery, .deferred(Set(["photos:local"])))

        obsolete.cancel()
        await gate.release()
        await obsolete.value
        XCTAssertEqual(coordinator.delivery, .deferred(Set(["photos:local"])))
    }

    func testAppPermissionRefreshEvaluatesAndPublishesOnlyEnabledSources() async {
        let coordinator = PermissionHealthCoordinator()
        let published = PermissionReportRecorder()
        let evaluations = PermissionTransitionEventRecorder()
        let enabled = CoreLocationVisitsPermissionHealth.report(state: .whenInUse, precise: false)

        await coordinator.refresh(
            sources: [
                .init(enabled: false) {
                    await evaluations.append("disabled")
                    return PhotosPermissionHealth.report(access: .denied, backgroundRefresh: .available)
                },
                .init(enabled: true) {
                    await evaluations.append("enabled")
                    return enabled
                },
            ],
            report: { report in await published.append(report) }
        )

        XCTAssertEqual(coordinator.evaluation, .evaluated([enabled]))
        let evaluatedSources = await evaluations.values
        XCTAssertEqual(evaluatedSources, ["enabled"])
        let publishedReports = await published.values
        XCTAssertEqual(publishedReports, [enabled])
    }

    func testPhotosRestorationAdvancesEpochBeforeRebuildReportAndSync() async {
        let settings = PhotosSettings(defaults: DictionaryDefaults())
        XCTAssertFalse(settings.observeAccess(.limited))
        let events = PermissionTransitionEventRecorder()
        let coordinator = PermissionHealthCoordinator()
        let published = PermissionReportRecorder()

        await PhotosPermissionTransitionCoordinator.authorizationChanged(
            access: .full,
            settings: settings,
            rebuild: {
                await events.append("rebuild-epoch-\(settings.accessEpoch)")
            },
            refresh: {
                await events.append("report")
                await coordinator.refresh(
                    evaluate: {
                        [PhotosPermissionHealth.report(access: .full, backgroundRefresh: .available)]
                    },
                    report: { report in await published.append(report) }
                )
            },
            sync: { await events.append("sync") }
        )

        XCTAssertEqual(settings.accessEpoch, 1)
        let recordedEvents = await events.values
        let publishedReports = await published.values
        XCTAssertEqual(recordedEvents, ["rebuild-epoch-1", "report", "sync"])
        XCTAssertEqual(publishedReports.first?.capabilities.map(\.state), [.healthy, .healthy])
    }
}

private enum PermissionHealthTestError: Error {
    case unreachable
}

private actor PermissionEvaluationGate {
    private var open = false
    private var continuation: CheckedContinuation<Void, Never>?
    func wait() async {
        guard !open else { return }
        await withCheckedContinuation { continuation = $0 }
    }

    func release() {
        open = true
        continuation?.resume()
        continuation = nil
    }
}

private actor PermissionReportRecorder {
    private(set) var values: [SourcePermissionHealthReport] = []
    func append(_ report: SourcePermissionHealthReport) {
        values.append(report)
    }
}

private actor PermissionTransitionEventRecorder {
    private(set) var values: [String] = []
    func append(_ value: String) {
        values.append(value)
    }
}
