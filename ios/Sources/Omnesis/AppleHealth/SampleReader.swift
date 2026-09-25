// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation
#if canImport(HealthKit)
import HealthKit

/// Converts HealthKit's native sample types into the platform-neutral
/// `NormalizedSample` struct the rest of the pipeline consumes.
///
/// iOS-only — the rest of the codebase works with `NormalizedSample`
/// directly so macOS `swift test` runs without HealthKit.
@available(iOS 17.0, *)
public enum HKSampleExtractor {
    private static let iso8601: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f
    }()

    /// Convert an HKSample + its `TypeEntry` into a `NormalizedSample`.
    /// Returns `nil` for sample shapes we don't recognise (defensive —
    /// should not happen for v1 types).
    public static func extract(
        _ sample: HKSample,
        entry: TypeEntry
    )
        -> NormalizedSample? {
        let id = sample.uuid.uuidString
        let startTime = iso8601.string(from: sample.startDate)
        let endTime = iso8601.string(from: sample.endDate)
        let sourceApp = sample.sourceRevision.source.bundleIdentifier
        let sourceDevice = sample.device?.name ?? sample.sourceRevision.source.name
        let metadata = encodeMetadata(sample.metadata)

        switch entry.category {
        case .sleep:
            return extractSleep(
                sample, id: id, startTime: startTime, endTime: endTime,
                sourceApp: sourceApp, sourceDevice: sourceDevice,
                metadata: metadata, entry: entry
            )
        case .workouts:
            return extractWorkout(
                sample, id: id, startTime: startTime, endTime: endTime,
                sourceApp: sourceApp, sourceDevice: sourceDevice,
                metadata: metadata, entry: entry
            )
        case .mindful:
            // Mindfulness is an HKCategorySample with no meaningful
            // value — duration derives from the end-start interval.
            return NormalizedSample(
                id: id,
                category: .mindful,
                metric: entry.identifier,
                value: nil,
                unit: nil,
                startTime: startTime,
                endTime: endTime,
                sourceApp: sourceApp,
                sourceDevice: sourceDevice,
                metadata: metadata,
                sleep: nil,
                workout: nil
            )
        case .mood:
            // `extractMood` requires iOS 18 / macOS 15 (`HKStateOfMind`
            // doesn't exist before them); `entry.sampleType` already
            // returns `nil` on older OS versions so this branch is
            // unreachable there in practice, but the explicit check
            // keeps this function callable from an iOS-17 context.
            if #available(iOS 18.0, macOS 15.0, *) {
                return extractMood(
                    sample, id: id, startTime: startTime, endTime: endTime,
                    sourceApp: sourceApp, sourceDevice: sourceDevice,
                    metadata: metadata, entry: entry
                )
            }
            return nil
        case .body, .activity, .vitals, .nutrition, .environment:
            guard let quantity = sample as? HKQuantitySample else { return nil }
            let unit = canonicalUnit(for: entry)
            let value = quantity.quantity.doubleValue(for: unit)
            return NormalizedSample(
                id: id,
                category: entry.category,
                metric: entry.identifier,
                value: value,
                unit: entry.unit,
                startTime: startTime,
                endTime: endTime,
                sourceApp: sourceApp,
                sourceDevice: sourceDevice,
                metadata: metadata,
                sleep: nil,
                workout: nil
            )
        }
    }

    // MARK: - Specialisations

    private static func extractSleep(
        _ sample: HKSample,
        id: String, startTime: String, endTime: String,
        sourceApp: String?, sourceDevice: String?,
        metadata: JSONValue?, entry: TypeEntry
    )
        -> NormalizedSample? {
        guard let category = sample as? HKCategorySample else { return nil }
        let stage = sleepStage(rawValue: category.value)
        return NormalizedSample(
            id: id,
            category: .sleep,
            metric: entry.identifier,
            value: nil,
            unit: nil,
            startTime: startTime,
            endTime: endTime,
            sourceApp: sourceApp,
            sourceDevice: sourceDevice,
            metadata: metadata,
            sleep: SleepAttributes(stage: stage),
            workout: nil
        )
    }

    private static func extractWorkout(
        _ sample: HKSample,
        id: String, startTime: String, endTime: String,
        sourceApp: String?, sourceDevice: String?,
        metadata: JSONValue?, entry: TypeEntry
    )
        -> NormalizedSample? {
        guard let workout = sample as? HKWorkout else { return nil }
        let duration = Int(workout.duration.rounded())

        // HKWorkout's totalDistance / totalEnergyBurned were deprecated
        // in iOS 18 in favour of statistics(for:). Use the new API when
        // available; fall back otherwise.
        let distance: Double?
        let energy: Double?
        if #available(iOS 18.0, *) {
            let distType = HKQuantityType.quantityType(forIdentifier: .distanceWalkingRunning)!
            let energyType = HKQuantityType.quantityType(forIdentifier: .activeEnergyBurned)!
            distance = workout.statistics(for: distType)?.sumQuantity()?.doubleValue(for: .meter())
            energy = workout.statistics(for: energyType)?.sumQuantity()?
                .doubleValue(for: .kilocalorie())
        } else {
            distance = workout.totalDistance?.doubleValue(for: .meter())
            energy = workout.totalEnergyBurned?.doubleValue(for: .kilocalorie())
        }

        return NormalizedSample(
            id: id,
            category: .workouts,
            metric: entry.identifier,
            value: nil,
            unit: nil,
            startTime: startTime,
            endTime: endTime,
            sourceApp: sourceApp,
            sourceDevice: sourceDevice,
            metadata: metadata,
            sleep: nil,
            workout: WorkoutAttributes(
                workoutType: workoutTypeName(workout.workoutActivityType),
                durationSeconds: duration,
                totalDistanceMeters: distance,
                totalEnergyKcal: energy
            )
        )
    }

    /// Requires iOS 18 / macOS 15 — `HKStateOfMind` doesn't exist before
    /// them. Guarded defensively here too since `entry.sampleType`
    /// already returns `nil` pre-iOS-18, which keeps this path from ever
    /// running on an older OS.
    @available(iOS 18.0, macOS 15.0, *)
    private static func extractMood(
        _ sample: HKSample,
        id: String, startTime: String, endTime: String,
        sourceApp: String?, sourceDevice: String?,
        metadata: JSONValue?, entry: TypeEntry
    )
        -> NormalizedSample? {
        guard let state = sample as? HKStateOfMind else { return nil }
        return NormalizedSample(
            id: id,
            category: .mood,
            metric: entry.identifier,
            value: nil,
            unit: nil,
            startTime: startTime,
            endTime: endTime,
            sourceApp: sourceApp,
            sourceDevice: sourceDevice,
            metadata: metadata,
            sleep: nil,
            workout: nil,
            mood: MoodAttributes(
                kind: moodKindName(state.kind),
                valence: state.valence,
                labels: state.labels.map(moodLabelName),
                associations: state.associations.map(moodAssociationName)
            )
        )
    }

    @available(iOS 18.0, macOS 15.0, *)
    private static func moodKindName(_ kind: HKStateOfMind.Kind) -> String {
        switch kind {
        case .momentaryEmotion: "momentaryEmotion"
        case .dailyMood: "dailyMood"
        @unknown default: "unknown"
        }
    }

    /// Lookup tables rather than a giant switch — a flat enum→String
    /// rename has no branching logic to speak of, and a dictionary keeps
    /// each of the ~37 labels / 18 associations a one-line entry instead
    /// of a `case` arm.
    @available(iOS 18.0, macOS 15.0, *)
    private static let moodLabelNames: [HKStateOfMind.Label: String] = [
        .amazed: "amazed", .amused: "amused", .angry: "angry", .anxious: "anxious",
        .ashamed: "ashamed", .brave: "brave", .calm: "calm", .content: "content",
        .disappointed: "disappointed", .discouraged: "discouraged", .disgusted: "disgusted",
        .embarrassed: "embarrassed", .excited: "excited", .frustrated: "frustrated",
        .grateful: "grateful", .guilty: "guilty", .happy: "happy", .hopeless: "hopeless",
        .irritated: "irritated", .jealous: "jealous", .joyful: "joyful", .lonely: "lonely",
        .passionate: "passionate", .peaceful: "peaceful", .proud: "proud", .relieved: "relieved",
        .sad: "sad", .scared: "scared", .stressed: "stressed", .surprised: "surprised",
        .worried: "worried", .annoyed: "annoyed", .confident: "confident", .drained: "drained",
        .hopeful: "hopeful", .indifferent: "indifferent", .overwhelmed: "overwhelmed",
        .satisfied: "satisfied",
    ]

    @available(iOS 18.0, macOS 15.0, *)
    private static func moodLabelName(_ label: HKStateOfMind.Label) -> String {
        moodLabelNames[label] ?? "hk_\(label.rawValue)"
    }

    @available(iOS 18.0, macOS 15.0, *)
    private static let moodAssociationNames: [HKStateOfMind.Association: String] = [
        .community: "community", .currentEvents: "currentEvents", .dating: "dating",
        .education: "education", .family: "family", .fitness: "fitness", .friends: "friends",
        .health: "health", .hobbies: "hobbies", .identity: "identity", .money: "money",
        .partner: "partner", .selfCare: "selfCare", .spirituality: "spirituality",
        .tasks: "tasks", .travel: "travel", .work: "work", .weather: "weather",
    ]

    @available(iOS 18.0, macOS 15.0, *)
    private static func moodAssociationName(_ association: HKStateOfMind.Association) -> String {
        moodAssociationNames[association] ?? "hk_\(association.rawValue)"
    }

    // MARK: - Unit / enum mapping

    /// Canonical-unit-string → `HKUnit` mapping for quantity samples.
    /// The catalog stores a short canonical unit string (`kg`, `bpm`,
    /// `mcg`, …); this resolves it to the `HKUnit` we read the quantity
    /// in. `TypeCatalogTests.testEveryQuantityUnitIsSupported` pins the
    /// catalog to these keys so a new unit can't be added without a
    /// matching entry here.
    private static let unitTable: [String: HKUnit] = [
        "kg": .gramUnit(with: .kilo),
        "cm": .meterUnit(with: .centi),
        "m": .meter(),
        "%": .percent(),
        "bpm": HKUnit.count().unitDivided(by: .minute()),
        "mmHg": .millimeterOfMercury(),
        "mg/dL": HKUnit.gramUnit(with: .milli).unitDivided(by: .literUnit(with: .deci)),
        "°C": .degreeCelsius(),
        "breaths/min": HKUnit.count().unitDivided(by: .minute()),
        "kcal": .kilocalorie(),
        "min": .minute(),
        "ml": .literUnit(with: .milli),
        "g": .gram(),
        "mg": .gramUnit(with: .milli),
        "mcg": .gramUnit(with: .micro),
        "m/s": HKUnit.meter().unitDivided(by: .second()),
        "count": .count(),
        "ml/kg·min": HKUnit.literUnit(with: .milli)
            .unitDivided(by: .gramUnit(with: .kilo).unitMultiplied(by: .minute())),
        "ms": .secondUnit(with: .milli),
        "dBASPL": .decibelAWeightedSoundPressureLevel(),
    ]

    private static func canonicalUnit(for entry: TypeEntry) -> HKUnit {
        unitTable[entry.unit ?? ""] ?? .count()
    }

    private static func sleepStage(rawValue: Int) -> String {
        switch HKCategoryValueSleepAnalysis(rawValue: rawValue) {
        case .some(.inBed): "inBed"
        case .some(.asleepUnspecified): "asleepUnspecified"
        case .some(.asleepCore): "asleepCore"
        case .some(.asleepDeep): "asleepDeep"
        case .some(.asleepREM): "asleepREM"
        case .some(.awake): "awake"
        default: "asleepUnspecified"
        }
    }

    private static func workoutTypeName(_ type: HKWorkoutActivityType) -> String {
        // A small subset; everything else renders as its numeric raw.
        switch type {
        case .running: "running"
        case .walking: "walking"
        case .cycling: "cycling"
        case .swimming: "swimming"
        case .hiking: "hiking"
        case .yoga: "yoga"
        case .traditionalStrengthTraining: "strength"
        case .functionalStrengthTraining: "functional_strength"
        case .highIntensityIntervalTraining: "hiit"
        case .elliptical: "elliptical"
        case .rowing: "rowing"
        case .other: "other"
        default: "hk_\(type.rawValue)"
        }
    }

    private static func encodeMetadata(_ metadata: [String: Any]?) -> JSONValue? {
        guard let metadata, !metadata.isEmpty else { return nil }
        var obj: [String: JSONValue] = [:]
        for (key, value) in metadata {
            obj[key] = jsonValue(from: value)
        }
        return .object(obj)
    }

    private static func jsonValue(from any: Any) -> JSONValue {
        if let s = any as? String { return .string(s) }
        if let b = any as? Bool { return .bool(b) }
        if let i = any as? Int { return .int(Int64(i)) }
        if let i = any as? Int64 { return .int(i) }
        if let d = any as? Double { return .double(d) }
        if let d = any as? Date {
            return .string(iso8601.string(from: d))
        }
        if let q = any as? HKQuantity {
            return .string(q.description)
        }
        if let arr = any as? [Any] {
            return .array(arr.map { jsonValue(from: $0) })
        }
        if let dict = any as? [String: Any] {
            var obj: [String: JSONValue] = [:]
            for (k, v) in dict {
                obj[k] = jsonValue(from: v)
            }
            return .object(obj)
        }
        return .string(String(describing: any))
    }
}
#endif
