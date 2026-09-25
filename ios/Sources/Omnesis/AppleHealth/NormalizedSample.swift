// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation

/// Platform-neutral shape extracted from an HKSample. Exists so the
/// record-building logic in `Normalizer` is testable on macOS (where
/// HealthKit isn't available) without needing to construct real
/// HKSample instances.
///
/// On iOS, `extractNormalizedSample(from:account:)` in SampleReader
/// fills this in from an `HKQuantitySample` / `HKCategorySample` /
/// `HKWorkout`. On macOS, tests construct `NormalizedSample` directly.
public struct NormalizedSample: Equatable, Sendable {
    /// Opaque sample ID — typically `HKSample.uuid.uuidString`. Used as
    /// the DuckDB primary key so re-ingesting is a safe no-op.
    public let id: String

    /// Which row family this sample belongs to. Drives which table the
    /// record lands in (see TypeCatalog).
    public let category: HealthCategory

    /// HealthKit quantity-type identifier or category-type identifier
    /// (e.g. `HKQuantityTypeIdentifierBodyMass`). Becomes the `metric`
    /// column on row-per-sample tables.
    public let metric: String

    /// Numeric value expressed in `unit`. `nil` for samples that don't
    /// have a quantity value (e.g. sleep stages, workouts — those go
    /// into specialized tables via `workout` / `sleep`).
    public let value: Double?

    /// Canonical unit string (`kg`, `bpm`, `m`, `kcal`, ...).
    public let unit: String?

    /// UTC sample start time in ISO 8601 — DuckDB's TIMESTAMPTZ.
    public let startTime: String

    /// UTC sample end time. Same as startTime for instantaneous
    /// readings (like a single heart-rate sample).
    public let endTime: String

    /// Bundle id of the app that wrote the sample, if known.
    public let sourceApp: String?

    /// Device name the sample originated from, if known.
    public let sourceDevice: String?

    /// Arbitrary HealthKit metadata dictionary as a JSON blob.
    public let metadata: JSONValue?

    /// Sleep-only. Nil for everything else.
    public let sleep: SleepAttributes?

    /// Workout-only. Nil for everything else.
    public let workout: WorkoutAttributes?

    /// State-of-mind-only. Nil for everything else.
    public let mood: MoodAttributes?

    public init(
        id: String,
        category: HealthCategory,
        metric: String,
        value: Double? = nil,
        unit: String? = nil,
        startTime: String,
        endTime: String,
        sourceApp: String? = nil,
        sourceDevice: String? = nil,
        metadata: JSONValue? = nil,
        sleep: SleepAttributes? = nil,
        workout: WorkoutAttributes? = nil,
        mood: MoodAttributes? = nil
    ) {
        self.id = id
        self.category = category
        self.metric = metric
        self.value = value
        self.unit = unit
        self.startTime = startTime
        self.endTime = endTime
        self.sourceApp = sourceApp
        self.sourceDevice = sourceDevice
        self.metadata = metadata
        self.sleep = sleep
        self.workout = workout
        self.mood = mood
    }
}

public struct SleepAttributes: Equatable, Sendable {
    /// `inBed`, `asleepCore`, `asleepREM`, `asleepDeep`, `asleepUnspecified`, `awake`.
    public let stage: String

    public init(stage: String) {
        self.stage = stage
    }
}

public struct WorkoutAttributes: Equatable, Sendable {
    public let workoutType: String // "running", "cycling", ...
    public let durationSeconds: Int
    public let totalDistanceMeters: Double?
    public let totalEnergyKcal: Double?

    public init(
        workoutType: String,
        durationSeconds: Int,
        totalDistanceMeters: Double?,
        totalEnergyKcal: Double?
    ) {
        self.workoutType = workoutType
        self.durationSeconds = durationSeconds
        self.totalDistanceMeters = totalDistanceMeters
        self.totalEnergyKcal = totalEnergyKcal
    }
}

/// Fields specific to an `HKStateOfMind` log (iOS 18+ Mental Wellbeing).
public struct MoodAttributes: Equatable, Sendable {
    /// `"momentaryEmotion"` or `"dailyMood"`.
    public let kind: String

    /// Self-reported pleasantness, -1 (very unpleasant) to +1 (very pleasant).
    public let valence: Double

    /// Felt-experience descriptors the user selected (e.g. `"happy"`, `"anxious"`).
    public let labels: [String]

    /// Life-context associations the user selected (e.g. `"work"`, `"family"`).
    public let associations: [String]

    public init(
        kind: String,
        valence: Double,
        labels: [String],
        associations: [String]
    ) {
        self.kind = kind
        self.valence = valence
        self.labels = labels
        self.associations = associations
    }
}

/// Logical grouping that determines which DuckDB table a sample lands in.
/// 1:1 with the `health_*` tables in gateway-side schemas.
public enum HealthCategory: String, CaseIterable, Sendable {
    case body = "health_body"
    case activity = "health_activity"
    case vitals = "health_vitals"
    case sleep = "health_sleep"
    case nutrition = "health_nutrition"
    case mindful = "health_mindful"
    case environment = "health_environment"
    case workouts = "health_workouts"
    case mood = "health_mood"

    public var tableName: String {
        rawValue
    }
}
