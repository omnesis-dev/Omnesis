Review the operator's **developer annotations** — the in-app data-quality feedback
channel (portal ⚑ button / mobile shake-to-annotate, gated behind `OMNESIS_DEV_MODE`)
— and propose a plan to act on them. Each note is the operator flagging an
inconsistency, a wrong result, or a rough edge they noticed while using Omnesis,
attached to the exact entity they were looking at. Your job is to turn that raw
feedback into concrete engineering work.

The point of the channel is to use the feedback to find and fix:

- **Logic bugs and algorithm improvements** — ranking, people-merge, link/trail
  extraction, time-index / date resolution, dedup, enrichment, sync, and other
  deterministic code paths.
- **Omnesis agent prompt improvements** — when a note reflects the agent producing
  a bad brief, loop, time-index entry, or answer, the fix often lives in the
  agent's prompts / tool specifications rather than in deterministic code.

Keep both lenses in mind for every note: ask whether the root cause is code or
prompt (or data/config) before proposing a fix.

---

## 0. Make sure developer mode is on

The channel only works when the gateway was started with `OMNESIS_DEV_MODE=1`.
Check first:

```
omnesis dev-annotations
```

- If you get a list of notes (or an empty list), dev mode is on — continue.
- If it reports **developer mode is off**, help the operator enable it before
  going further. The gateway reads `OMNESIS_DEV_MODE` once at startup, so it must
  be set in the gateway's environment and the gateway then restarted. Walk them
  through it for their deployment — the env var goes wherever their gateway's
  environment lives (a service-manager env/drop-in, a Docker `-e OMNESIS_DEV_MODE=1`,
  or a shell `export` before launching), followed by a gateway restart — then
  re-run `omnesis dev-annotations`. Don't assume a specific setup; if you're not
  sure how their gateway is run, ask.

## 1. Investigate

1. Pull the open worklist as structured data:

   ```
   omnesis dev-annotations --json
   ```

   Each note carries `{ targetType, targetId }`, the operator's free-text `note`,
   a `deepLink`, a `context` snapshot of what they were looking at, and timestamps.

2. For each note, investigate the **actual entity** and the code/prompt path behind
   it — don't reason from the note text alone. Use the target to pull the real data
   (e.g. `omnesis show <id>` for a document; the CLI / portal for briefs, loops,
   time-index entries, or agent runs) and read the relevant source. Reproduce the
   problem where you can.

3. Group related notes: several notes pointing at the same subsystem are usually
   one root cause, and should be planned together.

4. Classify each note (or group) by root cause:
   - a deterministic **logic / algorithm** bug — name the file and function;
   - an **Omnesis agent prompt / tool-spec** issue — name the prompt or tool;
   - a **data / config** issue;
   - or **works-as-intended / needs the operator's clarification**.

## 2. Propose a plan — then stop and ask

Present a concise plan. For each note or group: the root-cause diagnosis, the
proposed fix and where it lives (code path or prompt), its blast radius, and a
rough effort / priority. Surface anything ambiguous or that depends on the
operator's intent.

**Do not start fixing.** The default for this command is investigate-and-propose.
Ask the operator for feedback and instructions on which items to act on and in
what order **before** making any code or prompt change. Only once they've chosen a
direction do you implement it — and then follow the normal flow (plan mode for
non-trivial work, tests, self-review).

## 3. After work is actually done — offer to clear notes

Once a note has genuinely been addressed (change merged, or the operator agrees
it's complete), **offer to resolve it** so the worklist reflects reality:

```
omnesis dev-annotations resolve <id> --note "<what you did>"
```

Only resolve notes that were actually acted on, and confirm with the operator
first. Leave open anything deferred or still under discussion. Use
`omnesis dev-annotations rm <id>` only for notes that are invalid or not
actionable — again with the operator's ok. Never clear a note the operator
hasn't agreed is done.

---

Additional instructions for this run (narrow the scope, focus on a subsystem,
override the defaults above, etc.):

$ARGUMENTS
