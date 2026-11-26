<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<!-- Copyright (c) 2026 Adrien Conrath -->

# Speaker grouping eval

A public benchmark for how Omnesis groups the voices of a recorded
conversation into speakers. It answers one question: given the voice windows
and vectors the production separator produces, which grouping finds the right
number of speakers and gives each window to the right one?

The findings are in [RESULTS.md](RESULTS.md). The full tables of a run are in
[`results/`](results/).

## What is measured

A recording device sends a conversation as chunks of about 18 seconds, cut in
silences, and the gateway separates voices one chunk at a time. Each chunk's
turns are cut into voice windows of 1 to 8 seconds, and every window gets an
ERes2Net voice vector. When the session ends, all its windows are grouped into
speakers at once (`groupVoices` in
`packages/gateway/src/recordings/voices/voices.ts`).

The eval replays that on public recordings with reference speaker turns:

1. `prepare.ts` cuts each recording into device-like chunks of about 18 s —
   in the gap between reference turns nearest 18 s, within 6 s of it, or else
   at the quietest 50 ms in that range — and sends every chunk through the
   real `LocalVoiceSeparator`, which spawns the production voice worker with
   the pinned models. The windows (on the recording's timeline), their
   vectors and the reference turns are cached. This is the expensive step and
   runs once per recording.
2. `run.ts` runs every grouping candidate over a parameter grid on the cache
   and scores it.

Two scores per recording:

- **Speaker count.** The estimate is the number of speakers the grouping
  returns. The true count is the number of reference speakers with at least
  10 s of talk; the count of every reference speaker is reported beside it.
- **Attribution error.** Each window's reference speaker is the one who talks
  most inside it. Hypothesis and reference speakers are paired one to one to
  maximise matched time (Hungarian); the error is the share of window time
  whose speaker is not paired with its reference speaker. An extra speaker is
  wrong for all its time. This is the confusion term of the diarization error
  rate, on the windows the separator found; missed speech and windows on
  non-speech are outside it (non-speech share is listed per recording).

Results are split by true count (2, 3, 4+ speakers) and by length (under and
over 10 minutes), and repeated on the first 10 and 30 minutes of the longer
recordings, the lengths a device session usually has.

## Data

- **VoxConverse dev** (CC BY 4.0) — the tuning set. Broadcast and interview
  audio from YouTube. Every recording with 2 to 4 reference speakers and at
  least 5 minutes is used (36 of 216). The audio comes from the
  `diarizers-community/voxconverse` mirror on the Hugging Face hub, because the
  Oxford download now asks for a login; the RTTMs from `joonson/voxconverse`.
- **AMI test meetings** (CC BY 4.0) — the confirmation set. Sixteen meetings
  of 3 to 4 people, single distant microphone `Array1-01` (a microphone on the
  table, like a phone), RTTMs from `pyannote/AMI-diarization-setup`
  (`only_words`). AMI speaker ids are global, so a meeting's speakers can be
  enrolled from another meeting of the same series.

Parameters are chosen on VoxConverse only and confirmed on AMI. All downloads
are pinned to commits. Nothing is redistributed: the repository holds scripts
and scores.

## Candidates

All in `src/candidates.ts`, pure functions of a session's vectors and window
durations:

|     |                                                                                                                                                     |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| C0  | the original production rule: average-linkage AHC cut at a cosine similarity, speakers under `min(8 s, 15 %)` folded into the nearest larger one    |
| C1  | C0 with a floor that grows with the session: `max(8 s, share × voiced time)`                                                                        |
| C2  | cluster only windows of at least L seconds; shorter windows join the nearest speaker; C0 floor                                                      |
| C3  | C2 with the C1 floor                                                                                                                                |
| C4  | spectral clustering with the count from the normalised maximum eigengap (NME-SC) on the reliable windows, then the C1 floor                         |
| C5  | Omi's resolution: AHC, anchor voices with enough talk absorb nearby fragments, voices under the participant floor fold into the nearest participant |

The owner-profile part simulates enrolling the owner's voice: the dominant
reference speaker is the owner; 60 s of their clean windows (removed from the
session) or, on AMI, from another meeting of the series, give the profile
(`meanVoice`). It scores the `matchSelf` rule (the speaker whose mean vector
is at least the threshold similar to the profile is the owner) on target and
impostor trials, and two ways of using the profile while grouping.

## Running it

```sh
# Once: download (about 4 GB) and separate every recording; 7 workers in parallel.
# About two hours on a laptop i7 with 8 workers.
npm run speaker-eval:prepare
# Score every candidate and write results/<name>.md and .json.
npm run speaker-eval:run -- --name my-change
```

The data lives in `~/.cache/omnesis-speaker-eval`, or wherever
`OMNESIS_SPEAKER_EVAL_DATA` or `--data-dir` points. `prepare` skips recordings
already separated; delete `separated/<id>.*` to redo one, for example after
changing the separator or the models, or point both scripts at another cache
with `--cache <name>` to keep the old one beside it (`results/long-chunks.md`
was scored from a cache cut into longer chunks). `--concurrency` sets the
number of voice workers (two threads each). A run takes a few minutes; `run
--skip-spectral` leaves out C4, the slowest candidate.

A change to `voiceWindows`, the worker or the models needs a new `prepare`; a
change to grouping only needs `run`.

## Files

| Path                | What                                                          |
| ------------------- | ------------------------------------------------------------- |
| `src/prepare.ts`    | Downloads, device-like chunking, production separation, cache |
| `src/chunking.ts`   | Where a device would cut the chunks                           |
| `src/dataset.ts`    | Cache layout, RTTM parsing, truncation                        |
| `src/candidates.ts` | The grouping candidates and the owner-profile rules           |
| `src/spectral.ts`   | NME-SC spectral clustering and a symmetric eigensolver        |
| `src/metrics.ts`    | Window references, Hungarian mapping, attribution error       |
| `src/run.ts`        | The sweep, parameter choice, tables                           |
