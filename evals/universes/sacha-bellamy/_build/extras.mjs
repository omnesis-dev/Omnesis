// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { addDays, at, jitter, OWNER_EMAIL, londonAt } from "./shared.mjs";

const technicalCases = [
  [
    "CSV exports",
    "How can I preserve a comma inside a quoted CSV field?",
    "Quote the field and double any embedded quote characters. A parser should read the escaped field as one value; splitting every line at commas loses that distinction.",
  ],
  [
    "date sorting",
    "Why does sorting date labels as strings give an odd order?",
    "Display labels and ordering keys serve different purposes. Keep an ISO date or numeric timestamp as the ordering key, then format the label only when rendering.",
  ],
  [
    "keyboard navigation",
    "What should happen when a list item disappears while it has focus?",
    "Choose a nearby surviving item as the next focus target, or focus the list container when it becomes empty. Test removal of the first, middle and last item.",
  ],
  [
    "JSON imports",
    "Can a trailing comma cause a JSON import to fail?",
    "Strict JSON does not permit trailing commas. Remove the comma before the closing bracket or brace; a JavaScript object literal is a different syntax.",
  ],
  [
    "image sizing",
    "Why does this thumbnail stretch when its container is narrow?",
    "Keep the intrinsic aspect ratio and constrain the maximum width. If cropping is intended, use a bounded container with object-fit: cover rather than changing the image proportions.",
  ],
  [
    "query pagination",
    "How can a table show whether there are more results?",
    "Fetch one extra row beyond the visible page size. Return a next-page indicator when that extra row exists, and do not include it in the displayed page.",
  ],
  [
    "local tests",
    "How can I compare an expected output without depending on the current clock?",
    "Supply a fixed clock through a function argument or dependency. Build the expected timestamps from that same explicit clock instead of reading the wall clock inside the test.",
  ],
  [
    "text encodings",
    "Why do accented letters look wrong after reading this file?",
    "The bytes may have been decoded with the wrong character encoding. Confirm the export encoding and decode it explicitly before changing or replacing individual characters.",
  ],
  [
    "input validation",
    "Where should I validate a form value before saving?",
    "Validate at the server boundary even when the browser also checks the form. Return a field-specific error for expected invalid input; keep the storage operation behind that validated boundary.",
  ],
  [
    "CSS spacing",
    "Why does the first heading add a gap above this panel?",
    "Inspect the heading margin and margin collapse at the container boundary. A flow-root container or explicit panel padding can make the intended spacing easier to reason about.",
  ],
  [
    "async cancellation",
    "How can I stop an old request replacing a newer search result?",
    "Associate each request with a generation number or AbortSignal. Apply the result only if that request still owns the active generation when it settles.",
  ],
  [
    "log rotation",
    "How can a small local tool avoid one ever-growing log file?",
    "Rotate on a bounded size or date and retain a limited number of files. Record rotation failures separately rather than silently discarding diagnostic output.",
  ],
  [
    "Unicode labels",
    "Should a character counter use string length for accented names?",
    "JavaScript string length counts UTF-16 code units. If the visible-character limit matters, segment grapheme clusters instead, and explain the limit beside the input.",
  ],
  [
    "empty states",
    "What should a table display when a filter matches no rows?",
    "Keep the column context and show a concise empty-state message with a way to clear the filter. Distinguish no matches from a failed request.",
  ],
  [
    "file names",
    "How can two exported files avoid overwriting each other?",
    "Choose a deterministic unique suffix or refuse an existing destination unless replacement was requested. Do not rely on a display title alone as a safe filesystem path.",
  ],
  [
    "accessibility labels",
    "Does an icon-only button need an accessible name?",
    "Yes. Provide a concise accessible name describing the action. A tooltip is useful for sighted users but is not a substitute for the control name.",
  ],
  [
    "database migrations",
    "What makes a small schema change safe to rerun?",
    "Track the applied migration version and run each step once in a transaction where supported. Test an existing populated database as well as an empty one.",
  ],
  [
    "HTTP retries",
    "Should every failed request be retried immediately?",
    "Retry only eligible transient failures with bounded backoff. Respect Retry-After when present, and avoid automatically repeating a non-idempotent write without an idempotency key.",
  ],
  [
    "decimal arithmetic",
    "Why does adding two displayed decimal values produce a tiny rounding difference?",
    "Binary floating-point cannot represent every decimal exactly. For fixed currency precision, calculate in integer minor units; for arbitrary precision use a decimal representation.",
  ],
  [
    "release notes",
    "What belongs in a useful changelog entry for a small fix?",
    "Describe the trigger and the corrected user-visible behavior. Include migration or compatibility steps only when the reader actually needs to take them.",
  ],
];
const householdDocs = [
  [
    "plant-care",
    "Check drainage before watering. Rotate the pot every few days so the stems do not all lean towards the window.",
  ],
  [
    "bread-notes",
    "The smaller tray gave a better rise. Let the dough rest after shaping and cool the loaf before slicing.",
  ],
  [
    "library-list",
    "Return the borrowed atlas and look for a compact guide to local trees. Keep a note of the edition.",
  ],
  [
    "toolbox",
    "Small screwdriver, measuring tape, cloth, spare screws and a pencil. Keep loose fittings in separate labelled tins.",
  ],
  [
    "community-room",
    "Fold the tables before stacking chairs. Leave the entrance clear and check that the windows are closed.",
  ],
  [
    "reading-circle",
    "Compare the narrator in the opening and final paragraph. Note the page numbering for different editions.",
  ],
  [
    "batch-lunches",
    "Cool the cooked lentils before freezing. Date each container and leave room for expansion.",
  ],
  [
    "bicycle-cleaning",
    "Wipe the chain after brushing. Keep degreaser away from the brake surfaces and dry the frame afterwards.",
  ],
  [
    "craft-supplies",
    "Store thin paper flat. Keep the glue bottle upright and use a mat beneath the cutting work.",
  ],
  [
    "courtyard-jobs",
    "Clear leaves from the drain and sweep the entrance. Put the brush back where the next person can find it.",
  ],
  [
    "coffee-notes",
    "Rinse the filter first. Keep the pouring height steady and compare one change at a time.",
  ],
  [
    "desk-checklist",
    "Leave cable slack around the display arm. Label the spare adapter and keep it with the presentation lead.",
  ],
];
const identifier = (kind, index) => `sb-extra-${kind}-${String(index).padStart(4, "0")}`;
function dateBetween(index, count, first, last) {
  const days = Math.floor((Date.parse(at(last)) - Date.parse(at(first))) / 86400000);
  return addDays(first, Math.floor((index * days) / Math.max(1, count - 1)));
}

/** Safe fictional inputs for source-native history; no inferred answers to any demo prompt. */
export function buildExtras(ctx) {
  const sources = {};
  const put = (id, file, entries) => {
    sources[id] = { [file]: entries };
  };
  const last = addDays(ctx.asOf, -1);
  put(
    "local-files",
    "files.json",
    Array.from({ length: 140 }, (_, i) => {
      const [name, body] = householdDocs[i % householdDocs.length];
      const day = dateBetween(i, 140, "2019-01-01", last);
      return {
        path: `Household/${day.slice(0, 4)}/${name}-${i}.md`,
        content: `# ${name.replaceAll("-", " ")}\n\n${body}\n\nWritten ${day}. Last experiment: ${1 + jitter(`experiment-${i}`, 6)} attempts; keep the earlier sheet for comparison.`,
        modifiedAt: at(day),
      };
    }),
  );
  for (const descriptor of ["codex", "claude-code", "pi"]) {
    put(
      descriptor,
      "sessions.json",
      Array.from({ length: 110 }, (_, i) => {
        const day = dateBetween(i, 110, addDays(last, -150), last);
        const [topic, prompt, answer] =
          technicalCases[(i + jitter(descriptor, technicalCases.length)) % technicalCases.length];
        return {
          id: identifier(descriptor, i),
          createdAt: at(day, "10:00"),
          prompt: `In my little household catalogue prototype: ${prompt} Context: the ${topic} experiment is running locally.`,
          answer: `${answer} Start with a small example and verify the edge case before changing the wider catalogue.`,
          project: "/fictional-projects/household-catalogue",
        };
      }),
    );
  }
  put(
    "imap",
    "messages.json",
    Array.from({ length: 160 }, (_, i) => {
      const day = dateBetween(i, 160, "2018-01-01", last);
      const [name, body] = householdDocs[i % householdDocs.length];
      const p = ctx.cast.people[2 + (i % (ctx.cast.people.length - 2))];
      return {
        uid: i + 1,
        subject: `Community notes: ${name.replaceAll("-", " ")}`,
        from: p.emails[0],
        to: [OWNER_EMAIL],
        body: `Here is the updated club note for ${day}.\n\n${body}\n\nPlease file it with the small practical checklists, rather than the event invitations.`,
        sentAt: at(day, "11:10"),
        mailbox: i % 7 === 0 ? "Archive" : "INBOX",
        messageId: `${identifier("imap", i)}@example.com`,
      };
    }),
  );
  put(
    "web",
    "pages.json",
    Array.from({ length: 180 }, (_, i) => {
      const day = dateBetween(i, 180, addDays(last, -360), last);
      const [name, body] = householdDocs[i % householdDocs.length];
      return {
        url: `https://practical-guides.example.org/${name}/chapter-${i}`,
        title: `Practical guide: ${name.replaceAll("-", " ")}`,
        content: `${body}\n\nChapter ${1 + (i % 9)}. This page describes an ordinary home experiment. Follow the material manufacturer's safety instructions and practise on a spare piece first.`,
        visitedAt: at(day, "13:30"),
        dwellMs: 12000 + jitter(`dwell-web-${i}`, 80000),
        profile: "Personal",
      };
    }),
  );
  for (const descriptor of ["openclaw", "hermes"]) {
    put(
      descriptor,
      "conversations.json",
      Array.from({ length: 110 }, (_, i) => {
        const day = dateBetween(i, 110, addDays(last, -170), last);
        const [topic, prompt, answer] = technicalCases[(i + 5) % technicalCases.length];
        return {
          chatId: identifier(descriptor, i),
          chatName: `Local tool help: ${topic}`,
          platform: "synthetic-local",
          day,
          messages: [
            { role: "user", text: prompt, at: at(day, "12:10") },
            { role: "assistant", text: answer, at: at(day, "12:11") },
            {
              role: "user",
              text: "Thanks. I will try that on a small example before changing the rest.",
              at: at(day, "12:12"),
            },
          ],
        };
      }),
    );
  }
  const places = [
    "Fernbank Community Garden",
    "Northstar Reading Room",
    "Brookside Shared Courtyard",
    "Small Lantern Library",
    "Cedar Table Cafe",
  ];
  put(
    "photos",
    "photos.json",
    Array.from({ length: 300 }, (_, i) => {
      const day = dateBetween(i, 300, addDays(last, -360), last);
      const [name, body] = householdDocs[i % householdDocs.length];
      const screenshot = i % 4 === 0;
      return {
        id: identifier("photo", i),
        createdAt: at(day, "14:00"),
        modifiedAt: at(day, "14:05"),
        isScreenshot: screenshot,
        ...(!screenshot ? { placeName: places[i % places.length] } : {}),
        textLines:
          i % 5 === 0
            ? []
            : [`Handwritten label: ${name.replaceAll("-", " ")}`, body.split(". ")[0]],
        tags: screenshot ? ["reference", "screenshot"] : ["everyday", "personal-project"],
      };
    }),
  );
  put(
    "activity-segments",
    "segments.json",
    Array.from({ length: 1500 }, (_, i) => {
      const day = addDays(last, -499 + Math.floor(i / 3));
      const slot = i % 3;
      const type =
        slot === 0
          ? "walking"
          : slot === 1
            ? "stationary"
            : ["cycling", "automotive", "walking", "unknown"][Math.floor(i / 3) % 4];
      // Morning movement follows the historical Strava sessions; evening movement
      // finishes before the authored late-running club session, even during BST.
      const startTime = at(day, slot === 0 ? "08:56" : slot === 1 ? "12:30" : "19:00");
      return {
        id: identifier("motion", i),
        type,
        startTime,
        endTime: new Date(
          Date.parse(startTime) + (slot === 0 ? 3 : slot === 1 ? 20 : 12) * 60000,
        ).toISOString(),
        confidence: type === "unknown" ? "low" : i % 11 === 0 ? "medium" : "high",
      };
    }),
  );
  for (const [index, offset] of [-15, -13, -11, -9, -7, -5, -3].entries()) {
    const startTime = londonAt(ctx.day(offset), "21:00");
    sources["activity-segments"]["segments.json"].push({
      id: identifier("club-running", index),
      type: "running",
      startTime,
      endTime: new Date(Date.parse(startTime) + 65 * 60000).toISOString(),
      confidence: "high",
    });
  }
  return sources;
}
