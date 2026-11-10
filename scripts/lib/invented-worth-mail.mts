// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Invented emails for the decision-model agreement eval: 26 templates across
 * the email worth rubric's categories, filled from a seeded generator so the
 * set is the same on every run. Every name, vendor, address and story is made
 * up for this file; domains are RFC 2606 reserved.
 */

export interface Mail {
  subject: string;
  from: string;
  body: string;
}

let seed = 590;
const rand = () => {
  seed = (seed * 1103515245 + 12345) % 2147483648;
  return seed / 2147483648;
};
const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)]!;
const int = (lo: number, hi: number) => lo + Math.floor(rand() * (hi - lo + 1));

const FIRST = [
  "Maya",
  "Jamie",
  "David",
  "Sarah",
  "Priya",
  "Tomás",
  "Lena",
  "Owen",
  "Hana",
  "Marcus",
  "Iris",
  "Felix",
  "Nadia",
  "Ruben",
  "Clara",
  "Theo",
];
const LAST = [
  "Reeves",
  "Lopez",
  "Lin",
  "Mendez",
  "Okafor",
  "Brandt",
  "Novak",
  "Hale",
  "Sato",
  "Quinlan",
  "Ferreira",
  "Walsh",
];
const SHOPS = [
  "Stellar Outfitters",
  "Harbor & Pine",
  "Nimbus Electronics",
  "Quillford Books",
  "Copperleaf Kitchen",
  "Brightwater Garden Supply",
  "Lumen Home",
];
const SERVICES = [
  "Ferngate Bank",
  "Orbitline Mobile",
  "Kestrel Energy",
  "Tidewell Insurance",
  "Cobalt Cloud Storage",
  "Pinecrest Water",
];
const CLINICS = [
  "Riverside Dental",
  "Northfield Medical Centre",
  "Willow Physio",
  "Clearview Eye Clinic",
];
const AIRLINES = ["Aurora Air", "Meridian Airways", "Skylark Regional"];
const HOTELS = ["Hotel Corvina", "The Saltmarsh Inn", "Alder Grove Lodge"];
const CITIES = ["Lisbon", "Kraków", "Bergen", "Valencia", "Ljubljana", "Porto", "Ghent"];
const DAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Sep", "Oct", "Nov", "Dec"];

const person = () => {
  const f = pick(FIRST);
  const l = pick(LAST);
  return {
    name: `${f} ${l}`,
    first: f,
    email: `${f.toLowerCase()}.${l.toLowerCase()}@example.com`,
  };
};
const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z]+/g, "-")
    .replace(/^-|-$/g, "");
const org = (name: string, box: string) => `${name} <${box}@${slug(name)}.example.com>`;
const date = () => `${int(1, 28)} ${pick(MONTHS)}`;
const time = () => `${int(8, 18)}:${pick(["00", "15", "30", "45"])}`;
const money = () => `€${int(12, 2400)}.${pick(["00", "50", "99", "20"])}`;
const ref = () => `${pick(["A", "K", "R", "T"])}${int(100000, 999999)}`;

type Gen = () => Mail;

const GENERATORS: Gen[] = [
  // Marketing and promotions
  () => {
    const s = pick(SHOPS);
    return {
      subject: `${pick(["Weekend sale", "Last chance", "New arrivals", "Members only"])}: ${int(15, 60)}% off ${pick(["everything", "outdoor gear", "kitchenware", "selected titles"])}`,
      from: org(s, "offers"),
      body: `Don't miss out! ${s} has ${int(15, 60)}% off until ${pick(DAYS)}. Use code ${pick(["SAVE", "HELLO", "SPRING"])}${int(10, 99)} at checkout. Free delivery over €50. Unsubscribe at any time.`,
    };
  },
  () => {
    const s = pick(SHOPS);
    return {
      subject: `You left something in your basket`,
      from: org(s, "hello"),
      body: `Still thinking it over? The items in your basket at ${s} are waiting. Complete your order in the next 24 hours and get free shipping.`,
    };
  },
  // Newsletters
  () => {
    const n = pick([
      "The Riverside Weekly",
      "Field Notes Digest",
      "Byte Sized",
      "The Slow Cook Letter",
      "Trailhead Monthly",
    ]);
    return {
      subject: `${n} — issue ${int(10, 300)}`,
      from: org(n, "digest"),
      body: `This week: ${pick(["five reads on urban gardening", "the state of open-source databases", "a recipe for autumn soup", "how trail runners pace hills"])}, a reader question, and our picks for the weekend. Read online. You are receiving this because you subscribed.`,
    };
  },
  // Social and platform notifications
  () => {
    const p = person();
    return {
      subject: `${p.name} ${pick(["liked your photo", "started following you", "commented on your post", "mentioned you in a comment"])}`,
      from: org(pick(["Snapgrove", "Chirply", "Linkfold"]), "notify"),
      body: `${p.name} ${pick(["liked your photo", "started following you", "commented: Nice one!", "mentioned you"])}. See what's new on your feed. Manage notification settings.`,
    };
  },
  // Verification codes
  () => ({
    subject: `Your verification code`,
    from: org(pick(SERVICES), "no-reply"),
    body: `Your one-time code is ${int(100000, 999999)}. It expires in 10 minutes. If you didn't request it, ignore this email.`,
  }),
  // Surveys
  () => {
    const s = pick([...SHOPS, ...SERVICES]);
    return {
      subject: `How did we do?`,
      from: org(s, "feedback"),
      body: `Tell us about your recent experience with ${s}. The survey takes two minutes and you could win a €50 voucher.`,
    };
  },
  // Cold outreach
  () => {
    const p = person();
    return {
      subject: `Quick question about your ${pick(["website", "marketing", "cloud costs", "hiring"])}`,
      from: `${p.name} <${p.email.replace("example.com", "growthly.example.org")}>`,
      body: `Hi there, I help companies like yours ${pick(["double their leads", "cut cloud spend by 30%", "hire faster"])}. Would you be open to a 15-minute call next week? Best, ${p.first}`,
    };
  },
  // Mailing list chatter
  () => {
    const p = person();
    return {
      subject: `Re: [${pick(["sqlite-users", "garden-club", "rust-dev", "cyclists-north"])}] ${pick(["build fails on ARM", "seed swap next month?", "lifetime question", "route for Sunday"])}`,
      from: `${p.name} <${p.email}>`,
      body: `I saw the same thing on my machine. ${pick(["Upgrading fixed it.", "Count me in.", "Try the nightly.", "I'd go the long way round."])} — ${p.first}`,
    };
  },
  // Order and delivery (minor)
  () => {
    const s = pick(SHOPS);
    return {
      subject: `Your order ${ref()} has shipped`,
      from: org(s, "orders"),
      body: `Good news! Your order from ${s} is on its way and should arrive by ${pick(DAYS)} ${date()}. Track your parcel with the link below. Total paid: ${money()}.`,
    };
  },
  () => {
    const s = pick(SHOPS);
    return {
      subject: `Order confirmation ${ref()}`,
      from: org(s, "orders"),
      body: `Thanks for your order. We've received payment of ${money()} and will email you when it ships. Items: ${pick(["1 × trail shoes", "2 × cast-iron pans", "1 × desk lamp", "3 × paperbacks"])}.`,
    };
  },
  () => ({
    subject: `Your parcel was delivered`,
    from: org(pick(["Swiftpost", "Parcelwing"]), "tracking"),
    body: `Your parcel ${ref()} was delivered today at ${time()} and left ${pick(["at the front door", "with a neighbour", "in the parcel locker"])}.`,
  }),
  // Account and statements (minor)
  () => {
    const s = pick(SERVICES);
    return {
      subject: `Your ${pick(["monthly statement", "e-statement", "bill summary"])} is ready`,
      from: org(s, "statements"),
      body: `Your ${s} statement for ${pick(MONTHS)} is now available in your account. Balance: ${money()}. No action needed if you pay by direct debit.`,
    };
  },
  () => {
    const s = pick(SERVICES);
    return {
      subject: `Your password was changed`,
      from: org(s, "security"),
      body: `The password for your ${s} account was changed on ${date()} at ${time()}. If this was you, no action is needed.`,
    };
  },
  () => {
    const s = pick(["Cobalt Cloud Storage", "Streamwave", "Notely Pro"]);
    return {
      subject: `Receipt for your subscription`,
      from: org(s, "billing"),
      body: `Thanks for renewing ${s}. We charged ${money()} to your card ending ${int(1000, 9999)}. Your plan renews on ${date()}.`,
    };
  },
  // Dated events (worth recording)
  () => {
    const c = pick(CLINICS);
    return {
      subject: `Appointment confirmed: ${pick(DAYS)} ${date()} at ${time()}`,
      from: org(c, "bookings"),
      body: `Your appointment at ${c} with ${pick(["Dr", "Ms", "Mr"])} ${pick(LAST)} is confirmed for ${pick(DAYS)} ${date()} at ${time()}. Please arrive 10 minutes early. Reply to reschedule.`,
    };
  },
  () => {
    const a = pick(AIRLINES);
    const city = pick(CITIES);
    return {
      subject: `Booking confirmed: flight to ${city}`,
      from: org(a, "bookings"),
      body: `Your flight ${pick(["AU", "MR", "SK"])}${int(100, 999)} to ${city} departs ${date()} at ${time()}. Booking reference ${ref()}. Check in opens 24 hours before departure.`,
    };
  },
  () => {
    const h = pick(HOTELS);
    return {
      subject: `Your stay at ${h}`,
      from: org(h, "reservations"),
      body: `We look forward to welcoming you on ${date()} for ${int(1, 6)} nights. Reservation ${ref()}. Total ${money()}, payable at the hotel.`,
    };
  },
  () => {
    const s = pick(SERVICES);
    return {
      subject: `Invoice ${ref()} due ${date()}`,
      from: org(s, "billing"),
      body: `Your invoice for ${money()} is due on ${date()}. Please pay by bank transfer quoting the invoice number. Late payments incur a fee.`,
    };
  },
  () => {
    const p = person();
    return {
      subject: `Invitation: ${pick(["Q4 budget review", "project kickoff", "design critique", "1:1"])} @ ${pick(DAYS)} ${time()}`,
      from: `${p.name} <${p.email}>`,
      body: `${p.name} has invited you to a meeting on ${pick(DAYS)} ${date()} at ${time()}. Join from the calendar link. Accept · Decline · Maybe`,
    };
  },
  () => {
    const p = person();
    return {
      subject: `Can you review the ${pick(["contract draft", "slides", "pull request", "budget sheet"])} by ${pick(DAYS)}?`,
      from: `${p.name} <${p.email}>`,
      body: `Hi, could you take a look at the ${pick(["contract draft", "slides", "pull request", "budget sheet"])} before ${pick(DAYS)}? I need your sign-off before we send it. Thanks, ${p.first}`,
    };
  },
  // Important
  () => {
    const p = person();
    return {
      subject: pick([
        "Dinner on Saturday?",
        "Long time!",
        "Photos from the weekend",
        "Are you around next week?",
      ]),
      from: `${p.name} <${p.email}>`,
      body: `Hey! ${pick(["We'd love to have you over for dinner on Saturday.", "It's been ages, how are you doing?", "Here are the photos from the lake, the kids loved it.", "I'm in town next week and would love to catch up."])} Let me know. Love, ${p.first}`,
    };
  },
  () => {
    const p = person();
    return {
      subject: `Money for the ${pick(["cabin", "concert tickets", "birthday gift", "car repair"])}`,
      from: `${p.name} <${p.email}>`,
      body: `Hi, just a reminder that you owe me ${money()} for the ${pick(["cabin", "concert tickets", "birthday gift", "car repair"])}. No rush, but before the end of the month would be great. ${p.first}`,
    };
  },
  () => {
    const c = pick(CLINICS);
    return {
      subject: `Your test results are available`,
      from: org(c, "results"),
      body: `Your recent ${pick(["blood test", "X-ray", "eye exam"])} results are ready. Dr ${pick(LAST)} would like to discuss them; please book a follow-up appointment within two weeks.`,
    };
  },
  () => ({
    subject: `${pick(["Tax return", "Residence permit", "Vehicle registration"])}: action required by ${date()}`,
    from: org(
      pick(["Municipal Services Office", "Revenue Agency", "Licensing Authority"]),
      "notices",
    ),
    body: `Our records show that your ${pick(["tax return", "residence permit renewal", "vehicle registration"])} must be completed by ${date()}. Submit the form online or visit an office with your ID. Ref ${ref()}.`,
  }),
  () => {
    const p = person();
    return {
      subject: `Decision on the ${pick(["vendor contract", "office move", "Q1 hiring plan", "pricing change"])}`,
      from: `${p.name} <${p.email}>`,
      body: `After yesterday's discussion we're going ahead with option ${pick(["A", "B"])} on the ${pick(["vendor contract", "office move", "Q1 hiring plan", "pricing change"])}. I need you to own the rollout and report back by ${date()}. ${p.first}`,
    };
  },
  () => {
    const p = person();
    return {
      subject: `Lease renewal for 42 Example Street`,
      from: `${p.name} <${p.email}>`,
      body: `Dear tenant, your lease ends on ${date()}. Please confirm by ${date()} whether you'd like to renew; the new rent would be ${money()} per month. Kind regards, ${p.name}`,
    };
  },
];

/** `count` invented emails, cycling the generators for an even mix. */
export function inventedMail(count: number): Mail[] {
  const out: Mail[] = [];
  for (let i = 0; i < count; i++) out.push(GENERATORS[i % GENERATORS.length]!());
  return out;
}
