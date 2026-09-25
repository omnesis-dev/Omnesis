// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

@testable import Omnesis
import XCTest

final class TypeCatalogTests: XCTestCase {
    func testCatalogIsNonEmpty() {
        XCTAssertGreaterThan(TypeCatalog.v1.count, 30)
    }

    func testEveryCategoryCovered() {
        let categories = Set(TypeCatalog.v1.map(\.category))
        XCTAssertTrue(categories.contains(.body))
        XCTAssertTrue(categories.contains(.activity))
        XCTAssertTrue(categories.contains(.vitals))
        XCTAssertTrue(categories.contains(.sleep))
        XCTAssertTrue(categories.contains(.nutrition))
        XCTAssertTrue(categories.contains(.mindful))
        XCTAssertTrue(categories.contains(.environment))
        XCTAssertTrue(categories.contains(.workouts))
        XCTAssertTrue(categories.contains(.mood))
    }

    func testIdentifiersAreUnique() {
        let ids = TypeCatalog.v1.map(\.identifier)
        XCTAssertEqual(ids.count, Set(ids).count, "Duplicate identifier in catalog")
    }

    func testMetricSlugsAreUnique() {
        let slugs = TypeCatalog.v1.map(\.metricSlug)
        XCTAssertEqual(slugs.count, Set(slugs).count, "Duplicate metric_slug in catalog")
    }

    func testBodyMassLookup() {
        let entry = TypeCatalog.entry(for: "HKQuantityTypeIdentifierBodyMass")
        XCTAssertNotNil(entry)
        XCTAssertEqual(entry?.metricSlug, "body_mass")
        XCTAssertEqual(entry?.category, .body)
        XCTAssertEqual(entry?.unit, "kg")
    }

    func testUnknownIdentifierReturnsNil() {
        XCTAssertNil(TypeCatalog.entry(for: "HKQuantityTypeIdentifierDoesNotExist"))
    }

    // MARK: - Expanded coverage

    /// Assert that each `identifier → (slug, unit)` entry resolves to a
    /// catalog row in the expected category. Keyed by identifier (a dict)
    /// so the expectation value stays a 2-member tuple.
    private func assertCatalogEntries(
        _ expected: [String: (slug: String, unit: String)],
        category: HealthCategory,
        file: StaticString = #filePath,
        line: UInt = #line
    ) {
        for (identifier, want) in expected {
            let entry = TypeCatalog.entry(for: identifier)
            XCTAssertNotNil(entry, "Missing catalog entry \(identifier)", file: file, line: line)
            XCTAssertEqual(entry?.metricSlug, want.slug, file: file, line: line)
            XCTAssertEqual(entry?.category, category, file: file, line: line)
            XCTAssertEqual(entry?.unit, want.unit, file: file, line: line)
        }
    }

    /// Every nutrition micro (vitamins + minerals) in the expanded set must be
    /// present, land in the `nutrition` category, and carry a mass unit.
    func testNutritionMicrosPresent() {
        assertCatalogEntries(
            [
                "HKQuantityTypeIdentifierDietaryVitaminA": ("vitamin_a", "mcg"),
                "HKQuantityTypeIdentifierDietaryThiamin": ("vitamin_b1", "mg"),
                "HKQuantityTypeIdentifierDietaryRiboflavin": ("vitamin_b2", "mg"),
                "HKQuantityTypeIdentifierDietaryNiacin": ("vitamin_b3", "mg"),
                "HKQuantityTypeIdentifierDietaryPantothenicAcid": ("vitamin_b5", "mg"),
                "HKQuantityTypeIdentifierDietaryVitaminB6": ("vitamin_b6", "mg"),
                "HKQuantityTypeIdentifierDietaryBiotin": ("vitamin_b7", "mcg"),
                "HKQuantityTypeIdentifierDietaryFolate": ("vitamin_b9_folate", "mcg"),
                "HKQuantityTypeIdentifierDietaryVitaminB12": ("vitamin_b12", "mcg"),
                "HKQuantityTypeIdentifierDietaryVitaminC": ("vitamin_c", "mg"),
                "HKQuantityTypeIdentifierDietaryVitaminD": ("vitamin_d", "mcg"),
                "HKQuantityTypeIdentifierDietaryVitaminE": ("vitamin_e", "mg"),
                "HKQuantityTypeIdentifierDietaryVitaminK": ("vitamin_k", "mcg"),
                "HKQuantityTypeIdentifierDietaryCalcium": ("calcium", "mg"),
                "HKQuantityTypeIdentifierDietaryIron": ("iron", "mg"),
                "HKQuantityTypeIdentifierDietaryMagnesium": ("magnesium", "mg"),
                "HKQuantityTypeIdentifierDietaryPotassium": ("potassium", "mg"),
                "HKQuantityTypeIdentifierDietarySodium": ("sodium", "mg"),
                "HKQuantityTypeIdentifierDietaryZinc": ("zinc", "mg"),
                "HKQuantityTypeIdentifierDietarySelenium": ("selenium", "mcg"),
                "HKQuantityTypeIdentifierDietaryCopper": ("copper", "mg"),
                "HKQuantityTypeIdentifierDietaryManganese": ("manganese", "mg"),
                "HKQuantityTypeIdentifierDietaryPhosphorus": ("phosphorus", "mg"),
                "HKQuantityTypeIdentifierDietaryChromium": ("chromium", "mcg"),
                "HKQuantityTypeIdentifierDietaryMolybdenum": ("molybdenum", "mcg"),
                "HKQuantityTypeIdentifierDietaryIodine": ("iodine", "mcg"),
                "HKQuantityTypeIdentifierDietaryChloride": ("chloride", "mg"),
            ],
            category: .nutrition
        )
    }

    /// Mobility / gait quantities in the expanded set fold into `activity`.
    func testMobilityMetricsPresent() {
        assertCatalogEntries(
            [
                "HKQuantityTypeIdentifierWalkingSpeed": ("walking_speed", "m/s"),
                "HKQuantityTypeIdentifierWalkingStepLength": ("walking_step_length", "cm"),
                "HKQuantityTypeIdentifierWalkingAsymmetryPercentage":
                    ("walking_asymmetry_pct", "%"),
                "HKQuantityTypeIdentifierWalkingDoubleSupportPercentage":
                    ("walking_double_support_pct", "%"),
                "HKQuantityTypeIdentifierStairAscentSpeed": ("stair_ascent_speed", "m/s"),
                "HKQuantityTypeIdentifierStairDescentSpeed": ("stair_descent_speed", "m/s"),
                "HKQuantityTypeIdentifierSixMinuteWalkTestDistance":
                    ("six_minute_walk_distance", "m"),
                "HKQuantityTypeIdentifierAppleWalkingSteadiness": ("walking_steadiness", "%"),
            ],
            category: .activity
        )
    }

    /// Cardio quantities in the expanded set fold into `vitals`.
    func testCardioMetricsPresent() {
        assertCatalogEntries(
            [
                "HKQuantityTypeIdentifierAtrialFibrillationBurden": ("afib_burden", "%"),
                "HKQuantityTypeIdentifierHeartRateRecoveryOneMinute": ("hr_recovery_1min", "bpm"),
                "HKQuantityTypeIdentifierWalkingHeartRateAverage": ("walking_hr_avg", "bpm"),
            ],
            category: .vitals
        )
    }

    /// Every quantity entry must carry a unit string that `HKSampleExtractor`
    /// knows how to convert — a catalog row with an unmapped unit would
    /// silently fall through to `.count()` on device. This pins the catalog
    /// to the set of units the extractor actually supports, so adding a row
    /// with a new unit forces adding the matching conversion.
    func testEveryQuantityUnitIsSupported() {
        let supportedUnits: Set = [
            "kg", "cm", "m", "%", "bpm", "mmHg", "mg/dL", "°C", "breaths/min",
            "kcal", "min", "ml", "g", "mg", "mcg", "count", "ml/kg·min", "ms",
            "dBASPL", "m/s", "",
        ]
        for entry in TypeCatalog.v1 {
            // Sleep / mindful / workout rows have no scalar unit.
            guard let unit = entry.unit else { continue }
            XCTAssertTrue(
                supportedUnits.contains(unit),
                "Catalog entry \(entry.identifier) uses unmapped unit '\(unit)' — add it to HKSampleExtractor.canonicalUnit"
            )
        }
    }

    /// Pin per-category counts so an accidental row removal is caught.
    func testCategoryCounts() {
        func count(_ category: HealthCategory) -> Int {
            TypeCatalog.v1.filter { $0.category == category }.count
        }
        XCTAssertEqual(count(.body), 6)
        XCTAssertEqual(count(.activity), 18) // 10 base + 8 mobility
        XCTAssertEqual(count(.vitals), 12) // 9 base + 3 cardio
        XCTAssertEqual(count(.nutrition), 35) // 8 macros + 27 micros
        XCTAssertEqual(count(.sleep), 1)
        XCTAssertEqual(count(.mindful), 1)
        XCTAssertEqual(count(.environment), 2)
        XCTAssertEqual(count(.workouts), 1)
        XCTAssertEqual(count(.mood), 1)
    }

    // MARK: - State of Mind (mood)

    func testStateOfMindCatalogEntry() {
        let entry = TypeCatalog.entry(for: "HKStateOfMindTypeIdentifier")
        XCTAssertNotNil(entry)
        XCTAssertEqual(entry?.metricSlug, "mood")
        XCTAssertEqual(entry?.category, .mood)
        XCTAssertNil(entry?.unit, "mood has no scalar unit — structured fields only")
    }
}
