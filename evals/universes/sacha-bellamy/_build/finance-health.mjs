// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { addDays, at, jitter, mail, calendar, londonAt } from "./shared.mjs";

export function buildFinanceHealth(ctx) {
  const sources = {};
  const put = (id, file, data) => {
    sources[id] ??= {};
    sources[id][file] = data;
  };
  const day = ctx.day;
  const clock = { snapshotDay: ctx.asOf, syncedAt: londonAt(ctx.asOf, "00:00") };
  for (const id of ["lunchflow-accounts", "enable-banking-accounts", "coinbase"])
    put(id, "clock.json", clock);
  const minorUnits = (amount) => Math.round(Number(amount) * 100);
  const totalMinorUnits = (rows, amount) =>
    rows.reduce((sum, row) => sum + minorUnits(amount(row)), 0);
  const merchants = [
    "Bramble Basket",
    "Paper Finch Books",
    "Mosslight Coffee",
    "Copper Ferry Transit",
    "Willow Pantry",
    "Hazel Homewares",
    "Meadow Cycle Repairs",
    "Lantern Films",
    "Pinecone Produce",
    "Pebble Stationery",
    "Elm Table Kitchen",
    "Kestrel Sports",
  ];
  const tx = [];
  const transaction = (id, date, amount, merchant, description) => ({
    id,
    accountId: 901,
    amount,
    currency: "GBP",
    date,
    merchant,
    description,
    isPending: false,
  });
  const firstBankDay = "2021-10-24";
  const coveredDays = Math.round(
    (Date.parse(at(ctx.monday)) - Date.parse(at(firstBankDay))) / 86400000,
  );
  for (let i = 0; i < coveredDays; i++) {
    const date = addDays(firstBankDay, i);
    for (let j = 0; j < 3; j++) {
      const n = jitter(`bank-${i}-${j}`, merchants.length),
        cents = 200 + jitter(`amount-${i}-${j}`, 3500);
      tx.push(
        transaction(
          `sb-bg-gbp-${i}-${j}`,
          date,
          -cents / 100,
          merchants[n],
          `${["Groceries and household supplies", "Lunch and travel", "Personal leisure purchase"][j]} — card purchase`,
        ),
      );
    }
    if (date.endsWith("-25"))
      tx.push(
        transaction(
          `sb-payroll-${date}`,
          date,
          3850,
          "Harbour Lantern Software",
          "Monthly salary payroll",
        ),
      );
    if (date.endsWith("-01"))
      tx.push(
        transaction(
          `sb-rent-${date}`,
          date,
          -1350,
          date < "2023-04-22" ? "Example Street Housing" : "Fictional Gardens Housing",
          "Monthly rent contribution",
        ),
      );
    if (date.endsWith("-18"))
      tx.push(
        transaction(
          `sb-stream-${date}`,
          date,
          -9.99,
          "Lantern Films",
          "Monthly streaming membership",
        ),
      );
  }
  const tripEntries = [
    [
      "rail",
      "2025-04-02",
      -260,
      "Cobalt Rail Travel",
      "FR-250501 and FR-250508 two return tickets",
    ],
    [
      "car",
      "2025-04-03",
      -140,
      "Willow Wheels Rental",
      "CAR-250502 EUR 160.00 billed as GBP 140.00; bank booked conversion",
    ],
    ["hotel-old", "2025-04-04", -90, "Moss Harbour Stays", "STAY-OLD duplicate room cancelled"],
    ["hotel-final", "2025-04-16", -530, "Moss Harbour Stays", "STAY-250501 final three stays"],
    [
      "food",
      "2025-05-06",
      -150,
      "Brittany Table Collective",
      "France shared meals; EUR 171.00 billed as GBP 150.00",
    ],
    [
      "transit",
      "2025-05-07",
      -50,
      "Cobalt Rail Travel",
      "France local rail; EUR 57.00 billed as GBP 50.00",
    ],
    ["refund", "2025-04-18", 90, "Moss Harbour Stays", "STAY-OLD cancelled booking refund"],
    ["split", "2025-05-12", 565, "Maya Bellamy", "FRANCE-SPLIT reimbursement, not income"],
  ];
  for (const [id, date, amount, merchant, description] of tripEntries)
    tx.push(transaction(`sb-txn-trip-${id}`, date, amount, merchant, description));
  tx.push(
    transaction(
      "sb-txn-pottery",
      "2022-06-12",
      -120,
      "Willow Kiln Studio",
      "WK-220716 two pottery workshop places",
    ),
    transaction(
      "sb-txn-theatre",
      "2023-08-20",
      -68,
      "The Lantern Room",
      "LR-230908 two theatre tickets",
    ),
  );
  tx.push(
    transaction(
      "sb-txn-machine",
      day(-91),
      -249,
      "Willow Appliance Cooperative",
      "WA-8842 Ember Mini espresso machine EM-SB-8842",
    ),
  );
  tx.push(
    transaction(
      "sb-txn-climbing",
      day(-45),
      -84,
      "ROCKLIGHT LEARNING",
      "Course RC-8400 purchase; subsequently cancelled",
    ),
  );
  tx.push(
    transaction(
      "sb-txn-refund-control",
      day(-15),
      18,
      "Paper Finch Books",
      "BOOK-1818 refund posted",
    ),
  );
  const savings = Array.from({ length: 36 }, (_, i) => ({
    id: `sb-saving-${i}`,
    accountId: 902,
    amount: 200,
    currency: "GBP",
    date: day(-1080 + i * 30),
    description: `Own-account transfer SAVE-${i} from Lantern Current`,
    isPending: false,
  }));
  for (const transfer of savings)
    tx.push(
      transaction(
        `sb-saving-debit-${transfer.id}`,
        transfer.date,
        -transfer.amount,
        "Rainy Day Reserve",
        transfer.description,
      ),
    );
  tx.sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id));
  put("lunchflow-accounts", "accounts.json", [
    {
      id: 901,
      name: "Lantern Current ending 0042",
      institution_name: "Lantern Current",
      provider: "synthetic",
      currency: "GBP",
      status: "ACTIVE",
    },
    {
      id: 902,
      name: "Rainy Day Reserve",
      institution_name: "Lantern Current",
      provider: "synthetic",
      currency: "GBP",
      status: "ACTIVE",
    },
  ]);
  put("lunchflow-accounts", "balances.json", [
    {
      account_id: 901,
      balance: {
        amount: (500000 + totalMinorUnits(tx, (row) => row.amount)) / 100,
        currency: "GBP",
      },
    },
    {
      account_id: 902,
      balance: {
        amount: (170000 + totalMinorUnits(savings, (row) => row.amount)) / 100,
        currency: "GBP",
      },
    },
  ]);
  put("lunchflow-accounts", "transactions.json", [
    { account_id: 901, transactions: tx },
    {
      account_id: 902,
      transactions: savings,
    },
  ]);

  const eurTx = Array.from({ length: 700 }, (_, i) => ({
    entry_reference: `sb-eur-${i}`,
    booking_date: day(-1400 + i * 2),
    value_date: day(-1400 + i * 2),
    transaction_amount: {
      currency: "EUR",
      amount: (1 + jitter(`eur-${i}`, 950) / 100).toFixed(2),
    },
    credit_debit_indicator: "DBIT",
    status: "BOOK",
    creditor: {
      name: ["Juniper Digital Guides", "Willow Online Craft Store", "Birch Ebook Library"][i % 3],
    },
    remittance_information: [
      "Online EUR purchase; unrelated to May 2025 holiday; not evidence of travel",
    ],
  }));
  put("enable-banking-accounts", "accounts.json", [
    {
      account_key: "sb-eur-main",
      uid: "sb-eur-session",
      currency: "EUR",
      name: "Family travel reserve",
      cash_account_type: "CACC",
      product: "Synthetic EUR current account",
    },
  ]);
  put("enable-banking-accounts", "balances.json", [
    {
      account_key: "sb-eur-main",
      balances: [
        {
          name: "Closing booked",
          balance_type: "CLBD",
          balance_amount: {
            currency: "EUR",
            amount: (
              (500000 - totalMinorUnits(eurTx, (row) => row.transaction_amount.amount)) /
              100
            ).toFixed(2),
          },
          reference_date: ctx.asOf,
        },
      ],
    },
  ]);
  put("enable-banking-accounts", "transactions.json", [
    { account_key: "sb-eur-main", transactions: eurTx },
  ]);

  const plaidTx = Array.from({ length: 350 }, (_, i) => ({
    transaction_id: `sb-us-${i}`,
    account_id: "sb-boa-checking",
    amount: 3 + jitter(`us-${i}`, 900) / 100,
    iso_currency_code: "USD",
    date: day(-1700 + i * 4),
    name: ["Copper Trail Ebooks", "Pine Wharf Digital Patterns", "Cedar Cloud Hosting"][i % 3],
    merchant_name: ["Copper Trail Ebooks", "Pine Wharf Digital Patterns", "Cedar Cloud Hosting"][
      i % 3
    ],
    pending: false,
    personal_finance_category: { primary: "GENERAL_MERCHANDISE" },
  }));
  const usdClosing = (350000 - totalMinorUnits(plaidTx, (row) => row.amount)) / 100;
  put("plaid", "responses.json", {
    institutionName: "Bank of America",
    snapshotDay: ctx.asOf,
    transactionsSyncPages: [
      {
        added: plaidTx,
        modified: [],
        removed: [],
        next_cursor: "sb-plaid-initial-complete",
        has_more: false,
      },
    ],
    accountsGet: {
      accounts: [
        {
          account_id: "sb-boa-checking",
          name: "Retained US checking",
          type: "depository",
          subtype: "checking",
          mask: "0088",
          balances: {
            available: usdClosing,
            current: usdClosing,
            limit: null,
            iso_currency_code: "USD",
          },
        },
      ],
    },
    investmentsHoldingsGet: { holdings: [], securities: [] },
    itemGet: {
      item: {
        item_id: "plaid-bellamy-us",
        institution_id: "ins_3",
        available_products: ["transactions"],
        billed_products: ["transactions"],
      },
    },
  });
  put("coinbase", "responses.json", {
    accountsPages: [
      {
        accounts: [
          {
            uuid: "sb-crypto-usd",
            currency: "USD",
            type: "ACCOUNT_TYPE_FIAT",
            available_balance: { value: "120.00", currency: "USD" },
            hold: { value: "0", currency: "USD" },
          },
        ],
        has_next: false,
      },
    ],
    portfolios: {
      portfolios: [
        {
          uuid: "sb-small-portfolio",
          name: "Small experimental portfolio",
          type: "DEFAULT",
          deleted: false,
        },
      ],
    },
    breakdowns: {
      "sb-small-portfolio": {
        breakdown: {
          spot_positions: [
            {
              asset: "USD",
              is_cash: true,
              total_balance_crypto: 120,
              available_to_trade_crypto: 120,
              cost_basis: { value: "120", currency: "USD" },
              total_balance_fiat: 120,
              allocation: 1,
              account_uuid: "sb-crypto-usd",
            },
          ],
        },
      },
    },
    ordersPages: [{ orders: [], has_next: false }],
    fillsPages: [{ fills: [], has_next: false }],
    v2AccountsPages: [{ data: [], pagination: { next_starting_after: null } }],
    v2TransactionsPages: {},
    v2Grant: false,
  });
  put("apple-notes", "notes.json", [
    {
      externalId: "sb-bank-coverage",
      title: "Connected account coverage for personal reconciliation",
      body: `Lantern Current transactions exported through ${day(-1)}. Opening GBP balances immediately before ${tx[0].date}: Lantern Current £5000; Rainy Day Reserve £1700. All posted card credits and debits between ${tx[0].date} and ${day(-1)} are included. UK day-to-day payments use Lantern Current ending 0042. Retained Bank of America USD account opened during summer 2019 US placement. Its exported interval begins ${plaidTx[0].date}, with USD 3500 immediately before that date; covered purchases are online ebooks, digital patterns and hosting, not evidence of US presence. EUR reserve export begins ${eurTx[0].booking_date}, with EUR 5000 immediately before that date; covered purchases are online digital guides, craft orders and ebooks, not evidence of foreign presence. Earlier funding history is outside these exports. Coinbase shows a separate USD 120 cash snapshot; no crypto trade or deposit history is granted. EUR reserve is separate; own-account transfers and reimbursements are not income. Cash spending is not tracked. The RC-8400 refund was promised to Lantern Current, not another account.`,
      folder: "Finance",
      createdAt: londonAt(day(0), "00:00"),
      modifiedAt: londonAt(day(0), "00:00"),
    },
  ]);

  const count = 730,
    startDay = day(-730);
  const series = (slug, base, range) =>
    Array.from(
      { length: count },
      (_, i) =>
        Math.round((base + (jitter(`health-${slug}-${i}`, range * 20) - range * 10) / 10) * 10) /
        10,
    );
  const metric = (metric, slug, unit, values) => ({ metric, slug, unit, values });
  const sleep = Array.from({ length: count }, (_, i) => {
    const date = addDays(startDay, i),
      inRecent = date >= day(-15),
      minutes = inRecent ? 360 : date >= day(-29) ? 450 : 420 + jitter(`sleep-${i}`, 61);
    return {
      nightOf: date,
      stages: [
        ["asleepCore", 0, minutes - 150],
        ["asleepREM", minutes - 150, 90],
        ["asleepDeep", minutes - 60, 60],
        ["awake", minutes, inRecent ? 75 : 20],
      ],
    };
  });
  const health = {
    accountId: "ios-sacha-bellamy",
    device: "Apple Watch",
    sourceApp: "com.apple.Health",
    startDay,
    body: [
      metric("HKQuantityTypeIdentifierBodyMass", "body_mass", "kg", series("mass", 74, 2)),
      metric(
        "HKQuantityTypeIdentifierBodyFatPercentage",
        "body_fat_pct",
        "%",
        series("fat", 18, 2),
      ),
      metric("HKQuantityTypeIdentifierBodyMassIndex", "bmi", "", series("bmi", 23, 1)),
    ],
    activity: [
      metric("HKQuantityTypeIdentifierStepCount", "steps", "count", series("steps", 9500, 2500)),
      metric(
        "HKQuantityTypeIdentifierDistanceWalkingRunning",
        "distance_walk_run",
        "m",
        series("distance", 6500, 2000),
      ),
      metric(
        "HKQuantityTypeIdentifierActiveEnergyBurned",
        "active_kcal",
        "kcal",
        series("energy", 480, 200),
      ),
      metric(
        "HKQuantityTypeIdentifierAppleExerciseTime",
        "exercise_minutes",
        "min",
        series("exercise", 40, 20),
      ),
      metric("HKQuantityTypeIdentifierVO2Max", "vo2max", "ml/kg·min", series("vo2", 46, 2)),
    ],
    vitals: [
      metric(
        "HKQuantityTypeIdentifierRestingHeartRate",
        "resting_heart_rate",
        "count/min",
        series("rhr", 58, 4),
      ),
      metric(
        "HKQuantityTypeIdentifierHeartRateVariabilitySDNN",
        "hrv",
        "ms",
        series("hrv", 51, 10),
      ),
      metric(
        "HKQuantityTypeIdentifierHeartRate",
        "heart_rate",
        "count/min",
        Array.from(
          { length: count * 4 },
          (_, i) => [62, 75, 110, 65][i % 4] + jitter(`hr-${i}`, 12),
        ),
      ),
    ],
    nutrition: [
      metric("HKQuantityTypeIdentifierDietaryWater", "water", "ml", series("water", 2100, 300)),
    ],
    environment: [
      metric(
        "HKQuantityTypeIdentifierEnvironmentalAudioExposure",
        "environment_audio_db",
        "dBASPL",
        series("audio", 58, 8),
      ),
    ],
    sleep,
    mindful: Array.from({ length: 180 }, (_, i) => ({
      dateOf: day(-540 + i * 3),
      startHour: 18,
      durationMin: 10,
    })),
    workouts: Array.from({ length: 210 }, (_, i) => ({
      type: "running",
      dateOf: day(-630 + i * 3),
      startHour: 7,
      durationMin: 25,
      distanceM: 4000,
      energyKcal: 280,
    })),
    moods: Array.from({ length: 120 }, (_, i) => ({
      kind: "dailyMood",
      valence: 0.2 + jitter(`mood-${i}`, 50) / 100,
      labels: ["Calm"],
      associations: ["Exercise"],
      date: day(-360 + i * 3),
      hour: 20,
    })),
  };
  for (const offset of [-15, -13, -11, -9, -7, -5, -3])
    health.workouts.push({
      type: "running",
      dateOf: day(offset),
      startHour: new Date(londonAt(day(offset), "21:00")).getUTCHours(),
      durationMin: 65,
      distanceM: 11000,
      energyKcal: 710,
    });
  put("apple-health", "health.json", health);
  put(
    "strava-activities",
    "activities.json",
    [-15, -13, -11, -9, -7, -5, -3].map((offset, i) => ({
      externalId: `sb-late-run-${i}`,
      id: 980000 + i,
      name: "Late running-club session",
      sportType: "Run",
      distanceMeters: 11000,
      movingTimeSeconds: 3900,
      totalElevationGainMeters: 35,
      startTime: londonAt(day(offset), "21:00"),
      averageHeartRate: 151,
      maxHeartRate: 174,
      description: "Club changed training to later evening; comparable flat route.",
    })),
  );
  put("google-calendar", "events.json", [
    calendar(
      "sb-running-time-change",
      "Running club moves to late evening",
      day(-15),
      "21:00",
      65,
      "Club timetable changed from morning sessions to 21:00 evening sessions. Not evidence of medical causality.",
    ),
  ]);
  put("gmail", "messages.json", [
    mail(
      "sb-running-change-email",
      "Running club evening timetable starts",
      `From ${day(-15)} our group sessions start at 21:00 rather than 07:00. Same flat route and distance.`,
      day(-18),
      "p_running",
    ),
  ]);
  put("apple-notes", "notes.json", [
    ...sources["apple-notes"]["notes.json"],
    {
      externalId: "sb-late-run-diary",
      title: "Running and sleep observation",
      body: `On ${day(-15)} the club moved to evening sessions. I noticed being awake longer after runs. This is only my observation; work stress and caffeine were not systematically measured. No diagnosis or claim that running caused poor sleep.`,
      folder: "Health",
      createdAt: at(day(-15)),
      modifiedAt: at(day(-1)),
    },
  ]);
  return {
    sources,
    facts: [
      {
        id: "F04",
        prompt:
          "What changed around the time my sleep got worse? Calculate asleep-stage averages for the two weeks before and after the running-club timetable change; do not count awake/in-bed duration.",
        expected: {
          changeDay: day(-15),
          beforeStart: day(-29),
          beforeEnd: day(-16),
          afterStart: day(-15),
          afterEnd: day(-2),
          beforeMeanHours: 7.5,
          afterMeanHours: 6,
          association: "running club moved from morning to late evening",
          causality: "not established",
        },
        evidence: [
          "sb-running-time-change",
          "sb-running-change-email",
          "sb-late-run-diary",
          "apple_health_sleep",
          "sb-late-run-*",
        ],
        limits: [
          "Exclude Awake and overlapping InBed categories; nights attributed to start date; correlation is not causation.",
        ],
      },
    ],
    counts: {
      gbpTransactions: tx.length,
      eurTransactions: eurTx.length,
      usdTransactions: plaidTx.length,
      healthDays: count,
    },
  };
}
