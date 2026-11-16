"""TEMPORARY measurement summary (removed before merge).

Attributes every G1 pause in /tmp/omnesis-gc-*.log and every memory sample
in /tmp/omnesis-heap-mem.log to the labelled run that was active at that time.
"""
import collections, datetime, glob, os, re

D = os.environ.get("HEAP_DIR", "/tmp")

UNIT = {"K": 1 / 1024, "M": 1, "G": 1024}
runs = []
if os.path.exists(f"{D}/omnesis-heap-runs.txt"):
    for line in open(f"{D}/omnesis-heap-runs.txt"):
        label, start, end, rc = line.split()
        runs.append((label, int(start), int(end), rc))


def run_for(t):
    for label, start, end, _ in runs:
        if start - 1 <= t <= end + 1:
            return label
    return "(between runs)"


def mb(v, u):
    return float(v) * UNIT[u]


pause = re.compile(
    r"^\[([^\]]+)\]\[gc\s*\] GC\(\d+\) (Pause [A-Za-z]+).*? (\d+(?:\.\d+)?)([KMG])->(\d+(?:\.\d+)?)([KMG])\((\d+(?:\.\d+)?)([KMG])\) (\d+(?:\.\d+)?)ms"
)
meta = re.compile(r"^\[([^\]]+)\]\[gc,metaspace\s*\] GC\(\d+\) Metaspace: \d+[KMG]\(\d+[KMG]\)->(\d+)([KMG])")
stats = collections.defaultdict(lambda: collections.defaultdict(float))
for path in sorted(glob.glob(f"{D}/omnesis-gc-*.log")):
    kind = os.path.basename(path).split("-")[2]
    pid = os.path.basename(path).rsplit("-", 1)[1].split(".")[0]
    for line in open(path, errors="replace"):
        m = pause.match(line)
        if m:
            t = datetime.datetime.strptime(m.group(1), "%Y-%m-%dT%H:%M:%S.%f%z").timestamp()
            s = stats[(run_for(t), kind, pid)]
            before, after, committed = mb(m.group(3), m.group(4)), mb(m.group(5), m.group(6)), mb(m.group(7), m.group(8))
            s["pauses"] += 1
            s["pause_ms"] += float(m.group(9))
            s["max_before"] = max(s["max_before"], before)
            s["max_after"] = max(s["max_after"], after)
            s["max_committed"] = max(s["max_committed"], committed)
            if m.group(2) == "Pause Full":
                s["full"] += 1
                s["max_after_full"] = max(s["max_after_full"], after)
            if m.group(2) in ("Pause Remark", "Pause Cleanup"):
                s["max_after_mark"] = max(s["max_after_mark"], after)
            continue
        m = meta.match(line)
        if m:
            t = datetime.datetime.strptime(m.group(1), "%Y-%m-%dT%H:%M:%S.%f%z").timestamp()
            s = stats[(run_for(t), kind, pid)]
            s["max_meta"] = max(s["max_meta"], mb(m.group(2), m.group(3)))

print("== runs ==")
for label, start, end, rc in runs:
    print(f"{label:28} exit={rc:>3} seconds={end - start}")
print("\n== heap per run and JVM (MiB) ==")
print(f"{'run':28} {'jvm':7} {'pid':>7} {'pauses':>6} {'full':>4} {'pause_s':>7} {'maxBefore':>9} {'maxAfter':>8} {'afterMark':>9} {'afterFull':>9} {'committed':>9} {'metaspace':>9}")
for (label, kind, pid), s in sorted(stats.items(), key=lambda kv: (kv[0][0], kv[0][1], kv[0][2])):
    print(
        f"{label:28} {kind:7} {pid:>7} {int(s['pauses']):>6} {int(s['full']):>4} {s['pause_ms'] / 1000:>7.1f} "
        f"{s['max_before']:>9.0f} {s['max_after']:>8.0f} {s['max_after_mark']:>9.0f} {s['max_after_full']:>9.0f} {s['max_committed']:>9.0f} {s['max_meta']:>9.0f}"
    )

if os.path.exists(f"{D}/omnesis-heap-mem.log"):
    mem = collections.defaultdict(lambda: collections.defaultdict(float))
    jvm_sum = collections.defaultdict(float)
    for line in open(f"{D}/omnesis-heap-mem.log"):
        parts = line.split()
        if len(parts) < 2:
            continue
        label = run_for(int(parts[0]))
        if parts[1] == "MEM" and len(parts) == 5:
            mem[label]["total_mb"] = float(parts[2])
            mem[label]["peak_used_mb"] = max(mem[label]["peak_used_mb"], float(parts[3]))
            low = mem[label].get("min_avail_mb", float(parts[4]))
            mem[label]["min_avail_mb"] = min(low, float(parts[4]))
        elif parts[1] == "JVM" and len(parts) == 5:
            mem[label][f"rss:{parts[3]}"] = max(mem[label][f"rss:{parts[3]}"], float(parts[4]) / 1024)
            jvm_sum[(label, parts[0])] += float(parts[4]) / 1024
    for (label, _), total in jvm_sum.items():
        mem[label]["rss:all-jvms"] = max(mem[label]["rss:all-jvms"], total)
    print("\n== system memory and peak JVM RSS per run (MiB) ==")
    for label, s in mem.items():
        print(label, " ".join(f"{k}={v:.0f}" for k, v in sorted(s.items())))
