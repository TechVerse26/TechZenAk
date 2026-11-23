#!/usr/bin/env python3
"""
TEST FIXTURES ONLY - never shipped, never copied into the app.

Generates structurally valid but obviously artificial Al Quran Cloud style payloads (every text says "fixture"), so the
builder, the validator and js/local-data.js can be tested without a network. Real Quran text only ever comes from the
real source through quran_data.py build.

    python3 tools/quran-data/fixtures.py <output-dir>
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

from quran_data import CANONICAL_AYAH_COUNTS, TOTAL_AYAHS

EDITIONS = {
    "quran-uthmani": {"language": "ar", "name": "fixture arabic", "englishName": "Fixture Arabic", "type": "quran", "direction": "rtl"},
    "quran-simple-clean": {"language": "ar", "name": "fixture arabic clean", "englishName": "Fixture Arabic Clean", "type": "quran", "direction": "rtl"},
    "bn.bengali": {"language": "bn", "name": "fixture bengali", "englishName": "Fixture Bengali", "type": "translation", "direction": "ltr"},
    "en.sahih": {"language": "en", "name": "fixture english", "englishName": "Fixture English", "type": "translation", "direction": "ltr"},
}
WORD = {"ar": "اختبار", "bn": "পরীক্ষা", "en": "fixture"}


def edition_meta(identifier: str) -> dict:
    e = EDITIONS[identifier]
    return {"identifier": identifier, "language": e["language"], "name": e["name"], "englishName": e["englishName"],
            "format": "text", "type": e["type"], "direction": e["direction"]}


def make_payload(identifier: str, *, mutate=None) -> dict:
    lang = EDITIONS[identifier]["language"]
    surahs, g = [], 0
    for si, count in enumerate(CANONICAL_AYAH_COUNTS):
        ayahs = []
        for ai in range(count):
            g += 1
            ayah = {
                "number": g,
                "text": f"{WORD[lang]} {identifier} {si + 1}:{ai + 1}",
                "numberInSurah": ai + 1,
                "juz": 1 + (g - 1) * 30 // TOTAL_AYAHS,
                "manzil": 1 + (g - 1) * 7 // TOTAL_AYAHS,
                "page": 1 + (g - 1) * 604 // TOTAL_AYAHS,
                "ruku": 1 + (g - 1) * 556 // TOTAL_AYAHS,
                "hizbQuarter": 1 + (g - 1) * 240 // TOTAL_AYAHS,
                "sajda": {"id": 1, "recommended": True, "obligatory": False} if g == 1160 else False,
            }
            ayahs.append(ayah)
        surahs.append({"number": si + 1, "name": f"سورة {si + 1}", "englishName": f"Fixture {si + 1}",
                       "englishNameTranslation": f"fixture {si + 1}", "revelationType": "Meccan" if si % 2 == 0 else "Medinan",
                       "ayahs": ayahs})
    payload = {"code": 200, "status": "OK", "data": {"surahs": surahs, "edition": edition_meta(identifier)}}
    if mutate:
        mutate(payload)
    return payload


def write_all(directory: Path) -> None:
    directory.mkdir(parents=True, exist_ok=True)
    for identifier in EDITIONS:
        (directory / f"{identifier}.json").write_text(json.dumps(make_payload(identifier), ensure_ascii=False), encoding="utf-8")
    listing = {"code": 200, "status": "OK", "data": [edition_meta(i) for i in EDITIONS]}
    (directory / "edition-list.json").write_text(json.dumps(listing, ensure_ascii=False), encoding="utf-8")


if __name__ == "__main__":
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    write_all(Path(sys.argv[1]))
    print("fixtures written to", sys.argv[1])
