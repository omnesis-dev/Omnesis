// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Health Connect analytics schemas — the DuckDB table shapes the `health-connect`
 * source ingests into.
 *
 * These are NATIVE to the Health Connect record model and deliberately distinct
 * from Apple Health's `health_*` tables: columns speak Health Connect vocabulary
 * (`data_origin` package names, `recording_method`, `client_record_id`, record-type
 * `metric` names), and there is no shared cross-platform schema. The Android Kotlin
 * `Schemas.kt` is the canonical definition for the real source; this TypeScript
 * transcription is the synthetic twin and the two are kept in lockstep by the
 * structured E2E (a divergence in table/column shape fails the round-trip test).
 *
 * Seven tables: four "tall" sample tables (one row per reading) plus three
 * session tables. Every schema's primary key is `["id"]` (the Health Connect
 * `metadata.id`), so re-ingest is an idempotent upsert and Changes-API deletions
 * are applied by id.
 */
import type { AnalyticsTableSchema, ColumnDefinition } from "@omnesis/source-sdk";

const METRIC_SLUGS = {
  hc_body: [
    "weight",
    "height",
    "body_fat",
    "lean_body_mass",
    "bone_mass",
    "body_water_mass",
    "basal_metabolic_rate",
  ],
  hc_activity: [
    "steps",
    "distance",
    "active_calories",
    "total_calories",
    "floors_climbed",
    "elevation_gained",
    "vo2_max",
    "wheelchair_pushes",
    "power",
    "speed",
    "steps_cadence",
    "cycling_pedaling_cadence",
  ],
  hc_vitals: [
    "heart_rate",
    "resting_heart_rate",
    "hrv",
    "blood_pressure_systolic",
    "blood_pressure_diastolic",
    "oxygen_saturation",
    "blood_glucose",
    "body_temperature",
    "respiratory_rate",
    "basal_body_temperature",
    "skin_temperature_baseline",
    "skin_temperature_delta",
  ],
  hc_nutrition: [
    "energy",
    "protein",
    "total_carbohydrate",
    "total_fat",
    "sugar",
    "dietary_fiber",
    "saturated_fat",
    "sodium",
    "cholesterol",
    "potassium",
    "caffeine",
    "hydration",
  ],
  hc_cycle: [
    "menstruation_flow",
    "menstruation_period",
    "intermenstrual_bleeding",
    "cervical_mucus",
    "ovulation_test",
    "sexual_activity",
  ],
} satisfies Record<string, string[]>;

const RECORDING_METHODS = [
  "actively_recorded",
  "automatically_recorded",
  "manually_entered",
  "unknown",
];
const DEVICE_TYPES = [
  "watch",
  "phone",
  "scale",
  "ring",
  "chest_strap",
  "fitness_band",
  "head_mounted",
  "smart_display",
  "unknown",
];
const SLEEP_STAGES = [
  "awake",
  "sleeping",
  "out_of_bed",
  "light",
  "deep",
  "rem",
  "awake_in_bed",
  "unknown",
];
const CYCLE_TEXT_VALUES = [
  "light",
  "medium",
  "heavy",
  "period",
  "bleeding",
  "positive",
  "high",
  "negative",
  "inconclusive",
  "protected",
  "unprotected",
  "unknown",
  ...["dry", "sticky", "creamy", "watery", "egg_white", "unusual", "unknown"].flatMap(
    (appearance) =>
      ["light", "medium", "heavy", "unknown"].map((sensation) => `${appearance} / ${sensation}`),
  ),
].sort();
const MINDFULNESS_TYPES = ["meditation", "breathing", "music", "movement", "unguided", "unknown"];
const EXERCISE_TYPES = [
  "other_workout",
  "badminton",
  "baseball",
  "basketball",
  "biking",
  "biking_stationary",
  "boot_camp",
  "boxing",
  "calisthenics",
  "cricket",
  "dancing",
  "elliptical",
  "exercise_class",
  "fencing",
  "football_american",
  "football_australian",
  "frisbee_disc",
  "golf",
  "guided_breathing",
  "gymnastics",
  "handball",
  "hiking",
  "hiit",
  "ice_hockey",
  "ice_skating",
  "martial_arts",
  "paddling",
  "paragliding",
  "pilates",
  "racquetball",
  "rock_climbing",
  "roller_hockey",
  "rowing",
  "rowing_machine",
  "rugby",
  "running",
  "running_treadmill",
  "sailing",
  "scuba_diving",
  "skating",
  "skiing",
  "snowboarding",
  "snowshoeing",
  "soccer",
  "softball",
  "squash",
  "stair_climbing",
  "stair_climbing_machine",
  "strength_training",
  "stretching",
  "surfing",
  "swimming_open_water",
  "swimming_pool",
  "table_tennis",
  "tennis",
  "volleyball",
  "walking",
  "water_polo",
  "weightlifting",
  "wheelchair",
  "yoga",
].sort();

const METRIC_ALIAS_OVERRIDES: Record<string, string[]> = {
  resting_heart_rate: ["resting heart rate"],
  hrv: ["heart rate variability", "hrv"],
  blood_pressure_systolic: ["systolic blood pressure"],
  blood_pressure_diastolic: ["diastolic blood pressure"],
  oxygen_saturation: ["blood oxygen", "oxygen saturation", "spo2"],
  vo2_max: ["vo2 max"],
};
// Exact phrases produced by Android `humanizeCatalogName(HealthTypeCatalog.name)`.
const METRIC_CATALOG_ALIASES: Record<string, string> = {
  weight: "weight",
  height: "height",
  body_fat: "body fat",
  lean_body_mass: "lean body mass",
  bone_mass: "bone mass",
  body_water_mass: "body water mass",
  basal_metabolic_rate: "basal metabolic rate",
  steps: "steps",
  distance: "distance",
  active_calories: "active calories burned",
  total_calories: "total calories burned",
  floors_climbed: "floors climbed",
  elevation_gained: "elevation gained",
  vo2_max: "vo2 max",
  wheelchair_pushes: "wheelchair pushes",
  power: "power",
  speed: "speed",
  steps_cadence: "steps cadence",
  cycling_pedaling_cadence: "cycling pedaling cadence",
  heart_rate: "heart rate",
  resting_heart_rate: "resting heart rate",
  hrv: "heart rate variability rmssd",
  oxygen_saturation: "oxygen saturation",
  blood_glucose: "blood glucose",
  body_temperature: "body temperature",
  respiratory_rate: "respiratory rate",
  basal_body_temperature: "basal body temperature",
  hydration: "hydration",
  menstruation_flow: "menstruation flow",
  menstruation_period: "menstruation period",
  intermenstrual_bleeding: "intermenstrual bleeding",
  cervical_mucus: "cervical mucus",
  ovulation_test: "ovulation test",
  sexual_activity: "sexual activity",
};
const SLEEP_STAGE_ALIASES: Record<string, string[]> = {
  awake: ["awake"],
  sleeping: ["sleeping"],
  out_of_bed: ["out of bed"],
  light: ["light sleep"],
  deep: ["deep sleep"],
  rem: ["rem sleep"],
  awake_in_bed: ["awake in bed"],
  unknown: ["unknown"],
};
const MINDFULNESS_ALIASES: Record<string, string[]> = {
  meditation: ["meditation"],
  breathing: ["breathing"],
  music: ["music"],
  movement: ["movement"],
  unguided: ["unguided"],
  unknown: ["unknown"],
};
const EXERCISE_ALIAS_OVERRIDES: Record<string, string[]> = {
  biking: ["bike ride", "biking", "cycling"],
  hiking: ["hike", "hiking"],
  hiit: ["high intensity interval training", "hiit"],
  rowing: ["row", "rowing"],
  running: ["run", "running"],
  running_treadmill: ["treadmill run", "treadmill running"],
  swimming_open_water: ["open water swimming"],
  swimming_pool: ["pool swimming"],
  walking: ["walk", "walking"],
};
const EXERCISE_ALIASES: Record<string, string[]> = Object.fromEntries(
  EXERCISE_TYPES.map((slug) => [
    slug,
    [...new Set([slug.replaceAll("_", " "), ...(EXERCISE_ALIAS_OVERRIDES[slug] ?? [])])].sort(),
  ]),
);

const metricAliasesFor = (tableName: keyof typeof METRIC_SLUGS): Record<string, string[]> =>
  Object.fromEntries(
    METRIC_SLUGS[tableName].map((slug) => [
      slug,
      [
        ...new Set([
          slug.replaceAll("_", " "),
          ...(METRIC_CATALOG_ALIASES[slug] ? [METRIC_CATALOG_ALIASES[slug]] : []),
          ...(METRIC_ALIAS_OVERRIDES[slug] ?? []),
        ]),
      ].sort(),
    ]),
  );

/** Shared column core for the "tall" sample tables (activity/vitals/body/nutrition). */
const hcSampleColumns = (tableName: keyof typeof METRIC_SLUGS): ColumnDefinition[] => [
  {
    name: "id",
    type: "VARCHAR",
    description:
      "Row id — the Health Connect record id, suffixed for rows fanned out from one record (heart-rate samples, blood-pressure components, per-nutrient rows)",
  },
  {
    name: "record_id",
    type: "VARCHAR",
    description:
      "Parent Health Connect record id (metadata.id). Shared by all rows fanned out from one record; the Changes-API deletion key",
  },
  {
    name: "client_record_id",
    type: "VARCHAR",
    description: "Writing app's own record id (metadata.clientRecordId)",
    nullable: true,
  },
  { name: "account_id", type: "VARCHAR", description: "Per-device identifier (android-<uuid>)" },
  {
    name: "metric",
    type: "VARCHAR",
    description: "Health Connect record type (e.g. HeartRate, Steps, Weight)",
  },
  {
    name: "metric_slug",
    type: "VARCHAR",
    description: "Machine-readable short name (e.g. heart_rate, steps)",
    allowedValues: [...METRIC_SLUGS[tableName]].sort(),
    valueAliases: metricAliasesFor(tableName),
    categoricalRole: "series",
  },
  {
    name: "value",
    type: "DOUBLE",
    description: "Numeric reading in canonical unit",
    nullable: true,
  },
  {
    name: "unit",
    type: "VARCHAR",
    description: "Canonical unit (kg, bpm, m, ...)",
    nullable: true,
  },
  { name: "start_time", type: "TIMESTAMPTZ", description: "Record start time (UTC)" },
  {
    name: "end_time",
    type: "TIMESTAMPTZ",
    description: "Record end time (UTC); equals start_time for instantaneous records",
  },
  {
    name: "data_origin",
    type: "VARCHAR",
    description: "Package name of the writing app (metadata.dataOrigin.packageName)",
    nullable: true,
  },
  {
    name: "recording_method",
    type: "VARCHAR",
    description: "actively_recorded / automatically_recorded / manually_entered / unknown",
    nullable: true,
    allowedValues: RECORDING_METHODS,
  },
  {
    name: "device_type",
    type: "VARCHAR",
    description: "Originating device type (watch, phone, scale, ring, ...)",
    nullable: true,
    allowedValues: DEVICE_TYPES,
  },
  {
    name: "last_modified_time",
    type: "TIMESTAMPTZ",
    description: "metadata.lastModifiedTime (UTC)",
    nullable: true,
  },
  {
    name: "metadata",
    type: "JSON",
    description: "Extra Health Connect fields not otherwise mapped (reserved, currently null)",
    nullable: true,
  },
];

export const HC_ACTIVITY: AnalyticsTableSchema = {
  tableName: "hc_activity",
  displayName: "Activity & Movement",
  description:
    "Steps, distance, active/total calories, floors & elevation climbed, VO2 max, wheelchair pushes, activity intensity.",
  columns: hcSampleColumns("hc_activity"),
  primaryKey: ["id"],
  // A tall table: one upstream record fans out into several rows sharing
  // `record_id`, and the upstream deletes the record, not the row.
  deleteKey: ["record_id"],
  semanticTimeColumn: "start_time",
  record: {
    titleColumns: ["metric_slug"],
    keyColumns: ["metric_slug", "value", "unit", "start_time"],
  },
  exampleQueries: [
    "SELECT date_trunc('day', start_time) AS day, SUM(value) AS steps FROM hc_activity WHERE metric_slug = 'steps' GROUP BY day ORDER BY day DESC LIMIT 14",
    "SELECT date_trunc('day', start_time) AS day, SUM(value) AS active_kcal FROM hc_activity WHERE metric_slug = 'active_calories' GROUP BY day ORDER BY day DESC LIMIT 14",
  ],
};

export const HC_VITALS: AnalyticsTableSchema = {
  tableName: "hc_vitals",
  displayName: "Vitals",
  description:
    "Heart rate, resting heart rate, HRV, blood pressure, SpO2, blood glucose, body temperature, respiratory rate.",
  columns: hcSampleColumns("hc_vitals"),
  primaryKey: ["id"],
  // A tall table: one upstream record fans out into several rows sharing
  // `record_id`, and the upstream deletes the record, not the row.
  deleteKey: ["record_id"],
  semanticTimeColumn: "start_time",
  record: {
    titleColumns: ["metric_slug"],
    keyColumns: ["metric_slug", "value", "unit", "start_time"],
  },
  exampleQueries: [
    "SELECT date_trunc('day', start_time) AS day, ROUND(AVG(value),0) AS avg_hr FROM hc_vitals WHERE metric_slug = 'heart_rate' GROUP BY day ORDER BY day DESC LIMIT 30",
  ],
};

export const HC_BODY: AnalyticsTableSchema = {
  tableName: "hc_body",
  displayName: "Body Measurements",
  description:
    "Weight, height, body fat, lean mass, bone mass, body water mass, basal metabolic rate.",
  columns: hcSampleColumns("hc_body"),
  primaryKey: ["id"],
  // A tall table: one upstream record fans out into several rows sharing
  // `record_id`, and the upstream deletes the record, not the row.
  deleteKey: ["record_id"],
  semanticTimeColumn: "start_time",
  record: {
    titleColumns: ["metric_slug"],
    keyColumns: ["metric_slug", "value", "unit", "start_time"],
  },
  exampleQueries: [
    "SELECT start_time, value FROM hc_body WHERE metric_slug = 'weight' ORDER BY start_time DESC LIMIT 30",
  ],
};

export const HC_NUTRITION: AnalyticsTableSchema = {
  tableName: "hc_nutrition",
  displayName: "Nutrition",
  description:
    "Per-nutrient intake (energy, macros, micros) and hydration, one row per nutrient reading.",
  columns: hcSampleColumns("hc_nutrition"),
  primaryKey: ["id"],
  // A tall table: one upstream record fans out into several rows sharing
  // `record_id`, and the upstream deletes the record, not the row.
  deleteKey: ["record_id"],
  semanticTimeColumn: "start_time",
  record: {
    titleColumns: ["metric_slug"],
    keyColumns: ["metric_slug", "value", "unit", "start_time"],
  },
  exampleQueries: [
    "SELECT date_trunc('day', start_time) AS day, SUM(value) AS kcal FROM hc_nutrition WHERE metric_slug = 'energy' GROUP BY day ORDER BY day DESC LIMIT 14",
  ],
};

export const HC_SLEEP: AnalyticsTableSchema = {
  tableName: "hc_sleep",
  displayName: "Sleep",
  description: "Sleep sessions broken into stages (one row per stage).",
  columns: [
    {
      name: "id",
      type: "VARCHAR",
      description: "Stage id (derived from session id + stage index)",
    },
    { name: "account_id", type: "VARCHAR", description: "Per-device identifier" },
    {
      name: "session_id",
      type: "VARCHAR",
      description: "Health Connect SleepSessionRecord id this stage belongs to",
    },
    {
      name: "stage",
      type: "VARCHAR",
      description: "awake / sleeping / out_of_bed / light / deep / rem / awake_in_bed / unknown",
      allowedValues: SLEEP_STAGES,
      valueAliases: SLEEP_STAGE_ALIASES,
      categoricalRole: "selector",
    },
    { name: "start_time", type: "TIMESTAMPTZ", description: "Stage start (UTC)" },
    { name: "end_time", type: "TIMESTAMPTZ", description: "Stage end (UTC)" },
    {
      name: "data_origin",
      type: "VARCHAR",
      description: "Package name of the writing app",
      nullable: true,
    },
    {
      name: "recording_method",
      type: "VARCHAR",
      description: "actively_recorded / automatically_recorded / manually_entered / unknown",
      nullable: true,
      allowedValues: RECORDING_METHODS,
    },
    {
      name: "device_type",
      type: "VARCHAR",
      description: "Originating device type",
      nullable: true,
      allowedValues: DEVICE_TYPES,
    },
    { name: "metadata", type: "JSON", description: "Extra fields", nullable: true },
  ],
  primaryKey: ["id"],
  // A tall table: one upstream record fans out into several rows sharing
  // `session_id`, and the upstream deletes the record, not the row.
  deleteKey: ["session_id"],
  semanticTimeColumn: "start_time",
  record: { titleColumns: ["stage"], keyColumns: ["stage", "start_time", "end_time"] },
  exampleQueries: [
    "SELECT date_trunc('day', start_time) AS night, SUM(date_diff('minute', start_time, end_time))/60.0 AS hours FROM hc_sleep WHERE stage IN ('light','deep','rem','sleeping') GROUP BY night ORDER BY night DESC LIMIT 14",
  ],
};

export const HC_MINDFULNESS: AnalyticsTableSchema = {
  tableName: "hc_mindfulness",
  displayName: "Mindfulness",
  description: "Mindfulness / meditation sessions.",
  columns: [
    { name: "id", type: "VARCHAR", description: "Health Connect record id" },
    { name: "account_id", type: "VARCHAR", description: "Per-device identifier" },
    {
      name: "session_type",
      type: "VARCHAR",
      description: "meditation / breathing / music / movement / unguided / unknown",
      canonicalValues: MINDFULNESS_TYPES,
      valueAliases: MINDFULNESS_ALIASES,
      categoricalRole: "selector",
    },
    { name: "title", type: "VARCHAR", description: "Session title", nullable: true },
    { name: "start_time", type: "TIMESTAMPTZ", description: "Session start (UTC)" },
    { name: "end_time", type: "TIMESTAMPTZ", description: "Session end (UTC)" },
    { name: "duration_seconds", type: "INTEGER", description: "Session duration" },
    {
      name: "data_origin",
      type: "VARCHAR",
      description: "Package name of the writing app",
      nullable: true,
    },
    {
      name: "recording_method",
      type: "VARCHAR",
      description: "actively_recorded / automatically_recorded / manually_entered / unknown",
      nullable: true,
      allowedValues: RECORDING_METHODS,
    },
    {
      name: "device_type",
      type: "VARCHAR",
      description: "Originating device type",
      nullable: true,
      allowedValues: DEVICE_TYPES,
    },
    { name: "metadata", type: "JSON", description: "Extra fields", nullable: true },
  ],
  primaryKey: ["id"],
  semanticTimeColumn: "start_time",
  record: {
    titleColumns: ["title", "session_type"],
    titleTemplate: "{title}",
    keyColumns: ["session_type", "start_time", "end_time", "duration_seconds"],
  },
};

export const HC_EXERCISE: AnalyticsTableSchema = {
  tableName: "hc_exercise",
  displayName: "Workouts",
  description:
    "Exercise sessions (runs, rides, swims, strength, ...). Distance and calories for a session are recorded separately in hc_activity, Health Connect's native model.",
  columns: [
    { name: "id", type: "VARCHAR", description: "Health Connect ExerciseSessionRecord id" },
    { name: "account_id", type: "VARCHAR", description: "Per-device identifier" },
    {
      name: "exercise_type",
      type: "VARCHAR",
      description: "running / biking / swimming_pool / strength_training / etc.",
      canonicalValues: EXERCISE_TYPES,
      valueAliases: EXERCISE_ALIASES,
      categoricalRole: "selector",
    },
    { name: "title", type: "VARCHAR", description: "Session title", nullable: true },
    { name: "notes", type: "VARCHAR", description: "Session notes", nullable: true },
    { name: "start_time", type: "TIMESTAMPTZ", description: "Session start (UTC)" },
    { name: "end_time", type: "TIMESTAMPTZ", description: "Session end (UTC)" },
    { name: "duration_seconds", type: "INTEGER", description: "Duration" },
    {
      name: "data_origin",
      type: "VARCHAR",
      description: "Package name of the writing app",
      nullable: true,
    },
    {
      name: "recording_method",
      type: "VARCHAR",
      description: "actively_recorded / automatically_recorded / manually_entered / unknown",
      nullable: true,
      allowedValues: RECORDING_METHODS,
    },
    {
      name: "device_type",
      type: "VARCHAR",
      description: "Originating device type",
      nullable: true,
      allowedValues: DEVICE_TYPES,
    },
    { name: "metadata", type: "JSON", description: "Extra fields", nullable: true },
  ],
  primaryKey: ["id"],
  semanticTimeColumn: "start_time",
  record: {
    titleColumns: ["title", "exercise_type"],
    titleTemplate: "{title}",
    keyColumns: ["exercise_type", "start_time", "end_time", "duration_seconds"],
  },
};

export const HC_CYCLE: AnalyticsTableSchema = {
  tableName: "hc_cycle",
  displayName: "Cycle Tracking",
  description:
    "Reproductive-health records: menstruation flow and periods, intermenstrual bleeding, cervical mucus, ovulation tests, and sexual activity. Categorical readings are stored in text_value.",
  columns: [
    { name: "id", type: "VARCHAR", description: "Health Connect record id" },
    {
      name: "record_id",
      type: "VARCHAR",
      description: "Parent Health Connect record id; the Changes-API deletion key",
    },
    { name: "account_id", type: "VARCHAR", description: "Per-device identifier" },
    {
      name: "metric",
      type: "VARCHAR",
      description: "Health Connect record type",
    },
    {
      name: "metric_slug",
      type: "VARCHAR",
      description: "Machine-readable short name",
      allowedValues: [...METRIC_SLUGS.hc_cycle].sort(),
      valueAliases: metricAliasesFor("hc_cycle"),
      categoricalRole: "series",
    },
    {
      name: "text_value",
      type: "VARCHAR",
      description: "Categorical reading for the selected record type",
      nullable: true,
      allowedValues: CYCLE_TEXT_VALUES,
      categoricalRole: "selector",
    },
    {
      name: "value",
      type: "DOUBLE",
      description: "Reserved numeric reading; null for current categorical records",
      nullable: true,
    },
    { name: "start_time", type: "TIMESTAMPTZ", description: "Record start time (UTC)" },
    {
      name: "end_time",
      type: "TIMESTAMPTZ",
      description: "Record end time (UTC)",
    },
    {
      name: "data_origin",
      type: "VARCHAR",
      description: "Package name of the writing app",
      nullable: true,
    },
    {
      name: "recording_method",
      type: "VARCHAR",
      description: "actively_recorded / automatically_recorded / manually_entered / unknown",
      nullable: true,
      allowedValues: RECORDING_METHODS,
    },
    {
      name: "device_type",
      type: "VARCHAR",
      description: "Originating device type",
      nullable: true,
      allowedValues: DEVICE_TYPES,
    },
    { name: "metadata", type: "JSON", description: "Extra fields", nullable: true },
  ],
  primaryKey: ["id"],
  exampleQueries: [
    "SELECT date_trunc('day', start_time) AS day, text_value FROM hc_cycle WHERE metric_slug = 'menstruation_flow' ORDER BY day DESC LIMIT 30",
  ],
  semanticTimeColumn: "start_time",
  record: {
    titleColumns: ["metric_slug"],
    keyColumns: ["metric_slug", "text_value", "start_time"],
  },
};

export const ALL_HEALTH_CONNECT_SCHEMAS: AnalyticsTableSchema[] = [
  HC_BODY,
  HC_ACTIVITY,
  HC_VITALS,
  HC_SLEEP,
  HC_NUTRITION,
  HC_MINDFULNESS,
  HC_EXERCISE,
  HC_CYCLE,
];
