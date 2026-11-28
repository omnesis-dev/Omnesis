// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation
import IOKit.ps

/// Owns exactly one public power-source notification registration. It changes no policy.
@MainActor
final class DesktopMacServerPowerWatcher {
    typealias Change = @MainActor @Sendable () -> Void
    typealias Subscribe = @MainActor (@escaping Change) -> DesktopMacServerPowerSubscription?
    private let subscribe: Subscribe
    private let onChange: Change
    private var subscription: DesktopMacServerPowerSubscription?
    private var generation = UUID()

    init(onChange: @escaping Change, subscribe: Subscribe? = nil) {
        self.onChange = onChange
        self.subscribe = subscribe ?? Self.observeSystem
    }

    @discardableResult
    func start() -> Bool {
        if subscription != nil { return true }
        generation = UUID()
        let expected = generation
        subscription = subscribe { [weak self] in
            guard let self, self.generation == expected else { return }
            // The owner immediately invalidates readiness and schedules its one
            // coalesced refresh. A power notification never certifies readiness.
            self.onChange()
        }
        return subscription != nil
    }

    func stop() {
        generation = UUID()
        subscription?.cancel()
        subscription = nil
    }

    deinit { subscription?.cancel() }

    private static func observeSystem(_ changed: @escaping Change) -> DesktopMacServerPowerSubscription? {
        let initial = supplyingPower()
        let context = Callback(changed, initial: initial)
        guard let source = IOPSNotificationCreateRunLoopSource({ pointer in
            guard let pointer else { return }
            let context = Unmanaged<Callback>.fromOpaque(pointer).takeUnretainedValue()
            // This source is installed only on the main run loop below.
            MainActor.assumeIsolated { context.deliver(DesktopMacServerPowerWatcher.supplyingPower()) }
        }, Unmanaged.passUnretained(context).toOpaque())?.takeRetainedValue() else { return nil }
        CFRunLoopAddSource(CFRunLoopGetMain(), source, .commonModes)
        if initial == .unknown {
            // Deliver after start has retained its subscription; cancellation's
            // generation fence also rejects this queued initial uncertainty.
            Task { @MainActor in context.deliver(Self.supplyingPower()) }
        }
        return DesktopMacServerPowerSubscription {
            let cleanup: @Sendable () -> Void = {
                // Keep the context alive until removal/invalidation completes,
                // including when owner destruction occurs outside the main actor.
                withExtendedLifetime(context) {
                    CFRunLoopRemoveSource(CFRunLoopGetMain(), source, .commonModes)
                    CFRunLoopSourceInvalidate(source)
                }
            }
            if Thread.isMainThread { cleanup() }
            else { DispatchQueue.main.async(execute: cleanup) }
        }
    }

    private static func supplyingPower() -> DesktopMacServerSupplyingPower {
        guard let snapshot = IOPSCopyPowerSourcesInfo()?.takeRetainedValue(),
              let supplied = IOPSGetProvidingPowerSourceType(snapshot)?.takeUnretainedValue() else { return .unknown }
        switch supplied as String {
        case kIOPMACPowerKey: return .ac
        case kIOPMBatteryPowerKey: return .battery
        case kIOPMUPSPowerKey: return .ups
        default: return .unknown
        }
    }

    private final class Callback: @unchecked Sendable {
        let changed: Change
        private var transitions: DesktopMacServerPowerTransitions
        @MainActor init(_ changed: @escaping Change, initial: DesktopMacServerSupplyingPower) {
            self.changed = changed
            transitions = DesktopMacServerPowerTransitions(previous: initial)
        }

        @MainActor func deliver(_ source: DesktopMacServerSupplyingPower) {
            if transitions.observe(source) { changed() }
        }
    }
}

/// Cancellation is idempotent; the subscription also removes its source on release.
final class DesktopMacServerPowerSubscription: @unchecked Sendable {
    private let lock = NSLock()
    private var cancellation: (@Sendable () -> Void)?
    init(_ cancellation: @escaping @Sendable () -> Void) {
        self.cancellation = cancellation
    }

    func cancel() {
        lock.lock()
        let action = cancellation
        cancellation = nil
        lock.unlock()
        action?()
    }

    deinit { cancel() }
}

// Charge and time estimates may change frequently without a supplying-source
// transition. Unknown evidence always invalidates, including repeated failures.
enum DesktopMacServerSupplyingPower: Equatable { case ac, battery, ups, unknown }
struct DesktopMacServerPowerTransitions {
    var previous: DesktopMacServerSupplyingPower
    mutating func observe(_ current: DesktopMacServerSupplyingPower) -> Bool {
        defer { previous = current }
        return current == .unknown || previous != current
    }
}
