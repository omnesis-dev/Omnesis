// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

@testable import Omnesis
import XCTest

@available(iOS 17.0, *)
@MainActor
final class NotificationRouterTests: XCTestCase {
    private let policyNow = Date(timeIntervalSince1970: 1_800_000_000)

    /// A destination view consumes a target during someone else's wait. The
    /// trace it leaves is what lets that wait tell an explicit destination
    /// arrived, even though nothing is pending by the time it looks.
    func testConsumingATargetLeavesATimestampedTrace() {
        let router = NotificationRouter()
        let before = Date()
        XCTAssertFalse(router.consumedSince(before))

        router.pendingTarget = .privacyApproval(approvalId: "approval-1")
        XCTAssertEqual(router.consume(), .privacyApproval(approvalId: "approval-1"))

        XCTAssertNil(router.pendingTarget)
        XCTAssertTrue(router.consumedSince(before))
        XCTAssertFalse(router.consumedSince(Date().addingTimeInterval(1)))
    }

    /// Consuming nothing is not a routing event and must not read as one.
    func testConsumingNothingLeavesNoTrace() {
        let router = NotificationRouter()
        let before = Date()
        XCTAssertNil(router.consume())
        XCTAssertFalse(router.consumedSince(before))
    }

    func testForegroundPolicyResumesExactConversationInsideOneHour() {
        let record = ForegroundConversationRecord(
            state: .conversation("conv-exact"),
            leftAt: policyNow.addingTimeInterval(-3599)
        )
        XCTAssertEqual(
            ForegroundConversationPolicy.action(record: record, now: policyNow),
            .resume("conv-exact")
        )
    }

    func testForegroundPolicyOneHourBoundaryStartsFresh() {
        for age in [3600.0, 3601.0] {
            let record = ForegroundConversationRecord(
                state: .conversation("conv-stale"),
                leftAt: policyNow.addingTimeInterval(-age)
            )
            XCTAssertEqual(
                ForegroundConversationPolicy.action(record: record, now: policyNow),
                .fresh,
                "an age of \(age)s must be stale"
            )
        }
    }

    func testForegroundPolicyMissingFutureAndMalformedConversationStartFresh() {
        XCTAssertEqual(
            ForegroundConversationPolicy.action(record: nil, now: policyNow),
            .fresh
        )
        XCTAssertEqual(
            ForegroundConversationPolicy.action(
                record: ForegroundConversationRecord(
                    state: .conversation("conv-future"),
                    leftAt: policyNow.addingTimeInterval(1)
                ),
                now: policyNow
            ),
            .fresh
        )
        XCTAssertEqual(
            ForegroundConversationPolicy.action(
                record: ForegroundConversationRecord(state: .conversation(""), leftAt: policyNow),
                now: policyNow
            ),
            .fresh
        )
    }

    func testForegroundPolicyPreservesRecentNonAgentSectionAndFreshComposer() {
        XCTAssertEqual(
            ForegroundConversationPolicy.action(
                record: ForegroundConversationRecord(state: .outsideAgent, leftAt: policyNow),
                now: policyNow
            ),
            .preserve
        )
        XCTAssertEqual(
            ForegroundConversationPolicy.action(
                record: ForegroundConversationRecord(state: .fresh, leftAt: policyNow),
                now: policyNow
            ),
            .fresh
        )
    }

    func testForegroundStorePersistsExactFreshAndConversationStates() throws {
        let suite = "foreground-conversation-tests-\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        let store = ForegroundConversationStore(defaults: defaults, now: { self.policyNow })

        store.save(state: .conversation("conv-persisted"))
        XCTAssertEqual(
            store.load(),
            ForegroundConversationRecord(state: .conversation("conv-persisted"), leftAt: policyNow)
        )
        store.save(state: .fresh)
        XCTAssertEqual(store.load()?.state, .fresh)
    }

    func testExplicitPushOrCaptureSuppressesAutomaticForegroundNavigation() {
        XCTAssertNil(ForegroundNavigationArbiter.automaticAction(
            .fresh,
            pushPending: true,
            capturePending: false
        ))
        XCTAssertNil(ForegroundNavigationArbiter.automaticAction(
            .resume("conv-auto"),
            pushPending: false,
            capturePending: true
        ))
        XCTAssertEqual(ForegroundNavigationArbiter.automaticAction(
            .resume("conv-auto"),
            pushPending: false,
            capturePending: false
        ), .resume("conv-auto"))
    }

    func testForegroundComposerFocusRequiresFreshConnectedConversation() {
        XCTAssertTrue(AgentComposerForegroundFocusPolicy.shouldFocus(
            request: 1,
            sessionId: nil,
            canCompose: true
        ))
        XCTAssertFalse(AgentComposerForegroundFocusPolicy.shouldFocus(
            request: 1,
            sessionId: "conv-existing",
            canCompose: true
        ))
        XCTAssertFalse(AgentComposerForegroundFocusPolicy.shouldFocus(
            request: 0,
            sessionId: nil,
            canCompose: true
        ))
        XCTAssertFalse(AgentComposerForegroundFocusPolicy.shouldFocus(
            request: 1,
            sessionId: nil,
            canCompose: false
        ))
    }

    func testConsumeReadsAndClearsTarget() {
        let router = NotificationRouter()
        router.pendingTarget = .watchFiring(watchId: "wat_1", firingKey: "wat_1:7")
        XCTAssertEqual(
            router.consume(),
            .watchFiring(watchId: "wat_1", firingKey: "wat_1:7")
        )
        XCTAssertNil(router.pendingTarget)
        XCTAssertNil(router.consume())
    }

    func testFromUserInfoParsesBrief() {
        let userInfo: [AnyHashable: Any] = [
            "aps": ["alert": ["title": "Morning brief", "body": "b"]],
            "omnesis": ["kind": "brief", "briefId": "brf_digest_1"],
        ]
        XCTAssertEqual(PushTarget.fromUserInfo(userInfo), .brief(briefId: "brf_digest_1"))
        // Malformed: missing briefId falls through to nil.
        let missing: [AnyHashable: Any] = ["omnesis": ["kind": "brief"]]
        XCTAssertNil(PushTarget.fromUserInfo(missing))
    }

    func testFromUserInfoParsesPrivacyApprovalUsingOpaqueIdOnly() {
        let userInfo: [AnyHashable: Any] = [
            "aps": ["alert": ["title": "Approval needed", "body": "Open Omnesis to review."]],
            "omnesis": ["kind": "privacy-approval", "approvalId": "approval-1"],
        ]
        XCTAssertEqual(
            PushTarget.fromUserInfo(userInfo),
            .privacyApproval(approvalId: "approval-1")
        )
        XCTAssertNil(
            PushTarget.fromUserInfo(["omnesis": ["kind": "privacy-approval"]])
        )
        XCTAssertNil(
            PushTarget.fromUserInfo([
                "omnesis": ["kind": "privacy-approval", "approvalId": "../admin/config"],
            ])
        )
        XCTAssertNil(
            PushTarget.fromUserInfo([
                "omnesis": ["kind": "privacy-approval", "approvalId": "approval/other"],
            ])
        )
    }
}

@available(iOS 17.0, *)
@MainActor
extension NotificationRouterTests {
    func testFromUserInfoParsesContentFreeAccessAuthorization() {
        XCTAssertEqual(
            PushTarget.fromUserInfo([
                "omnesis": ["kind": "access-authorization", "targetId": "access"],
            ]),
            .accessAuthorization
        )
        XCTAssertEqual(
            PushTarget.fromUserInfo(["omnesis": ["kind": "access-authorization"]]),
            .accessAuthorization
        )
        XCTAssertNil(PushTarget.fromUserInfo([
            "omnesis": ["kind": "access-authorization", "targetId": "request-secret"],
        ]))
    }

    func testFromUserInfoParsesAgentAnswer() {
        let userInfo: [AnyHashable: Any] = [
            "aps": ["alert": ["title": "Omnesis answered", "body": "Tap to read the answer."]],
            "omnesis": ["kind": "agent-answer", "conversationId": "conv-9"],
        ]
        XCTAssertEqual(
            PushTarget.fromUserInfo(userInfo),
            .agentAnswer(conversationId: "conv-9")
        )
        // Malformed: missing conversationId falls through to nil.
        XCTAssertNil(PushTarget.fromUserInfo(["omnesis": ["kind": "agent-answer"]]))
        XCTAssertNil(
            PushTarget.fromUserInfo(["omnesis": ["kind": "agent-answer", "conversationId": 7]])
        )
    }

    func testFromUserInfoParsesFlatClaimTargetWrittenByServiceExtension() {
        XCTAssertEqual(
            PushTarget.fromUserInfo([
                "omnesis": ["kind": "agent-answer", "targetId": "conv-flat-1"],
            ]),
            .agentAnswer(conversationId: "conv-flat-1")
        )
        XCTAssertEqual(
            PushTarget.fromUserInfo([
                "omnesis": ["kind": "brief", "targetId": "brief-flat-1"],
            ]),
            .brief(briefId: "brief-flat-1")
        )
        XCTAssertEqual(
            PushTarget.fromUserInfo([
                "omnesis": ["kind": "watch", "targetId": "watch-flat-1"],
            ]),
            .watch(watchId: "watch-flat-1")
        )
        XCTAssertEqual(
            PushTarget.fromUserInfo([
                "omnesis": [
                    "kind": "source-permission",
                    "targetId": "photos:local",
                    "affectedDeviceId": "device-1",
                ],
            ]),
            .sourcePermission(
                sourceId: "photos:local",
                affectedDeviceId: "device-1",
                sourceName: nil,
                affectedDeviceName: nil
            )
        )
        XCTAssertNil(PushTarget.fromUserInfo([
            "omnesis": ["kind": "source-permission", "targetId": "../photos"],
        ]))
    }

    func testFromUserInfoParsesLegacySourcePermissionPayload() {
        XCTAssertEqual(
            PushTarget.fromUserInfo([
                "omnesis": [
                    "kind": "source-permission",
                    "sourceId": "photos:local",
                    "affectedDeviceId": "device-1",
                ],
            ]),
            .sourcePermission(
                sourceId: "photos:local",
                affectedDeviceId: "device-1",
                sourceName: nil,
                affectedDeviceName: nil
            )
        )
        XCTAssertNil(PushTarget.fromUserInfo([
            "omnesis": [
                "kind": "source-permission",
                "targetId": "photos:local",
                "affectedDeviceId": "../device",
            ],
        ]))
    }

    func testSourcePermissionTapRoutesLocalMatchingAndLegacyClaimsLocally() {
        XCTAssertEqual(
            SourcePermissionTapRoute.resolve(
                affectedDeviceId: "device-local",
                currentDeviceId: "device-local"
            ),
            .local
        )
        XCTAssertEqual(
            SourcePermissionTapRoute.resolve(
                affectedDeviceId: nil,
                currentDeviceId: "device-local"
            ),
            .local
        )
    }

    func testSourcePermissionTapRoutesAnotherDeviceRemotely() {
        XCTAssertEqual(
            SourcePermissionTapRoute.resolve(
                affectedDeviceId: "device-remote",
                currentDeviceId: "device-local"
            ),
            .remote
        )
    }

    func testFromUserInfoParsesWatchFiring() {
        let userInfo: [AnyHashable: Any] = [
            "aps": ["alert": ["title": "listing-unanswered", "body": "Open Omnesis to see."]],
            "omnesis": [
                "kind": "watch-firing",
                "watchId": "6f1c9e2a-0b74-4c31-9a55-2d8e1f3b7c40",
                "firingKey": "6f1c9e2a-0b74-4c31-9a55-2d8e1f3b7c40:15775",
            ],
        ]
        XCTAssertEqual(
            PushTarget.fromUserInfo(userInfo),
            .watchFiring(
                watchId: "6f1c9e2a-0b74-4c31-9a55-2d8e1f3b7c40",
                firingKey: "6f1c9e2a-0b74-4c31-9a55-2d8e1f3b7c40:15775"
            )
        )
    }

    func testFromUserInfoRejectsWatchFiringMissingFiringKey() {
        // Both halves or neither: a watch id with no key names no firing, and
        // the tap would be indistinguishable from one nobody can place.
        XCTAssertNil(
            PushTarget.fromUserInfo([
                "omnesis": ["kind": "watch-firing", "watchId": "w-listing"],
            ])
        )
        XCTAssertNil(
            PushTarget.fromUserInfo([
                "omnesis": ["kind": "watch-firing", "firingKey": "w-listing:1"],
            ])
        )
        // A non-string field is the same malformed shape.
        XCTAssertNil(
            PushTarget.fromUserInfo([
                "omnesis": ["kind": "watch-firing", "watchId": "w-listing", "firingKey": 15775],
            ])
        )
    }

    func testWatchFiringKeyNamesTheJournalSequence() {
        // The gateway mints `<watchId>:<seq>`; the firings a device can read
        // are keyed by seq alone, so the tap's precision depends on this split.
        XCTAssertEqual(WatchFiringKey.seq(in: "w-listing:15775", forWatch: "w-listing"), 15775)
        XCTAssertEqual(WatchFiringKey.seq(in: "w-listing:0", forWatch: "w-listing"), 0)
        // A watch id holding a colon still resolves: the split is from the
        // right, because the sequence is the half that can never hold one.
        XCTAssertEqual(WatchFiringKey.seq(in: "ns:w-listing:42", forWatch: "ns:w-listing"), 42)
    }

    func testWatchFiringKeyRefusesEverythingItCannotPlace() {
        // A key naming a different watch than the tap did: the two halves of
        // the payload disagree, and marking a line from another watch's ledger
        // would be worse than marking none.
        XCTAssertNil(WatchFiringKey.seq(in: "w-payment:15775", forWatch: "w-listing"))
        // Prefix-only agreement is not agreement.
        XCTAssertNil(WatchFiringKey.seq(in: "w-listing-2:1", forWatch: "w-listing"))
        // No separator, no sequence, a non-numeric one, a signed one.
        XCTAssertNil(WatchFiringKey.seq(in: "w-listing", forWatch: "w-listing"))
        XCTAssertNil(WatchFiringKey.seq(in: "w-listing:", forWatch: "w-listing"))
        XCTAssertNil(WatchFiringKey.seq(in: "w-listing:abc", forWatch: "w-listing"))
        XCTAssertNil(WatchFiringKey.seq(in: "w-listing:-1", forWatch: "w-listing"))
        XCTAssertNil(WatchFiringKey.seq(in: "w-listing: 1", forWatch: "w-listing"))
        // Digits this app cannot hold are as unplaceable as letters.
        XCTAssertNil(WatchFiringKey.seq(in: "w-listing:99999999999999999999", forWatch: "w-listing"))
        // Non-ASCII digits parse as numbers to `Character.isNumber` but name
        // nothing the ledger is keyed by.
        XCTAssertNil(WatchFiringKey.seq(in: "w-listing:١٢٣", forWatch: "w-listing"))
    }

    func testEveryPushTargetHasAHomeSection() {
        // `homeTab(for:)` is total and takes no experimental input: a
        // target the gateway addressed to this app always has a
        // destination, whatever the app's /status mirror currently
        // reads (see HomeTab.swift).
        XCTAssertEqual(homeTab(for: .watchFiring(watchId: "wat_1", firingKey: "wat_1:7")), .watches)
        XCTAssertEqual(homeTab(for: .watch(watchId: "wat_1")), .watches)
        XCTAssertEqual(homeTab(for: .brief(briefId: "brf_1")), .briefs)
        XCTAssertEqual(homeTab(for: .privacyApproval(approvalId: "approval-1")), .privacy)
        XCTAssertEqual(homeTab(for: .agentAnswer(conversationId: "conv-9")), .agent)
        XCTAssertEqual(
            homeTab(for: .sourcePermission(
                sourceId: "photos:local",
                affectedDeviceId: nil,
                sourceName: nil,
                affectedDeviceName: nil
            )),
            .sources
        )
        XCTAssertEqual(
            homeTab(for: .watchFiring(watchId: "w-listing", firingKey: "w-listing:15775")),
            .watches
        )
    }

    func testKindNameCoversEveryCaseWithoutIds() {
        // `.public`-loggable labels: the case name only, never the
        // associated ids.
        XCTAssertEqual(
            PushTarget.watchFiring(watchId: "wat_1", firingKey: "wat_1:7").kindName,
            "watch-firing"
        )
        XCTAssertEqual(PushTarget.watch(watchId: "wat_1").kindName, "watch")
        XCTAssertEqual(PushTarget.brief(briefId: "brf_1").kindName, "brief")
        XCTAssertEqual(PushTarget.privacyApproval(approvalId: "approval-1").kindName, "privacy-approval")
        XCTAssertEqual(PushTarget.accessAuthorization.kindName, "access-authorization")
        XCTAssertEqual(PushTarget.agentAnswer(conversationId: "conv-9").kindName, "agent-answer")
        XCTAssertEqual(
            PushTarget.watchFiring(watchId: "w-listing", firingKey: "w-listing:15775").kindName,
            "watch-firing"
        )
    }

    #if canImport(UIKit)
    /// Thread-safe capture box for the delegate's `@Sendable` callback.
    private final class TargetRecorder: @unchecked Sendable {
        private let lock = NSLock()
        private var stored: [PushTarget] = []
        var targets: [PushTarget] {
            lock.withLock { stored }
        }

        func record(_ target: PushTarget) {
            lock.withLock { stored.append(target) }
        }
    }

    func testHandleNotificationTapDispatchesWhenCallbackIsBound() {
        let delegate = OmnesisAppDelegate()
        let recorder = TargetRecorder()
        delegate.onDidReceiveTarget = { recorder.record($0) }
        delegate.handleNotificationTap(userInfo: [
            "omnesis": ["kind": "watch-firing", "watchId": "wat_1", "firingKey": "wat_1:7"],
        ])
        XCTAssertEqual(recorder.targets, [.watchFiring(watchId: "wat_1", firingKey: "wat_1:7")])
    }

    func testHandleNotificationTapPreBindBuffersAndDrainsOnce() {
        let delegate = OmnesisAppDelegate()
        let recorder = TargetRecorder()
        // Tap lands before the SwiftUI task wires the callback (cold
        // tap-launch): buffered, then drained by the wire-up.
        delegate.handleNotificationTap(userInfo: [
            "omnesis": ["kind": "watch-firing", "watchId": "wat_1", "firingKey": "wat_1:7"],
        ])
        XCTAssertTrue(recorder.targets.isEmpty)
        delegate.onDidReceiveTarget = { recorder.record($0) }
        XCTAssertEqual(recorder.targets, [.watchFiring(watchId: "wat_1", firingKey: "wat_1:7")])
        // Re-wiring must not replay the drained target.
        delegate.onDidReceiveTarget = { recorder.record($0) }
        XCTAssertEqual(recorder.targets.count, 1)
    }

    func testHandleNotificationTapIgnoresUnrecognisedPayloads() {
        let delegate = OmnesisAppDelegate()
        let recorder = TargetRecorder()
        delegate.onDidReceiveTarget = { recorder.record($0) }
        delegate.handleNotificationTap(userInfo: ["omnesis": ["kind": "future-kind"]])
        delegate.handleNotificationTap(userInfo: ["aps": ["alert": "hello"]])
        XCTAssertTrue(recorder.targets.isEmpty)
    }
    #endif

    func testFromUserInfoReturnsNilForUnknownKind() {
        let userInfo: [AnyHashable: Any] = [
            "omnesis": ["kind": "future-kind", "x": "y"],
        ]
        XCTAssertNil(PushTarget.fromUserInfo(userInfo))
    }

    func testFromUserInfoReturnsNilWhenOmnesisDictMissing() {
        let userInfo: [AnyHashable: Any] = [
            "aps": ["alert": "hello"],
        ]
        XCTAssertNil(PushTarget.fromUserInfo(userInfo))
    }

    func testFromUserInfoReturnsNilWhenRequiredFieldsAreMissing() {
        let userInfo: [AnyHashable: Any] = [
            "omnesis": ["kind": "watch-firing", "watchId": "wat_1"],
            // No firingKey.
        ]
        XCTAssertNil(PushTarget.fromUserInfo(userInfo))
    }
}
