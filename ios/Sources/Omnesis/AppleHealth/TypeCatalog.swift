// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation
#if canImport(HealthKit)
import HealthKit
#endif

/// Declarative description of one HealthKit sample type we read.
public struct TypeEntry: Sendable, Equatable {
    /// Full HealthKit identifier, e.g. `HKQuantityTypeIdentifierBodyMass`.
    /// Stable across iOS versions; used as the `metric` column on row
    /// tables and as the anchor-map key.
    public let identifier: String

    /// Short machine slug for DuckDB columns and analytics queries.
    public let metricSlug: String

    /// Logical grouping → target DuckDB table.
    public let category: HealthCategory

    /// DuckDB column type for the `value` column (when applicable).
    /// For samples without a scalar value (sleep, workouts) this is ignored.
    public let valueType: ColumnType

    /// Canonical unit emitted on the wire (`kg`, `bpm`, `m`, ...). `nil`
    /// for types that don't have a numeric value.
    public let unit: String?

    public init(
        identifier: String,
        metricSlug: String,
        category: HealthCategory,
        valueType: ColumnType = .double,
        unit: String? = nil
    ) {
        self.identifier = identifier
        self.metricSlug = metricSlug
        self.category = category
        self.valueType = valueType
        self.unit = unit
    }
}

/// v1 set of HealthKit types Omnesis reads. See design doc §6.
///
/// TODO(#164): full HealthKit identifier coverage is still in progress.
/// Shipped here: nutrition micros (vitamins + minerals), mobility
/// (walking/stair gait quantities), and cardio (AFib burden, HR
/// recovery, walking HR average) — all plain quantity samples that fold
/// into the existing nutrition / activity / vitals categories with no
/// new gateway table. Still deferred (each needs a new table, a
/// non-quantity extractor shape, or a naming decision): symptoms
/// (HKCategoryType, ~40 types), state-of-mind (HKStateOfMind),
/// characteristics (HKCharacteristicType separate read path),
/// hearing-event category types (audioExposureEvent, …), and the
/// reproductive-health category types.
///
/// Order matters: the collector sync cycle rotates through types in
/// this order, one per `sync()` call. Ordering body/activity/vitals
/// first means a weigh-in comes through promptly; stats-heavy types
/// like heart rate stream in after.
public enum TypeCatalog {
    /// Full ordered catalog. Composed from two extension-hosted arrays;
    /// the split is purely to keep each declaration body under SwiftLint's
    /// `type_body_length` limit.
    public static let v1: [TypeEntry] = coreTypes + supplementalTypes

    public static func entry(for identifier: String) -> TypeEntry? {
        v1.first { $0.identifier == identifier }
    }
}

extension TypeCatalog {
    /// Body, activity, vitals, sleep — emitted first so a weigh-in or a
    /// fresh heart-rate sample reaches the gateway promptly.
    static let coreTypes: [TypeEntry] = [
        // ── Body composition ──────────────────────────────────────────
        TypeEntry(
            identifier: "HKQuantityTypeIdentifierBodyMass",
            metricSlug: "body_mass",
            category: .body, unit: "kg"
        ),
        TypeEntry(
            identifier: "HKQuantityTypeIdentifierBodyFatPercentage",
            metricSlug: "body_fat_pct",
            category: .body, unit: "%"
        ),
        TypeEntry(
            identifier: "HKQuantityTypeIdentifierLeanBodyMass",
            metricSlug: "lean_mass",
            category: .body, unit: "kg"
        ),
        TypeEntry(
            identifier: "HKQuantityTypeIdentifierBodyMassIndex",
            metricSlug: "bmi",
            category: .body, unit: ""
        ),
        TypeEntry(
            identifier: "HKQuantityTypeIdentifierWaistCircumference",
            metricSlug: "waist",
            category: .body, unit: "cm"
        ),
        TypeEntry(
            identifier: "HKQuantityTypeIdentifierHeight",
            metricSlug: "height",
            category: .body, unit: "cm"
        ),

        // ── Activity ──────────────────────────────────────────────────
        TypeEntry(
            identifier: "HKQuantityTypeIdentifierStepCount",
            metricSlug: "steps",
            category: .activity, valueType: .integer, unit: "count"
        ),
        TypeEntry(
            identifier: "HKQuantityTypeIdentifierDistanceWalkingRunning",
            metricSlug: "distance_walk_run",
            category: .activity, unit: "m"
        ),
        TypeEntry(
            identifier: "HKQuantityTypeIdentifierDistanceCycling",
            metricSlug: "distance_cycle",
            category: .activity, unit: "m"
        ),
        TypeEntry(
            identifier: "HKQuantityTypeIdentifierDistanceSwimming",
            metricSlug: "distance_swim",
            category: .activity, unit: "m"
        ),
        TypeEntry(
            identifier: "HKQuantityTypeIdentifierActiveEnergyBurned",
            metricSlug: "active_kcal",
            category: .activity, unit: "kcal"
        ),
        TypeEntry(
            identifier: "HKQuantityTypeIdentifierBasalEnergyBurned",
            metricSlug: "basal_kcal",
            category: .activity, unit: "kcal"
        ),
        TypeEntry(
            identifier: "HKQuantityTypeIdentifierAppleExerciseTime",
            metricSlug: "exercise_minutes",
            category: .activity, valueType: .integer, unit: "min"
        ),
        TypeEntry(
            identifier: "HKQuantityTypeIdentifierAppleStandTime",
            metricSlug: "stand_minutes",
            category: .activity, valueType: .integer, unit: "min"
        ),
        TypeEntry(
            identifier: "HKQuantityTypeIdentifierFlightsClimbed",
            metricSlug: "flights",
            category: .activity, valueType: .integer, unit: "count"
        ),
        TypeEntry(
            identifier: "HKQuantityTypeIdentifierVO2Max",
            metricSlug: "vo2max",
            category: .activity, unit: "ml/kg·min"
        ),

        // ── Mobility (gait metrics → activity) ─────────────────────────
        TypeEntry(
            identifier: "HKQuantityTypeIdentifierWalkingSpeed",
            metricSlug: "walking_speed",
            category: .activity,
            unit: "m/s"
        ),
        TypeEntry(
            identifier: "HKQuantityTypeIdentifierWalkingStepLength",
            metricSlug: "walking_step_length",
            category: .activity,
            unit: "cm"
        ),
        TypeEntry(
            identifier: "HKQuantityTypeIdentifierWalkingAsymmetryPercentage",
            metricSlug: "walking_asymmetry_pct",
            category: .activity,
            unit: "%"
        ),
        TypeEntry(
            identifier: "HKQuantityTypeIdentifierWalkingDoubleSupportPercentage",
            metricSlug: "walking_double_support_pct",
            category: .activity,
            unit: "%"
        ),
        TypeEntry(
            identifier: "HKQuantityTypeIdentifierStairAscentSpeed",
            metricSlug: "stair_ascent_speed",
            category: .activity,
            unit: "m/s"
        ),
        TypeEntry(
            identifier: "HKQuantityTypeIdentifierStairDescentSpeed",
            metricSlug: "stair_descent_speed",
            category: .activity,
            unit: "m/s"
        ),
        TypeEntry(
            identifier: "HKQuantityTypeIdentifierSixMinuteWalkTestDistance",
            metricSlug: "six_minute_walk_distance",
            category: .activity,
            unit: "m"
        ),
        TypeEntry(
            identifier: "HKQuantityTypeIdentifierAppleWalkingSteadiness",
            metricSlug: "walking_steadiness",
            category: .activity,
            unit: "%"
        ),

        // ── Vitals ────────────────────────────────────────────────────
        TypeEntry(
            identifier: "HKQuantityTypeIdentifierHeartRate",
            metricSlug: "heart_rate",
            category: .vitals, unit: "bpm"
        ),
        TypeEntry(
            identifier: "HKQuantityTypeIdentifierRestingHeartRate",
            metricSlug: "resting_hr",
            category: .vitals, unit: "bpm"
        ),
        TypeEntry(
            identifier: "HKQuantityTypeIdentifierHeartRateVariabilitySDNN",
            metricSlug: "hrv",
            category: .vitals, unit: "ms"
        ),
        TypeEntry(
            identifier: "HKQuantityTypeIdentifierBloodPressureSystolic",
            metricSlug: "bp_systolic",
            category: .vitals, unit: "mmHg"
        ),
        TypeEntry(
            identifier: "HKQuantityTypeIdentifierBloodPressureDiastolic",
            metricSlug: "bp_diastolic",
            category: .vitals, unit: "mmHg"
        ),
        TypeEntry(
            identifier: "HKQuantityTypeIdentifierOxygenSaturation",
            metricSlug: "spo2",
            category: .vitals, unit: "%"
        ),
        TypeEntry(
            identifier: "HKQuantityTypeIdentifierBloodGlucose",
            metricSlug: "blood_glucose",
            category: .vitals, unit: "mg/dL"
        ),
        TypeEntry(
            identifier: "HKQuantityTypeIdentifierBodyTemperature",
            metricSlug: "body_temperature",
            category: .vitals, unit: "°C"
        ),
        TypeEntry(
            identifier: "HKQuantityTypeIdentifierRespiratoryRate",
            metricSlug: "respiratory_rate",
            category: .vitals, unit: "breaths/min"
        ),

        // ── Cardio (quantity samples → vitals) ─────────────────────────
        TypeEntry(
            identifier: "HKQuantityTypeIdentifierAtrialFibrillationBurden",
            metricSlug: "afib_burden",
            category: .vitals,
            unit: "%"
        ),
        TypeEntry(
            identifier: "HKQuantityTypeIdentifierHeartRateRecoveryOneMinute",
            metricSlug: "hr_recovery_1min",
            category: .vitals,
            unit: "bpm"
        ),
        TypeEntry(
            identifier: "HKQuantityTypeIdentifierWalkingHeartRateAverage",
            metricSlug: "walking_hr_avg",
            category: .vitals,
            unit: "bpm"
        ),

        // ── Sleep ─────────────────────────────────────────────────────
        TypeEntry(
            identifier: "HKCategoryTypeIdentifierSleepAnalysis",
            metricSlug: "sleep",
            category: .sleep, valueType: .varchar, unit: nil
        ),
    ]
}

extension TypeCatalog {
    /// Nutrition (macros + micros), mindfulness, environment, workouts.
    static let supplementalTypes: [TypeEntry] = [
        // ── Nutrition (macros) ────────────────────────────────────────
        TypeEntry(
            identifier: "HKQuantityTypeIdentifierDietaryEnergyConsumed",
            metricSlug: "energy_kcal",
            category: .nutrition, unit: "kcal"
        ),
        TypeEntry(
            identifier: "HKQuantityTypeIdentifierDietaryProtein",
            metricSlug: "protein_g",
            category: .nutrition, unit: "g"
        ),
        TypeEntry(
            identifier: "HKQuantityTypeIdentifierDietaryCarbohydrates",
            metricSlug: "carbs_g",
            category: .nutrition, unit: "g"
        ),
        TypeEntry(
            identifier: "HKQuantityTypeIdentifierDietaryFatTotal",
            metricSlug: "fat_g",
            category: .nutrition, unit: "g"
        ),
        TypeEntry(
            identifier: "HKQuantityTypeIdentifierDietarySugar",
            metricSlug: "sugar_g",
            category: .nutrition, unit: "g"
        ),
        TypeEntry(
            identifier: "HKQuantityTypeIdentifierDietaryFiber",
            metricSlug: "fiber_g",
            category: .nutrition, unit: "g"
        ),
        TypeEntry(
            identifier: "HKQuantityTypeIdentifierDietaryWater",
            metricSlug: "water_ml",
            category: .nutrition, unit: "ml"
        ),
        TypeEntry(
            identifier: "HKQuantityTypeIdentifierDietaryCaffeine",
            metricSlug: "caffeine_mg",
            category: .nutrition, unit: "mg"
        ),

        // ── Nutrition (micros: vitamins) ──────────────────────────────
        TypeEntry(
            identifier: "HKQuantityTypeIdentifierDietaryVitaminA",
            metricSlug: "vitamin_a",
            category: .nutrition,
            unit: "mcg"
        ),
        TypeEntry(
            identifier: "HKQuantityTypeIdentifierDietaryThiamin",
            metricSlug: "vitamin_b1",
            category: .nutrition,
            unit: "mg"
        ),
        TypeEntry(
            identifier: "HKQuantityTypeIdentifierDietaryRiboflavin",
            metricSlug: "vitamin_b2",
            category: .nutrition,
            unit: "mg"
        ),
        TypeEntry(
            identifier: "HKQuantityTypeIdentifierDietaryNiacin",
            metricSlug: "vitamin_b3",
            category: .nutrition,
            unit: "mg"
        ),
        TypeEntry(
            identifier: "HKQuantityTypeIdentifierDietaryPantothenicAcid",
            metricSlug: "vitamin_b5",
            category: .nutrition,
            unit: "mg"
        ),
        TypeEntry(
            identifier: "HKQuantityTypeIdentifierDietaryVitaminB6",
            metricSlug: "vitamin_b6",
            category: .nutrition,
            unit: "mg"
        ),
        TypeEntry(
            identifier: "HKQuantityTypeIdentifierDietaryBiotin",
            metricSlug: "vitamin_b7",
            category: .nutrition,
            unit: "mcg"
        ),
        TypeEntry(
            identifier: "HKQuantityTypeIdentifierDietaryFolate",
            metricSlug: "vitamin_b9_folate",
            category: .nutrition,
            unit: "mcg"
        ),
        TypeEntry(
            identifier: "HKQuantityTypeIdentifierDietaryVitaminB12",
            metricSlug: "vitamin_b12",
            category: .nutrition,
            unit: "mcg"
        ),
        TypeEntry(
            identifier: "HKQuantityTypeIdentifierDietaryVitaminC",
            metricSlug: "vitamin_c",
            category: .nutrition,
            unit: "mg"
        ),
        TypeEntry(
            identifier: "HKQuantityTypeIdentifierDietaryVitaminD",
            metricSlug: "vitamin_d",
            category: .nutrition,
            unit: "mcg"
        ),
        TypeEntry(
            identifier: "HKQuantityTypeIdentifierDietaryVitaminE",
            metricSlug: "vitamin_e",
            category: .nutrition,
            unit: "mg"
        ),
        TypeEntry(
            identifier: "HKQuantityTypeIdentifierDietaryVitaminK",
            metricSlug: "vitamin_k",
            category: .nutrition,
            unit: "mcg"
        ),

        // ── Nutrition (micros: minerals) ──────────────────────────────
        TypeEntry(
            identifier: "HKQuantityTypeIdentifierDietaryCalcium",
            metricSlug: "calcium",
            category: .nutrition,
            unit: "mg"
        ),
        TypeEntry(
            identifier: "HKQuantityTypeIdentifierDietaryIron",
            metricSlug: "iron",
            category: .nutrition,
            unit: "mg"
        ),
        TypeEntry(
            identifier: "HKQuantityTypeIdentifierDietaryMagnesium",
            metricSlug: "magnesium",
            category: .nutrition,
            unit: "mg"
        ),
        TypeEntry(
            identifier: "HKQuantityTypeIdentifierDietaryPotassium",
            metricSlug: "potassium",
            category: .nutrition,
            unit: "mg"
        ),
        TypeEntry(
            identifier: "HKQuantityTypeIdentifierDietarySodium",
            metricSlug: "sodium",
            category: .nutrition,
            unit: "mg"
        ),
        TypeEntry(
            identifier: "HKQuantityTypeIdentifierDietaryZinc",
            metricSlug: "zinc",
            category: .nutrition,
            unit: "mg"
        ),
        TypeEntry(
            identifier: "HKQuantityTypeIdentifierDietarySelenium",
            metricSlug: "selenium",
            category: .nutrition,
            unit: "mcg"
        ),
        TypeEntry(
            identifier: "HKQuantityTypeIdentifierDietaryCopper",
            metricSlug: "copper",
            category: .nutrition,
            unit: "mg"
        ),
        TypeEntry(
            identifier: "HKQuantityTypeIdentifierDietaryManganese",
            metricSlug: "manganese",
            category: .nutrition,
            unit: "mg"
        ),
        TypeEntry(
            identifier: "HKQuantityTypeIdentifierDietaryPhosphorus",
            metricSlug: "phosphorus",
            category: .nutrition,
            unit: "mg"
        ),
        TypeEntry(
            identifier: "HKQuantityTypeIdentifierDietaryChromium",
            metricSlug: "chromium",
            category: .nutrition,
            unit: "mcg"
        ),
        TypeEntry(
            identifier: "HKQuantityTypeIdentifierDietaryMolybdenum",
            metricSlug: "molybdenum",
            category: .nutrition,
            unit: "mcg"
        ),
        TypeEntry(
            identifier: "HKQuantityTypeIdentifierDietaryIodine",
            metricSlug: "iodine",
            category: .nutrition,
            unit: "mcg"
        ),
        TypeEntry(
            identifier: "HKQuantityTypeIdentifierDietaryChloride",
            metricSlug: "chloride",
            category: .nutrition,
            unit: "mg"
        ),

        // ── Mindfulness ───────────────────────────────────────────────
        TypeEntry(
            identifier: "HKCategoryTypeIdentifierMindfulSession",
            metricSlug: "mindful_session",
            category: .mindful, valueType: .varchar, unit: nil
        ),

        // ── State of Mind (iOS 18+ Mental Wellbeing) ───────────────────
        // `HKStateOfMind` predates neither a quantity nor category type —
        // it has no HealthKit string identifier — so this mirrors the
        // `HKWorkoutTypeIdentifier` precedent above with a synthetic one.
        // Resolved to `HKObjectType.stateOfMindType()` in `sampleType`
        // below, gated to iOS 18+; on earlier OS versions `sampleType`
        // returns `nil` and the sync loop's existing skip-and-advance
        // path degrades safely (see `AppleHealthSource.sync`).
        TypeEntry(
            identifier: "HKStateOfMindTypeIdentifier",
            metricSlug: "mood",
            category: .mood, valueType: .varchar, unit: nil
        ),

        // ── Environment ──────────────────────────────────────────────
        TypeEntry(
            identifier: "HKQuantityTypeIdentifierEnvironmentalAudioExposure",
            metricSlug: "env_audio_db",
            category: .environment, unit: "dBASPL"
        ),
        TypeEntry(
            identifier: "HKQuantityTypeIdentifierHeadphoneAudioExposure",
            metricSlug: "headphone_audio_db",
            category: .environment, unit: "dBASPL"
        ),

        // ── Workouts ──────────────────────────────────────────────────
        TypeEntry(
            identifier: "HKWorkoutTypeIdentifier",
            metricSlug: "workout",
            category: .workouts, valueType: .varchar, unit: nil
        ),
    ]
}

#if canImport(HealthKit)
@available(iOS 17.0, *)
extension TypeEntry {
    /// Resolve this entry to a concrete `HKSampleType`. Returns `nil`
    /// if the identifier isn't one HealthKit knows about (should never
    /// happen for v1 but guards against typos).
    public var sampleType: HKSampleType? {
        switch identifier {
        case "HKWorkoutTypeIdentifier":
            return HKWorkoutType.workoutType()
        case "HKStateOfMindTypeIdentifier":
            // `HKStateOfMind` shipped simultaneously on iOS 18 and macOS
            // 15 — `canImport(HealthKit)` is true when building this
            // package for macOS too (the `swift test` logic lane), so
            // both platform minimums must be named or the `*` wildcard
            // treats this as unconditionally available and the call
            // fails to compile against a macOS 14 deployment target.
            if #available(iOS 18.0, macOS 15.0, *) {
                return HKObjectType.stateOfMindType()
            }
            return nil
        case let id where id.hasPrefix("HKQuantityTypeIdentifier"):
            let suffix = String(id.dropFirst("HKQuantityTypeIdentifier".count))
            let kind = HKQuantityTypeIdentifier(rawValue: "HKQuantityTypeIdentifier\(suffix)")
            return HKQuantityType.quantityType(forIdentifier: kind)
        case let id where id.hasPrefix("HKCategoryTypeIdentifier"):
            let suffix = String(id.dropFirst("HKCategoryTypeIdentifier".count))
            let kind = HKCategoryTypeIdentifier(rawValue: "HKCategoryTypeIdentifier\(suffix)")
            return HKCategoryType.categoryType(forIdentifier: kind)
        default:
            return nil
        }
    }
}

@available(iOS 17.0, *)
extension TypeCatalog {
    /// Every HealthKit type we ever want to read. Passed to
    /// `HKHealthStore.requestAuthorization(toShare:read:)`.
    public static var allSampleTypes: Set<HKSampleType> {
        Set(v1.compactMap(\.sampleType))
    }

    /// Broader set used for authorization — includes `HKObjectType`
    /// variants needed by observer queries.
    public static var allObjectTypes: Set<HKObjectType> {
        Set(allSampleTypes.map { $0 as HKObjectType })
    }

    /// Read types for the entries in `categories`: what Apple Health asks
    /// HealthKit for, so the request matches the categories that are on.
    public static func readObjectTypes(in categories: Set<HealthCategory>) -> Set<HKObjectType> {
        Set(entries(in: categories).compactMap(\.sampleType).map { $0 as HKObjectType })
    }
}
#endif
