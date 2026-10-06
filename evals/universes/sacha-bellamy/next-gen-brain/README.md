<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->

# Progressive Brain scenario

Run the isolated interactive prototype from a configured checkout:

```sh
npx tsx scripts/demo-next-gen-brain.mts
```

The command starts a disposable gateway and all scripted model services, loads
the ambient fictional universe, and advances source changes when Enter is pressed.
It prints the local knowledge inspector URL and the isolated authentication-file
location. Enter after the final step stops the gateway and removes its temporary
data. `--auto` advances without prompts; `--exit-after` shuts down after replay;
`--focused` omits ambient source sync for diagnosing the progression alone.
It never reads the operator's normal configuration or calls a live model.

The ambient corpus is an explicit **pre-existing inventory** fixture. Its sources
sync through the real collector with autonomous cognition disabled. With the
isolated gateway stopped, the harness asserts that no synthesis work or runs
started and checkpoints only those initial source-arrival journal entries. It
then enables cognition for the progressive story. Evidence cascades remain intact,
and no discovery or verification coverage is invented. Historical bootstrap is
left disabled; enabling it would still have to discover this inventory. The
launcher reports the inventory count. This demonstrates operation over an existing
corpus; fresh-install historical admission has separate Brain Bench tests.

The corresponding full-gateway correctness suite is
`packages/collector/src/e2e/brain-next-gen.e2e.test.ts`. The model policies in
`brain-bench/next-gen-policy.ts` and `next-gen-loops.ts` emit actual agent tools;
`knowledge-puppet.ts` follows the engine's offered frontier and version tokens.

This optional scenario extends the demonstration universe's fictional household,
party coordination and explicit camera-loan threads. It is a new winter occurrence,
so its dates do not replace the existing demonstration questions or build outputs.
The source history stays intact. No personal corpus data informed these fixtures.

`scenario.json` contains source documents, arrival steps and engine expectations.
It does not alter `universe.json` or insert these documents during ambient source
sync: they must arrive progressively through the gateway. Desired outcomes and
model gate answers are kept outside ingested source text and metadata.

`NextGenScenarioDriver` in the collector Brain Bench loads the fixture and drives:

- `POST /documents` for actual creates, same-identity content updates, exact replays,
  late historical evidence and multi-document arrival batches;
- the real single-document privacy-delete route, including suppression of a later
  source replay with the same external ID;
- the virtual cognition clock, preserving source creation/update time separately
  from arrival and processing time.

The driver takes an existing `BrainBench`, fixture, and explicit provider/source
identity. Boot with `universe: "sacha-bellamy"` and `clock: "virtual"`. Set the clock
to the fixture epoch before starting next-generation bootstrap. The ambient corpus
can be synced for full integration or deferred while investigating one failure;
the final full demonstration must include the ambient universe. Configure every
model role with puppet/replay servers and disable live fallbacks. The existing
Brain Bench already substitutes the background agent, entailment verifier, brief
judge and System One decision transport at their production seams.

Call `driver.advance()` to get each checkpoint and the actual gateway document IDs.
The driver does not automatically drain all future work: that would erase the
hourly/routine batching behavior being tested. At checkpoints, wait for the engine's
specific maintenance state or marker and assert both the immediate stale state and
later repaired state. A quiet legacy run queue does not prove the new maintenance
queue has completed. `driver.run(callback)` offers the same sequence with an awaited
observation callback at every step.

## Replay decisions and required integration assertions

These expectations are the behavior table for a deterministic model. They are not
quality claims about a live model and are not assertions already executed by the
fixture loader test. Bind them to the implemented synthesis tools and decision
rubrics, then assert the resulting production state:

| Stage                     | Scripted behavior                                                          | Engine proof                                                                                                      |
| ------------------------- | -------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| Recent bootstrap          | Organize gathering and loan topics; create independently completable loops | No duplicate pages or outcomes; root aggregation does not merge unrelated scheduling regions                      |
| Exact replay              | No semantic change                                                         | No new source revision, no duplicate synthesis or maintenance                                                     |
| New correction            | Discovery associates a new document; immediate tier                        | Current accepted time changes; unrelated guest-arrival claim stays stable                                         |
| Existing source edit      | One-hour tier                                                              | Same document ID, new content hash; immediate invalidation before model repair                                    |
| Late historical evidence  | Preserve current commitment; add history if useful                         | Older proposal cannot override newer acceptance                                                                   |
| Parallel regions          | Routine tier for camera acknowledgement                                    | Separate pending component before shared evidence joins it                                                        |
| Shared update             | Associate one source with both regions                                     | Coalesced overlapping work and one visit per complete input set                                                   |
| Privacy delete and replay | No model permission required                                               | Removed access phrase absent from claims, wiki/root renderings and search; source tombstone prevents resurrection |
| Unrelated note            | Decline new page and loop                                                  | Source remains searchable without synthetic page proliferation                                                    |
| Contradiction             | Keep stronger accepted evidence; record uncertainty                        | Weak suggestion cannot silently replace current truth                                                             |
| Clarification             | Resolve uncertainty                                                        | Existing page/loop identities survive                                                                             |
| Routine boundary          | Process due work                                                           | Complete frontier, bounded root, no reopening completed outcomes                                                  |

Inject model failure, process restart, stale-write conflicts, root-size rejection,
and malformed/unsupported claim writes around these same checkpoints in the E2E
suite. The fixture intentionally does not fake any success state or write directly
to knowledge tables. Agent tool execution and decision responses must be observed
through the production surfaces. Page creation, repairs, decisions and semantic
verification are the caller's replay policies, whose tool names follow the actual
implementation rather than a second fixture-specific API.
