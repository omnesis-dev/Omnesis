<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<!-- Copyright (c) 2026 Adrien Conrath -->

# Speaker grouping eval — results

How the session-wide grouping of voice windows (`groupVoices`) counts and
attributes speakers, and which change to it to make. The full tables are in
[`results/device-chunks.md`](results/device-chunks.md); how the eval works is
in [README.md](README.md).

Production now uses the recommended C1 (similarity 0.425, and a size floor
that grows to 5 % of a long session's voiced time). `C0` below is the rule it
replaced, which the eval keeps as its baseline.

## Data

| set                   | recordings                                            | length                      | speakers (≥10 s of talk)    | role                |
| --------------------- | ----------------------------------------------------- | --------------------------- | --------------------------- | ------------------- |
| VoxConverse dev       | 36 (every one with 2–4 reference speakers and ≥5 min) | 5–17 min, 9 of them ≥10 min | 2: 15 · 3: 12 · 4: 8 · 1: 1 | choosing parameters |
| AMI test, `Array1-01` | 16 meetings, 4 series                                 | 14–50 min                   | 4: 15 · 3: 1                | confirming them     |

Every recording was cut into chunks of 18 s on average (at most 60 s, in a
silence), and each chunk went through the production voice worker with the
pinned pyannote-3.0 and ERes2Net models. The windows are what production makes
of such a recording: 9,384 windows over 14.3 hours of audio. Reference overlap
inside windows is 0–7 % on most VoxConverse recordings, 5–20 % on three of the
AMI series and 31–39 % on the EN2002 series. There are no 2-speaker AMI
meetings, so the 2-speaker numbers are VoxConverse only.

The 16 AMI meetings are four groups of four people, so they carry less evidence
than their number suggests: a parameter that suits one group's voices moves
four meetings at once.

## What is wrong with the current grouping

The production grouping (`C0`, average-linkage at similarity 0.4, then folding
speakers under `min(8 s, 15 %)` of voiced time) over-counts on every AMI
meeting, by 4.1 speakers on average, and on 37 % of the VoxConverse recordings.

| C0 at threshold   | VoxConverse exact count | AMI exact count | AMI mean count error |
| ----------------- | ----------------------- | --------------- | -------------------- |
| 0.30              | 46 %                    | 31 %            | 1.0                  |
| 0.35              | 54 %                    | 13 %            | 2.2                  |
| 0.40 (production) | 54 %                    | 0 %             | 4.1                  |
| 0.45              | 49 %                    | 0 %             | 8.0                  |

The hypothesis holds. The extra speakers are small groups of short, noisy
windows spread over the session. For anything longer than about a minute of
voiced time the floor is a flat 8 s, and a 40-minute meeting leaves plenty of
such groups above 8 s. Moving the threshold alone cannot fix it. At 0.3 the
noise groups merge, but so do real speakers: AMI is still over-counted on 56 %
of meetings and under-counted on 13 %, with 16.7 % attribution error. A floor
that grows with the session removes the noise groups and leaves the threshold
free to keep real speakers apart.

## Candidates

Each family is shown at the parameters chosen on VoxConverse and all of AMI
(equal weight, each parameter set judged together with its threshold
neighbours ±0.025, so the choice sits on a plateau and not on a lucky peak).
The "cross-fitted" column is the honest out-of-sample AMI figure: parameters
chosen on VoxConverse plus two AMI series, scored on the other two series, and
the other way round.

Exact count is against the number of reference speakers with at least 10 s of
talk. Attribution error is the share of window time given to the wrong speaker
under the best one-to-one mapping (the DER confusion term on the windows), as a
mean per recording.

| candidate                                                      | Vox 2 spk exact | Vox 3–4 spk exact | Vox ≥10 min exact | Vox mean \|Δcount\| | Vox error | AMI exact | AMI cross-fitted exact | AMI mean \|Δcount\| | AMI error |
| -------------------------------------------------------------- | --------------- | ----------------- | ----------------- | ------------------- | --------- | --------- | ---------------------- | ------------------- | --------- |
| **C0** production, t=0.4                                       | 53 %            | 55 %              | 56 %              | 1.09                | 8.7 %     | 0 %       | —                      | 4.13                | 12.0 %    |
| C0 best threshold, t=0.3                                       | 40 %            | 50 %              | 44 %              | 0.74                | 13.0 %    | 31 %      | 31 %                   | 1.00                | 16.7 %    |
| **C1** t=0.425, floor `max(8 s, 5 %)`                          | 67 %            | 50 %              | **89 %**          | 0.51                | 7.4 %     | **75 %**  | **69 %**               | 0.38                | 8.8 %     |
| C2 t=0.325, cluster windows ≥3 s                               | 47 %            | 50 %              | 44 %              | 0.63                | 13.0 %    | 69 %      | 31 %                   | 0.31                | 16.7 %    |
| C3 t=0.5, windows ≥4 s, floor 5 %                              | 73 %            | 50 %              | 78 %              | 0.54                | 8.1 %     | 75 %      | 56 %                   | 0.38                | 9.3 %     |
| C5 Omi's constants (0.30 / 30 s / 0.40 / 10 s)                 | 60 %            | 45 %              | 78 %              | 0.57                | 12.8 %    | 56 %      | —                      | 0.44                | 16.7 %    |
| C5 re-swept: t=0.35, anchor 60 s, absorb 0.5, participant 10 s | 67 %            | 55 %              | 67 %              | 0.46                | 9.3 %     | 75 %      | 38 %                   | 0.25                | 10.6 %    |
| C4 spectral NME-SC, windows ≥2 s, floor 5 %                    | 87 %            | 45 %              | 78 %              | 0.49                | 9.6 %     | 63 %      | 44 %                   | 0.69                | 13.0 %    |

VoxConverse has 15 two-speaker, 20 three-or-four-speaker and 9 recordings of at
least 10 minutes; the one single-speaker recording is outside these columns.

- C1 is the only family whose cross-fitted AMI score stays close to its
  in-sample one (69 % against 75 %). The others lose 20 to 40 points out of
  sample: their best settings fit one group of voices, not the problem.
- Clustering only the longer windows (C2, C3) does not help once the floor is
  proportional. C3 (windows ≥4 s, floor 5 %) reaches 88 % on AMI at t=0.375,
  but only at that exact threshold: 0.35 and 0.4 give 63 % and 69 %.
- Omi's approach with its own constants under-counts here (38 % of AMI
  meetings, 40 % of VoxConverse). Its constants were tuned for WeSpeaker
  ResNet-34, and ERes2Net similarities are distributed differently. Re-swept,
  it matches C1 in-sample but does not hold out of sample.
- Spectral clustering is the best two-speaker counter (87 %) but the worst
  attributor on long recordings (12.9 % error on VoxConverse ≥10 min, against
  2.0 % for C1). Its eigengap is unstable with 3–4 speakers.
- The two-speaker recordings of at least 10 minutes, the case that prompted
  this work, all come out as two speakers with C1 (5 of 5, attribution error
  0–0.6 %). Production gets 3 of 5 and finds 3 and 4 speakers on the other two.

### Production lengths

On the first 10 and 30 minutes of the longer recordings (C1 against production):

| truncation          | n   | C0 exact | C1 exact | C1 error |
| ------------------- | --- | -------- | -------- | -------- |
| VoxConverse, 10 min | 6   | 83 %     | 83 %     | 0.8 %    |
| AMI, 10 min         | 16  | 19 %     | 50 %     | 7.3 %    |
| AMI, 30 min         | 8   | 13 %     | 50 %     | 9.6 %    |

A 10-minute AMI excerpt often has a participant with only a few seconds of
talk. C1 misses that participant on 31 % of the excerpts, and production splits
the excerpt on 69 %.

### Chunk length matters

The first pass cut chunks at the reference silence nearest 18 s anywhere up to
60 s, which on dense broadcast speech averaged 25–35 s
([`results/long-chunks.md`](results/long-chunks.md)). Cutting near 18 s, as a
device does, makes more short windows. Production's over-count grows with
them: its VoxConverse exact count falls from 60 % to 54 %.

The chunk length also changes which candidate wins. With the longer chunks,
spectral clustering (C4) is the best cross-fitted family: 75 % on AMI and every
two-speaker VoxConverse recording. C1 is chosen there at t=0.35 with a 3 %
floor and scores 63 % cross-fitted. At device length C4 falls to 44 % while C1
holds 69 %, because the eigengap is thrown off by the extra short windows. The
recommendation follows the 18 s results, since that is what the device sends.
The best constants move with chunk length, so they should be measured again if
the device's chunking changes.

## Recommendation

**C1: keep the average-linkage clustering, cut at similarity 0.425, and fold
every speaker with less than `max(8 s, 5 % of the session's voiced time)` into
the most similar larger one.** It is two constants and one line in
`absorbSmallSpeakers`:

```ts
export const SAME_SPEAKER_SIMILARITY = 0.425;
const floor = Math.max(Math.min(MIN_SPEAKER_MS, total * MIN_SPEAKER_SHARE), total * 0.05);
```

Written this way it keeps today's floor for sessions with less than 160 s of
voiced time, the one- to four-minute dialogues the current constants were
calibrated on. The eval cannot measure that range, since its shortest recording
has more than 160 s of voiced time; above it the floor is C1's. Grouping cost
does not change: 2,000 windows, a four-hour session, group in about 1.9 s on
one core of the test machine (a laptop i7-1270P), the same as today (0.4 s for
1,000 windows).

## Verdict against the target

Target: exact speaker count on at least 80 % of 2–4-speaker conversations of at
least 10 minutes, with attribution error at most 15 %.

| ≥10 min, 2–4 speakers           | n   | exact count | mean error | exact and error ≤15 % |
| ------------------------------- | --- | ----------- | ---------- | --------------------- |
| VoxConverse                     | 9   | 89 %        | 2.0 %      | 89 %                  |
| AMI, parameters chosen with AMI | 16  | 75 %        | 8.8 %      | 75 %                  |
| AMI, cross-fitted               | 16  | 69 %        | 9.0 %      | 69 %                  |
| pooled, in-sample               | 25  | 80 %        | —          | 80 %                  |
| pooled, AMI cross-fitted        | 25  | 76 %        | —          | 76 %                  |

**Attribution passes everywhere. The count target is met on two-speaker
conversations and on VoxConverse, and missed on four-person far-field meetings
(69–75 % against 80 %).** Pooled, the recommendation lands at 80 % in-sample
and 76 % out of sample: on the line, not clearly over it. Production scores
0 % on AMI, so the gain is large either way.

What still fails:

- **Heavily overlapped four-person meetings.** The EN2002 series has 31–39 %
  overlapped speech inside the windows. C1 finds 5 or 6 speakers on two of its
  four meetings, with 19–27 % attribution error. Windows spanning two voices
  give vectors between two speakers. Overlap detection, so that those windows
  are left out, would help more than any grouping constant.
- **A quiet participant.** A speaker with 10–30 s in a short recording, or
  under 5 % of a long one, is folded into someone else. This is most of the
  VoxConverse 3–4-speaker misses (under-counted on 45 %). It is the cost of
  the floor, and the safer error: the conversation's main speakers stay right.
- **Two similar voices.** A few VoxConverse recordings (two news readers, for
  example) need a lower threshold than every other recording. No single cut
  serves both.

## Owner profile

The owner is the reference speaker who talks most. Their profile is the mean
of 60 s of their clean windows: windows removed from the same session
(in-session), or, on AMI, taken from another meeting of the same series
(cross-session, a different day in the same room). The impostor trials give
each session the profile of someone who is not in it. Speakers are grouped
with C1.

### Naming the owner (`matchSelf`)

The self-voice branch names the speaker whose mean vector is at least
`SELF_VOICE_SIMILARITY` similar to the profile (0.5 when this was measured,
0.6 since, from the results below).

| threshold | owner named: in-session Vox / AMI, cross-session AMI | false match, owner present | false match, impostor: Vox / AMI |
| --------- | ---------------------------------------------------- | -------------------------- | -------------------------------- |
| 0.30      | 100 % / 100 %, 100 %                                 | 0 %                        | 72 % / 81 %                      |
| 0.40      | 100 % / 100 %, 100 %                                 | 0 %                        | 39 % / 13 %                      |
| 0.50      | 100 % / 100 %, 100 %                                 | 0 %                        | 17 % / 0 %                       |
| 0.60      | 100 % / 100 %, 100 %                                 | 0 %                        | 0 % / 0 %                        |
| 0.70      | 100 % / 100 %, 100 %                                 | 0 %                        | 0 % / 0 %                        |

Similarity to the profile:

|                                                       | min  | median    | max  |
| ----------------------------------------------------- | ---- | --------- | ---- |
| the owner's speaker, cross-session AMI                | 0.80 | 0.91      | 0.94 |
| the owner's speaker, in-session                       | 0.85 | 0.95      | 0.99 |
| the most similar other speaker in the owner's session | 0.16 | 0.42–0.49 | 0.63 |
| the most similar speaker, owner absent                | 0.15 | 0.33–0.36 | 0.60 |

**0.5 is too low: when the owner is not in a recording, someone else is named
owner in 17 % of VoxConverse sessions.** Owners score 0.80 or more and
everybody else 0.63 or less, so **0.7** sits in the gap with room on both
sides. Nothing missed and nothing falsely matched from 0.6 to 0.7. The
evidence for owners is a same-room profile. An enrolment recorded on another
device or in another place will score lower than 0.80, which argues for the
lower end of the gap rather than the higher.

### Grouping with the profile

Pinning windows to the owner by their own similarity to the profile does not
help and often hurts. Single windows of other speakers reach 0.5–0.7, so a low
pin threshold steals their windows and makes others vanish. A high one changes
little.

|                                                  | Vox in-session | AMI in-session | AMI cross-session |
| ------------------------------------------------ | -------------- | -------------- | ----------------- |
| C1 without the profile: exact count / error      | 51 % / 9.3 %   | 81 % / 8.9 %   | 75 % / 8.8 %      |
| pin windows ≥0.6                                 | 63 % / 8.7 %   | 63 % / 14.9 %  | 69 % / 13.7 %     |
| pin windows ≥0.8                                 | 63 % / 8.3 %   | 75 % / 9.1 %   | 63 % / 9.4 %      |
| merge speakers whose mean is ≥0.7 into the owner | 60 % / 7.3 %   | 81 % / 8.9 %   | 75 % / 8.8 %      |

(Vox in-session is below the main table because 60 s of the owner's windows
are removed from each session.) The one safe use is after grouping: merging
every speaker whose mean is at least 0.7 similar to the profile into the owner
repairs an owner who was split in two, without touching anyone else. It gains
on VoxConverse and changes nothing on AMI. **Use the profile to name the owner,
and to merge the owner's split speakers at 0.7; do not use it to place
individual windows.**

## Caveats

- Public recordings in English (VoxConverse) and English by mostly non-native
  speakers (AMI), not Italian. The embedding model is language-agnostic, but
  the conversations it was calibrated on before were Italian.
- The reference stands in for the device's voice-activity detector when
  choosing where to cut chunks.
- Windows on non-speech and missed speech are outside the attribution error.
- AMI's cross-session owner trials enrol and test on the same microphone in the
  same room, which is easier than enrolment on another device.
- With 16 AMI meetings in four groups, one meeting is 6 points; differences of
  one or two meetings between candidates are noise.
