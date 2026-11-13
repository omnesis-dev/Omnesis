# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (c) 2026 Adrien Conrath

"""Deterministic lexical representation, routing, and diagnostic scoring."""

import collections
import hashlib
import json
import math
import re
import sqlite3
import unicodedata
from urllib.parse import urlsplit, urlunsplit

FIELDS = ("body", "title", "author", "url", "codes")
CODE = r"(?=[A-Za-z0-9-]*[0-9])[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,12})+"
ATOM = re.compile(r"(?i:https?)://[^\s<>\"()]+|(?<![\w-])" + CODE + r"(?![\w-])")
LANGUAGE_SCRIPTS = {
    "en": "Latin", "fr": "Latin", "es": "Latin", "de": "Latin", "nl": "Latin",
    "sv": "Latin", "da": "Latin", "nb": "Latin", "fi": "Latin", "hu": "Latin",
    "ro": "Latin", "cs": "Latin", "pl": "Latin", "tr": "Latin", "pt": "Latin",
    "it": "Latin", "vi": "Latin", "id": "Latin", "ru": "Cyrillic", "uk": "Cyrillic",
    "ar": "Arabic", "fa": "Arabic", "he": "Hebrew", "el": "Greek", "hi": "Devanagari",
    "ko": "Hangul", "zh": "Han", "ja": "Han", "th": "Thai", "km": "Khmer",
}


def canonical(value):
    return json.dumps(value, ensure_ascii=False, indent=2) + "\n"


def fingerprint(value):
    return hashlib.sha256(canonical(value).encode()).hexdigest()


def language(code):
    return {"no": "nb", "cmn": "zh"}.get(code, code or "und")


def field_texts(document):
    return {field: " ".join(document[field]) if field == "codes" else document[field] for field in FIELDS}


def detector_text(text):
    return " ".join(text.split())


def word_character(char):
    return char == "_" or unicodedata.category(char)[0] in {"L", "M", "N"}


def surface_words(text):
    text = unicodedata.normalize("NFC", text).casefold()
    output, current = [], []
    for char in text:
        if word_character(char):
            current.append(char)
        elif current:
            output.append("".join(current))
            current = []
    if current:
        output.append("".join(current))
    return output


def protected_atom(text):
    text = unicodedata.normalize("NFC", text)
    if text.lower().startswith(("https://", "http://")):
        parsed = urlsplit(text)
        # Scheme/host are insensitive; path/query/fragment retain their case.
        return "url:" + urlunsplit((parsed.scheme.lower(), parsed.netloc.lower(), parsed.path, parsed.query, parsed.fragment))
    return "code:" + text


def surface_tokens(text):
    output, start = [], 0
    for match in ATOM.finditer(text):
        output.extend(surface_words(text[start:match.start()]))
        output.append(protected_atom(match.group()))
        start = match.end()
    output.extend(surface_words(text[start:]))
    return output


def query_kind(text):
    trimmed = text.strip()
    if len(trimmed) > 1 and trimmed[0] == trimmed[-1] == '"':
        return "quoted"
    if ATOM.fullmatch(trimmed):
        return "literal"
    return "natural"


def query_body(text):
    return text.strip()[1:-1] if query_kind(text) == "quoted" else text.strip()


def script(char):
    if not unicodedata.category(char).startswith("L"):
        return None
    name = unicodedata.name(char, "")
    for key in ("LATIN", "CYRILLIC", "ARABIC", "HEBREW", "GREEK", "DEVANAGARI", "HANGUL", "THAI", "KHMER"):
        if key in name:
            return key.title()
    if "HIRAGANA" in name or "KATAKANA" in name:
        return "Kana"
    if "CJK" in name or "IDEOGRAPH" in name:
        return "Han"
    return "Other"


def script_candidates(text, enabled):
    seen = {script(char) for char in text} - {None}
    selected = {code for code in enabled if LANGUAGE_SCRIPTS.get(code) in seen}
    if "Kana" in seen:
        selected.add("ja")
    return selected & set(enabled)


def script_spans(text):
    spans, current, active = [], [], None
    for char in text:
        observed = script(char)
        # Han and Kana coexist naturally within Japanese words/sentences.
        compatible = observed in {None, active} or {observed, active} <= {"Han", "Kana"}
        if current and not compatible:
            spans.append("".join(current))
            current = []
        current.append(char)
        if observed is not None:
            active = "Kana" if observed == "Kana" or active == "Kana" and observed == "Han" else observed
    if current:
        spans.append("".join(current))
    return [span for span in spans if any(word_character(char) for char in span)]


def pick_language(text, context, detection, enabled, confidence=0.6, minimum_letters=20):
    candidates = script_candidates(text, enabled)
    if len(candidates) == 1:
        return next(iter(candidates))
    detected = language((detection or {}).get("language"))
    letters = sum(unicodedata.category(char).startswith("L") for char in text)
    if detected in candidates and letters >= minimum_letters and (detection or {}).get("confidence", 0) >= confidence:
        return detected
    if context in candidates:
        return context
    return "und"


def query_languages(policy, query, detections, enabled, config):
    text = query_body(query["text"])
    detection = (detections.get(detector_text(text)) or {}).get("detection") or {}
    if policy == "hard":
        observed = language(detection.get("language"))
        return [observed if observed in enabled else "und"]
    if policy == "fanout":
        return sorted(script_candidates(text, enabled) | {"und"})
    return [pick_language(text, query.get("context_language"), detection, enabled,
                          config["confidence"], config["minimum_letters"])]


def document_units(document, policy, detections, enabled, config):
    fields = field_texts(document)
    if policy == "hard":
        detection = (detections.get(detector_text(fields["body"])) or {}).get("detection") or {}
        observed = language(detection.get("language"))
        selected = observed if observed in enabled else "und"
        return [(field, text, selected) for field, text in fields.items() if text]
    units = []
    for field, text in fields.items():
        for paragraph in text.splitlines():
            for span in script_spans(paragraph):
                detection = (detections.get(detector_text(span)) or {}).get("detection") or {}
                selected = pick_language(span, document.get("notebook_language"), detection, enabled,
                                         config["confidence"], config["minimum_letters"])
                units.append((field, span, selected))
    return units


def encode(token):
    return "t" + token.encode().hex()


def validate_analyzer_response(text, response):
    if not isinstance(response.get("fingerprint"), str) or not response["fingerprint"]:
        raise ValueError("Analyzer response needs a stable fingerprint")
    if response.get("offset_unit") != "utf8_bytes":
        raise ValueError("Analyzer response must identify UTF-8 byte offsets")
    boundaries, total, previous = {0}, 0, -1
    for char in text:
        total += len(char.encode())
        boundaries.add(total)
    for token in response["tokens"]:
        start, end = token["start"], token["end"]
        if (not isinstance(token["text"], str) or not isinstance(start, int) or not isinstance(end, int)
                or start not in boundaries or end not in boundaries or not start <= end):
            raise ValueError("Analyzer returned invalid token text or UTF-8 offsets")
        position = token.get("position")
        if not isinstance(position, int) or position != previous + 1 or token.get("colocated", False):
            raise ValueError("This diagnostic requires flat, consecutive token positions")
        previous = position


def expression(tokens, operation="OR", phrase=False):
    tokens = list(dict.fromkeys(tokens)) if not phrase else list(tokens)
    if not tokens:
        return ""
    if phrase:
        return '"' + " ".join(map(encode, tokens)) + '"'
    return (" " + operation + " ").join('"' + encode(token) + '"' for token in tokens)


class Index:
    """Encoded tokens preserve the selected analyzer's identity on older SQLite."""

    def __init__(self, documents, rows, raw=False):
        self.db = sqlite3.connect(":memory:")
        self.documents = sorted(documents, key=lambda document: hashlib.sha256(document["id"].encode()).hexdigest())
        self.ids = {index: document["id"] for index, document in enumerate(self.documents, 1)}
        tokenizer = "porter unicode61 remove_diacritics 2" if raw else "unicode61"
        self.db.execute(f"CREATE VIRTUAL TABLE f USING fts5(body,title,author,url,codes,tokenize='{tokenizer}')")
        for rowid, document in enumerate(self.documents, 1):
            content = rows.get(document["id"], {})
            if not any(content.values()):
                continue
            values = [content.get(field, "") if raw else " ".join(map(encode, content.get(field, []))) for field in FIELDS]
            self.db.execute("INSERT INTO f(rowid,body,title,author,url,codes) VALUES (?,?,?,?,?,?)", (rowid, *values))
        self.db.commit()

    def rank(self, query_expression, depth=100):
        if not query_expression:
            return []
        rows = self.db.execute("SELECT rowid FROM f WHERE f MATCH ? ORDER BY bm25(f,1.0,2.0,1.0,1.0,1.0),rowid LIMIT ?", (query_expression, depth)).fetchall()
        return [self.ids[rowid] for (rowid,) in rows]

    def close(self):
        self.db.close()


def rrf(rankings, k=60, depth=100):
    scores = collections.defaultdict(float)
    for ranking in rankings:
        for position, docid in enumerate(dict.fromkeys(ranking), 1):
            scores[docid] += 1.0 / (k + position)
    return sorted(scores, key=lambda docid: (-scores[docid], hashlib.sha256(docid.encode()).hexdigest()))[:depth]


def surface_priority(complete_surface, surface, normalized, kind, k=60, depth=100):
    if kind in {"quoted", "literal"}:
        return surface[:depth]
    combined = rrf([surface, normalized], k=k, depth=depth)
    return list(dict.fromkeys([*complete_surface, *combined]))[:depth]


def score(ranking, query, documents, depth=10):
    relevance = query["relevance"]
    compatible = set(query.get("compatible", []))
    top = ranking[:depth]
    required = set(relevance)
    negative = [docid for docid in top if docid not in required and docid not in compatible]
    scores = {
        "returned@10": len(top),
        "confirmedNegativeCount@10": len(negative),
        "anyConfirmedNegative@10": int(bool(negative)),
        "compatibleCount@10": sum(docid in compatible for docid in top),
    }
    if not required:
        scores["noRelevantFalseResult"] = int(bool(ranking))
        return scores
    scores["precisionLower@10"] = sum(docid in required for docid in top) / depth
    scores["precisionUpper@10"] = sum(docid in required or docid in compatible for docid in top) / depth
    hits = [index + 1 for index, docid in enumerate(ranking) if docid in required]
    scores["requiredRecall@10"] = sum(position <= depth for position in hits) / len(required)
    scores["requiredRecall@100"] = sum(position <= 100 for position in hits) / len(required)
    scores["requiredMRR@10"] = 1.0 / hits[0] if hits and hits[0] <= depth else 0.0
    scores["requiredTop1"] = int(bool(ranking) and ranking[0] in required)
    # Compatible alternatives have incomplete semantic judgments. Condense them
    # out of nDCG only; original-rank target recall and precision bounds remain.
    judged = [docid for docid in ranking if docid not in compatible][:depth]
    dcg = sum((2 ** relevance.get(docid, 0) - 1) / math.log2(index + 2) for index, docid in enumerate(judged))
    ideal = sum((2 ** grade - 1) / math.log2(index + 2) for index, grade in enumerate(sorted(relevance.values(), reverse=True)[:depth]))
    scores["condensedRequiredNDCG@10"] = dcg / ideal if ideal else 0.0
    mixed = {docid for docid in required if documents[docid].get("mixed")}
    if mixed:
        scores["mixedRequiredRecall@10"] = len(mixed & set(top)) / len(mixed)
    return scores


def aggregate(rows):
    metrics = collections.defaultdict(list)
    for row in rows:
        for key, value in row.items():
            metrics[key].append(value)
    return {"queries": len(rows), **{key: {"mean": sum(values) / len(values), "queries": len(values)} for key, values in sorted(metrics.items())}}


def validate(fixture):
    if fixture.get("schema_version") != 1 or len(set(fixture["languages"])) != len(fixture["languages"]):
        raise ValueError("Unsupported or inconsistent fixture schema")
    seen_docs, seen_queries, summary = set(), set(), {}
    for split in ("development", "heldout"):
        part = fixture["splits"][split]
        documents, queries = part["documents"], part["queries"]
        ids = {document["id"] for document in documents}
        if len(ids) != len(documents) or ids & seen_docs:
            raise ValueError("Document IDs must be unique and disjoint across splits")
        seen_docs |= ids
        for document in documents:
            if not document.get("synthetic") or not all(isinstance(document[field], str) for field in FIELDS if field != "codes"):
                raise ValueError("Invalid synthetic document fields")
            if not set(document["truth_languages"]) <= set(fixture["languages"]):
                raise ValueError("Unknown truth language")
            if not document["url"].startswith("https://example.org/"):
                raise ValueError("Fixtures use only reserved example.org URLs")
        query_ids = {query["id"] for query in queries}
        if len(query_ids) != len(queries) or query_ids & seen_queries:
            raise ValueError("Query IDs must be unique and disjoint across splits")
        seen_queries |= query_ids
        for query in queries:
            if not query["text"] or not query["rationale"]:
                raise ValueError("Every query needs text and a relevance rationale")
            required, compatible = set(query["relevance"]), set(query.get("compatible", []))
            if not (required | compatible) <= ids or required & compatible:
                raise ValueError("Invalid relevance/compatible references")
            if any(not isinstance(grade, int) or not 1 <= grade <= 3 for grade in query["relevance"].values()):
                raise ValueError("Relevance grades must be integers 1..3")
        summary[split] = {"documents": len(documents), "queries": len(queries),
                          "languages": len({code for document in documents for code in document["truth_languages"]}),
                          "mixedDocuments": sum(bool(document.get("mixed")) for document in documents),
                          "noRelevantQueries": sum(not query["relevance"] for query in queries),
                          "meanBodyCharacters": sum(len(document["body"]) for document in documents) / len(documents),
                          "categories": dict(collections.Counter(query["category"] for query in queries))}
    return summary
