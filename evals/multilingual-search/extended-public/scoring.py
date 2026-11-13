# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (c) 2026 Adrien Conrath
"""Judgment-aware ranking metrics and development-only acceptance calibration."""
import collections
import hashlib
import math
import random
import statistics

METRICS = ('nDCG@10', 'Recall@100', 'MRR@10')


def retrieval_metrics(ranking, judgments):
    positives = {docid for docid, value in judgments.items() if value == 1}
    if not positives:
        return None
    hits = [rank for rank, docid in enumerate(ranking[:100], 1) if docid in positives]
    dcg = sum(1 / math.log2(rank + 1) for rank in hits if rank <= 10)
    ideal = sum(1 / math.log2(rank + 1) for rank in range(1, min(10, len(positives)) + 1))
    return {'nDCG@10': dcg / ideal, 'Recall@100': len(hits) / len(positives),
            'MRR@10': 1 / hits[0] if hits and hits[0] <= 10 else 0.0}


def average(rows, keys=METRICS):
    return {key: statistics.fmean(row[key] for row in rows) for key in keys} if rows else {}


def calibrate(rows):
    development = [row for row in rows if row['split'] == 'dev']
    positive = sum(row['subset'] == 'relevant' for row in development)
    negative = len(development) - positive
    if not positive or not negative:
        raise ValueError('Calibration needs both official development subsets')
    grouped = collections.defaultdict(lambda: [0, 0])
    for row in development:
        if row['score'] is not None:
            grouped[row['score']][row['subset'] != 'relevant'] += 1
    # Rejecting everything is a valid threshold. Equal balanced accuracy favors
    # fewer apparent false accepts, then the higher threshold, frozen in policy.
    best = (0.5, 0, math.inf)
    true_accept, false_accept = 0, 0
    for threshold in sorted(grouped, reverse=True):
        p, n = grouped[threshold]
        true_accept += p
        false_accept += n
        objective = (0.5 * (true_accept / positive + 1 - false_accept / negative),
                     -false_accept / negative, threshold)
        if objective > best:
            best = objective
    return {'threshold': None if math.isinf(best[2]) else best[2],
            'rejectAll': math.isinf(best[2]), 'devBalancedAccuracy': best[0],
            'devRelevantQueries': positive, 'devNoKnownPositiveQueries': negative}


def quantiles(values):
    if not values:
        return {'count': 0}
    ordered = sorted(values)
    return {'count': len(values), **{key: ordered[round(p * (len(ordered) - 1))]
                                    for key, p in [('min', 0), ('p10', 0.1), ('median', 0.5), ('p90', 0.9), ('max', 1)]}}


def summarize(rows):
    calibration = calibrate(rows)
    result = {'calibration': calibration, 'splits': {}}
    for split in ('dev', 'test'):
        selected = [row for row in rows if row['split'] == split]
        positives = [row for row in selected if row['subset'] == 'relevant']
        negatives = [row for row in selected if row['subset'] == 'non_relevant']

        def accepts(row):
            return (not calibration['rejectAll'] and row['score'] is not None
                    and row['score'] >= calibration['threshold'])

        statuses = collections.Counter(row['top1Judgment'] for row in negatives)
        result['splits'][split] = {
            'relevant': {'queries': len(positives), **average([row['metrics'] for row in positives]),
                         'calibratedAcceptanceRate': sum(map(accepts, positives)) / len(positives),
                         'topScoreDistribution': quantiles([row['score'] for row in positives if row['score'] is not None])},
            'noKnownPositive': {'queries': len(negatives),
                               'anyResultRate': sum(row['score'] is not None for row in negatives) / len(negatives),
                               'apparentCalibratedFalseAcceptanceRate': sum(map(accepts, negatives)) / len(negatives),
                               'top1JudgmentCounts': dict(statuses),
                               'acceptedTop1JudgmentCounts': dict(collections.Counter(row['top1Judgment'] for row in negatives if accepts(row))),
                               'topScoreDistribution': quantiles([row['score'] for row in negatives if row['score'] is not None])}}
    return result


def paired_interval(candidate, baseline, seed, replicates=1000):
    if set(candidate) != set(baseline):
        raise ValueError('Unpaired query IDs')
    ids = sorted(candidate)
    result = {}
    for metric in METRICS:
        differences = [candidate[qid][metric] - baseline[qid][metric] for qid in ids]
        rng = random.Random(hashlib.sha256((seed + metric).encode()).digest())
        estimates = sorted(statistics.fmean(rng.choices(differences, k=len(differences))) for _ in range(replicates))
        result[metric] = {'meanDifference': statistics.fmean(differences),
                          'lower95': estimates[int(0.025 * replicates)],
                          'upper95': estimates[min(replicates - 1, int(0.975 * replicates))]}
    return result
