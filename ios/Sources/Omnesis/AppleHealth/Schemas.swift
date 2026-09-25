// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation

/// AnalyticsTableSchema definitions for every DuckDB table the Apple
/// Health source publishes to the gateway. Mirrors design doc §7.3.
///
/// The iOS collector attaches the relevant schema to every
/// `/analytics/ingest` call via `SyncResult.schema` so the gateway
/// creates tables on first sight and evolves them via ALTER TABLE
/// when new columns appear in later pages.
public enum HealthSchemas {
    private static let sleepStages = [
        "inBed", "asleepUnspecified", "asleepCore", "asleepDeep", "asleepREM", "awake",
    ]

    private static let canonicalWorkoutTypes = [
        "cycling", "elliptical", "functional_strength", "hiking", "hiit", "other",
        "rowing", "running", "strength", "swimming", "unknown", "walking", "yoga",
    ]
    private static let metricAliasOverrides: [String: [String]] = [
        "body_mass": ["body mass", "weight"],
        "body_fat_pct": ["body fat percentage"],
        "lean_mass": ["lean body mass"],
        "bmi": ["body mass index"],
        "waist": ["waist circumference"],
        "steps": ["step count"],
        "distance_walk_run": ["walking and running distance", "walking running distance"],
        "distance_cycle": ["cycling distance"],
        "distance_swim": ["swimming distance"],
        "active_kcal": ["active calories", "active energy burned"],
        "basal_kcal": ["basal calories", "basal energy burned"],
        "exercise_minutes": ["exercise time"],
        "stand_minutes": ["stand time"],
        "flights": ["flights climbed"],
        "walking_asymmetry_pct": ["walking asymmetry percentage"],
        "walking_double_support_pct": ["walking double support percentage"],
        "six_minute_walk_distance": ["six minute walk test distance"],
        "walking_steadiness": ["apple walking steadiness"],
        "resting_hr": ["resting heart rate"],
        "hrv": ["heart rate variability", "hrv"],
        "bp_systolic": ["systolic blood pressure"],
        "bp_diastolic": ["diastolic blood pressure"],
        "spo2": ["blood oxygen", "oxygen saturation", "spo2"],
        "vo2max": ["vo2 max"],
        "afib_burden": ["afib burden", "atrial fibrillation burden"],
        "hr_recovery_1min": ["one minute heart rate recovery"],
        "walking_hr_avg": ["walking heart rate average"],
        "energy_kcal": ["dietary energy consumed"],
        "protein_g": ["dietary protein"],
        "carbs_g": ["dietary carbohydrates"],
        "fat_g": ["dietary fat total"],
        "sugar_g": ["dietary sugar"],
        "fiber_g": ["dietary fiber"],
        "water_ml": ["dietary water"],
        "caffeine_mg": ["dietary caffeine"],
        "vitamin_b1": ["thiamin"],
        "vitamin_b2": ["riboflavin"],
        "vitamin_b3": ["niacin"],
        "vitamin_b5": ["pantothenic acid"],
        "vitamin_b7": ["biotin"],
        "vitamin_b9_folate": ["folate"],
        "env_audio_db": ["environmental audio exposure"],
        "headphone_audio_db": ["headphone audio exposure"],
    ]
    private static let workoutAliases: [String: [String]] = [
        "cycling": ["cycle", "cycling", "bike ride"],
        "functional_strength": ["functional strength"],
        "hiking": ["hike", "hiking"],
        "hiit": ["high intensity interval training", "hiit"],
        "rowing": ["row", "rowing"],
        "running": ["run", "running"],
        "strength": ["strength training"],
        "swimming": ["swim", "swimming"],
        "walking": ["walk", "walking"],
    ]

    private static func metricAliases(tableName: String) -> [String: [String]] {
        var aliases: [String: [String]] = [:]
        for entry in TypeCatalog.v1 where entry.category.tableName == tableName {
            let identifierPhrase = humanizeHealthIdentifier(entry.identifier)
            aliases[entry.metricSlug] = Array(
                Set([
                    identifierPhrase,
                    entry.metricSlug.replacingOccurrences(of: "_", with: " "),
                ] + (metricAliasOverrides[entry.metricSlug] ?? []))
            ).sorted()
        }
        return aliases
    }

    private static func humanizeHealthIdentifier(_ identifier: String) -> String {
        let prefixes = [
            "HKQuantityTypeIdentifier",
            "HKCategoryTypeIdentifier",
            "HKCorrelationTypeIdentifier",
        ]
        let value = prefixes.first(where: identifier.hasPrefix)
            .map { String(identifier.dropFirst($0.count)) } ?? identifier
        var words = ""
        var previous: Character?
        for character in value {
            if !words.isEmpty,
               character.isUppercase,
               previous?.isLowercase == true || previous?.isNumber == true {
                words.append(" ")
            }
            words.append(character.lowercased())
            previous = character
        }
        return words
    }

    /// Tall-shape table used by body / activity / vitals / nutrition /
    /// mindful / environment — one row per sample, keyed by UUID,
    /// `metric` column says which kind.
    public static func rowPerSample(
        tableName: String,
        displayName: String,
        description: String,
        exampleQueries: [String] = []
    )
        -> AnalyticsTableSchema {
        let metricSlugs = Array(Set(
            TypeCatalog.v1
                .filter { $0.category.tableName == tableName }
                .map(\.metricSlug)
        )).sorted()
        return AnalyticsTableSchema(
            tableName: tableName,
            displayName: displayName,
            description: description,
            columns: [
                ColumnDefinition(name: "id", type: .varchar, description: "HealthKit sample UUID"),
                ColumnDefinition(name: "account_id", type: .varchar, description: "Per-iPhone identifier (ios-<uuid>)"),
                ColumnDefinition(
                    name: "metric",
                    type: .varchar,
                    description: "HealthKit identifier (e.g. HKQuantityTypeIdentifierBodyMass)"
                ),
                ColumnDefinition(
                    name: "metric_slug",
                    type: .varchar,
                    description: "Machine-readable short name (e.g. body_mass)",
                    allowedValues: metricSlugs,
                    valueAliases: metricAliases(tableName: tableName),
                    categoricalRole: "series"
                ),
                ColumnDefinition(name: "value", type: .double, description: "Numeric reading in canonical unit", nullable: true),
                ColumnDefinition(name: "unit", type: .varchar, description: "Canonical unit (kg, bpm, m, ...)", nullable: true),
                ColumnDefinition(name: "start_time", type: .timestamptz, description: "Sample start time (UTC)"),
                ColumnDefinition(name: "end_time", type: .timestamptz, description: "Sample end time (UTC)"),
                ColumnDefinition(name: "source_app", type: .varchar, description: "Bundle id of the writing app", nullable: true),
                ColumnDefinition(name: "source_device", type: .varchar, description: "Source device name", nullable: true),
                ColumnDefinition(name: "metadata", type: .json, description: "Raw HealthKit metadata dict", nullable: true),
            ],
            primaryKey: ["id"],
            exampleQueries: exampleQueries,
            semanticTimeColumn: "start_time",
            record: RecordDisplaySpec(
                titleColumns: ["metric_slug"],
                keyColumns: ["metric_slug", "value", "unit", "start_time"]
            )
        )
    }

    public static let body: AnalyticsTableSchema = rowPerSample(
        tableName: "health_body",
        displayName: "Body Composition",
        description: "Body mass, body fat, lean mass, BMI, height, waist circumference.",
        exampleQueries: [
            "SELECT metric_slug, ROUND(AVG(value),2) AS avg FROM health_body WHERE start_time >= CURRENT_DATE - INTERVAL 30 DAY GROUP BY metric_slug",
            "SELECT start_time, value FROM health_body WHERE metric_slug = 'body_mass' ORDER BY start_time DESC LIMIT 30",
        ]
    )

    public static let activity: AnalyticsTableSchema = rowPerSample(
        tableName: "health_activity",
        displayName: "Activity & Movement",
        description: "Steps, distance, calories, exercise minutes, stand time, flights climbed, VO2 max.",
        exampleQueries: [
            "SELECT date_trunc('day', start_time) AS day, SUM(value) FROM health_activity WHERE metric_slug = 'steps' GROUP BY day ORDER BY day DESC LIMIT 14",
        ]
    )

    public static let vitals: AnalyticsTableSchema = rowPerSample(
        tableName: "health_vitals",
        displayName: "Vitals",
        description: "Heart rate, HRV, blood pressure, SpO2, glucose, temperature, respiratory rate.",
        exampleQueries: [
            "SELECT date_trunc('day', start_time) AS day, ROUND(AVG(value),0) AS avg_hr FROM health_vitals WHERE metric_slug = 'heart_rate' GROUP BY day ORDER BY day DESC LIMIT 30",
        ]
    )

    public static let nutrition: AnalyticsTableSchema = rowPerSample(
        tableName: "health_nutrition",
        displayName: "Nutrition",
        description: "Macros, water, caffeine.",
        exampleQueries: [
            "SELECT date_trunc('day', start_time) AS day, SUM(value) FROM health_nutrition WHERE metric_slug = 'protein_g' GROUP BY day ORDER BY day DESC LIMIT 14",
        ]
    )

    public static let environment: AnalyticsTableSchema = rowPerSample(
        tableName: "health_environment",
        displayName: "Environmental exposure",
        description: "Ambient / headphone audio exposure.",
        exampleQueries: []
    )

    /// Specialized — sleep has stages instead of a scalar value.
    public static let sleep = AnalyticsTableSchema(
        tableName: "health_sleep",
        displayName: "Sleep",
        description: "Sleep stages as reported by Apple Watch, third-party wearables, or manual entry.",
        columns: [
            ColumnDefinition(name: "id", type: .varchar, description: "HealthKit sample UUID"),
            ColumnDefinition(name: "account_id", type: .varchar, description: "Per-iPhone identifier"),
            ColumnDefinition(
                name: "stage",
                type: .varchar,
                description: "inBed / asleepUnspecified / asleepCore / asleepDeep / asleepREM / awake",
                allowedValues: sleepStages,
                valueAliases: [
                    "inBed": ["in bed"],
                    "asleepUnspecified": ["unspecified sleep"],
                    "asleepCore": ["core sleep"],
                    "asleepDeep": ["deep sleep"],
                    "asleepREM": ["rem", "rem sleep"],
                    "awake": ["awake"],
                ],
                categoricalRole: "selector"
            ),
            ColumnDefinition(name: "start_time", type: .timestamptz, description: "Stage start (UTC)"),
            ColumnDefinition(name: "end_time", type: .timestamptz, description: "Stage end (UTC)"),
            ColumnDefinition(name: "source_app", type: .varchar, description: "Writing app bundle id", nullable: true),
            ColumnDefinition(name: "source_device", type: .varchar, description: "Source device", nullable: true),
            ColumnDefinition(name: "metadata", type: .json, description: "Raw HealthKit metadata", nullable: true),
        ],
        primaryKey: ["id"],
        exampleQueries: [
            "SELECT date_trunc('day', start_time) AS night, SUM(date_diff('minute', start_time, end_time))/60.0 AS hours FROM health_sleep WHERE stage IN ('asleepCore','asleepDeep','asleepREM','asleepUnspecified') GROUP BY night ORDER BY night DESC LIMIT 14",
        ],
        semanticTimeColumn: "start_time",
        record: RecordDisplaySpec(titleColumns: ["stage"], keyColumns: ["stage", "start_time", "end_time"])
    )

    /// Specialized — mindfulness is just session intervals, no value.
    public static let mindful = AnalyticsTableSchema(
        tableName: "health_mindful",
        displayName: "Mindful Minutes",
        description: "Mindfulness / meditation sessions.",
        columns: [
            ColumnDefinition(name: "id", type: .varchar, description: "HealthKit sample UUID"),
            ColumnDefinition(name: "account_id", type: .varchar, description: "Per-iPhone identifier"),
            ColumnDefinition(name: "start_time", type: .timestamptz, description: "Session start (UTC)"),
            ColumnDefinition(name: "end_time", type: .timestamptz, description: "Session end (UTC)"),
            ColumnDefinition(name: "duration_seconds", type: .integer, description: "Session duration"),
            ColumnDefinition(name: "source_app", type: .varchar, description: "Writing app bundle id", nullable: true),
            ColumnDefinition(name: "source_device", type: .varchar, description: "Source device", nullable: true),
            ColumnDefinition(name: "metadata", type: .json, description: "Raw HealthKit metadata", nullable: true),
        ],
        primaryKey: ["id"],
        semanticTimeColumn: "start_time",
        record: RecordDisplaySpec(
            titleColumns: ["start_time"],
            titleTemplate: "Mindful session",
            keyColumns: ["start_time", "end_time", "duration_seconds"]
        ),
        // Each mindful session also mints a searchable summary document
        // whose externalId == this row's id — declare the 1:1 doc↔row
        // same-entity edge (#640).
        boundDocument: BoundDocumentSpec(externalIdColumns: ["id"])
    )

    /// Specialized — workouts record duration + distance + kcal as
    /// first-class columns, joinable to future route / HR streams.
    public static let workouts = AnalyticsTableSchema(
        tableName: "health_workouts",
        displayName: "Workouts",
        description: "Runs, rides, swims, strength sessions, and anything else logged as an HKWorkout.",
        columns: [
            ColumnDefinition(name: "id", type: .varchar, description: "HKWorkout UUID"),
            ColumnDefinition(name: "account_id", type: .varchar, description: "Per-iPhone identifier"),
            ColumnDefinition(
                name: "workout_type",
                type: .varchar,
                description: "running / cycling / swimming / hiking / etc.",
                canonicalValues: canonicalWorkoutTypes,
                valueAliases: workoutAliases,
                categoricalRole: "selector"
            ),
            ColumnDefinition(name: "start_time", type: .timestamptz, description: "Workout start (UTC)"),
            ColumnDefinition(name: "end_time", type: .timestamptz, description: "Workout end (UTC)"),
            ColumnDefinition(name: "duration_seconds", type: .integer, description: "Duration"),
            ColumnDefinition(name: "total_distance_m", type: .double, description: "Distance in meters", nullable: true),
            ColumnDefinition(name: "total_energy_kcal", type: .double, description: "Active kilocalories", nullable: true),
            ColumnDefinition(name: "source_app", type: .varchar, description: "Writing app bundle id", nullable: true),
            ColumnDefinition(name: "source_device", type: .varchar, description: "Source device", nullable: true),
            ColumnDefinition(name: "metadata", type: .json, description: "Raw HealthKit metadata", nullable: true),
        ],
        primaryKey: ["id"],
        semanticTimeColumn: "start_time",
        record: RecordDisplaySpec(
            titleColumns: ["workout_type"],
            keyColumns: ["workout_type", "start_time", "duration_seconds", "total_distance_m"]
        ),
        // Each workout also mints a searchable summary document whose
        // externalId == this row's id — declare the 1:1 doc↔row
        // same-entity edge (#640).
        boundDocument: BoundDocumentSpec(externalIdColumns: ["id"])
    )

    /// Specialized — mood carries structured, non-numeric fields (kind,
    /// valence, labels, associations) instead of a scalar value.
    public static let mood = AnalyticsTableSchema(
        tableName: "health_mood",
        displayName: "State of Mind",
        description: "Momentary emotions and daily mood reflections logged in Apple Health's Mental Wellbeing feature.",
        columns: [
            ColumnDefinition(name: "id", type: .varchar, description: "HealthKit sample UUID"),
            ColumnDefinition(name: "account_id", type: .varchar, description: "Per-iPhone identifier"),
            ColumnDefinition(
                name: "kind",
                type: .varchar,
                description: "momentaryEmotion (in-the-moment) or dailyMood (reflection on the day)",
                allowedValues: ["momentaryEmotion", "dailyMood", "unknown"],
                valueAliases: [
                    "momentaryEmotion": ["momentary emotion"],
                    "dailyMood": ["daily mood"],
                    "unknown": ["unknown"],
                ],
                categoricalRole: "selector"
            ),
            ColumnDefinition(
                name: "valence",
                type: .double,
                description: "Self-reported pleasantness, -1 (very unpleasant) to +1 (very pleasant)"
            ),
            ColumnDefinition(name: "labels", type: .varcharArray, description: "Felt-experience descriptors (e.g. happy, anxious)"),
            ColumnDefinition(name: "associations", type: .varcharArray, description: "Life-context associations (e.g. work, family)"),
            ColumnDefinition(name: "start_time", type: .timestamptz, description: "Log time (UTC)"),
            ColumnDefinition(
                name: "end_time",
                type: .timestamptz,
                description: "Log time (UTC); equal to start_time for a point-in-time log"
            ),
            ColumnDefinition(name: "source_app", type: .varchar, description: "Bundle id of the writing app", nullable: true),
        ],
        primaryKey: ["id"],
        exampleQueries: [
            "SELECT date_trunc('day', start_time) AS day, ROUND(AVG(valence),2) AS avg_valence "
                + "FROM health_mood GROUP BY day ORDER BY day DESC LIMIT 30",
        ],
        semanticTimeColumn: "start_time",
        record: RecordDisplaySpec(titleColumns: ["kind"], keyColumns: ["kind", "valence", "start_time"]),
        // Each mood log also mints a searchable summary document whose
        // externalId == this row's id — declare the 1:1 doc↔row
        // same-entity edge (#640), same as workouts / mindful sessions.
        boundDocument: BoundDocumentSpec(externalIdColumns: ["id"])
    )

    /// Lookup by category — SampleReader calls this to attach schema to
    /// each `/analytics/ingest` batch.
    public static func schema(for category: HealthCategory) -> AnalyticsTableSchema {
        switch category {
        case .body: body
        case .activity: activity
        case .vitals: vitals
        case .sleep: sleep
        case .nutrition: nutrition
        case .mindful: mindful
        case .environment: environment
        case .workouts: workouts
        case .mood: mood
        }
    }

    /// Every schema, for bulk declaration (e.g. when iOS first registers
    /// the source) and for tests that want full coverage.
    public static let all: [AnalyticsTableSchema] = [
        body, activity, vitals, sleep, nutrition, mindful, environment, workouts, mood,
    ]
}
