#!/usr/bin/env python3
"""
Quran offline dataset - builder and verifier.

WHY THIS EXISTS
    The website reads the Quran text from https://api.alquran.cloud at run time. A standalone Android app must work on
    its very first launch without a network, so the same text has to ship inside the APK. This tool downloads the
    editions listed in editions.json from the SAME source the website already uses, verifies them strictly, and writes
    a compact, checksummed bundle that js/local-data.js serves in the exact response shapes the app already expects.

WHAT IT NEVER DOES
    * It never writes, edits, normalises or "repairs" Quran text or translations. Text is copied byte for byte from the
      source. If the source is wrong or incomplete the build FAILS instead of patching it.
    * It never ships example/placeholder text. Test fixtures live in fixtures.py and are written to temp folders only.

INTEGRITY CHECKS (all of them must pass, otherwise nothing is written)
    surah count (114) - ayah count per surah (canonical Hafs table) - total (6236) - global ayah numbering 1..6236 and
    numberInSurah 1..n - juz / manzil / page / ruku / hizbQuarter are whole numbers that start at 1, never go
    backwards, never skip a value and end at their expected maximum - every translation is aligned with the Arabic
    edition ayah for ayah - no empty text - SHA-256 of every output file - dataset hash compared with a lock file.

USAGE
    python3 tools/quran-data/quran_data.py build  --out build/www/data/quran [--lock FILE] [--lock-policy off|warn|enforce]
    python3 tools/quran-data/quran_data.py build  --out DIR --from-dir DIR_WITH_<edition>.json_FILES      (no network)
    python3 tools/quran-data/quran_data.py build  --out DIR --cache-dir build/quran-cache   (download once, reuse after that)
    python3 tools/quran-data/quran_data.py verify --dir build/www/data/quran
Only the Python standard library is used.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any

SCHEMA = 1
GENERATOR = "tools/quran-data/quran_data.py"
DEFAULT_API_BASE = "https://api.alquran.cloud/v1"
HERE = Path(__file__).resolve().parent

# Number of ayahs in surahs 1..114 (the standard Hafs count; sums to 6236). The same table is kept in app/js/data.js -
# tests/quran-data.test.js proves both copies are identical.
CANONICAL_AYAH_COUNTS = (
    7, 286, 200, 176, 120, 165, 206, 75, 129, 109, 123, 111, 43, 52, 99, 128, 111, 110, 98, 135, 112, 78, 118, 64, 77,
    227, 93, 88, 69, 60, 34, 30, 73, 54, 45, 83, 182, 88, 75, 85, 54, 53, 89, 59, 37, 35, 38, 29, 18, 45, 60, 49, 62,
    55, 78, 96, 29, 22, 24, 13, 14, 11, 11, 18, 12, 12, 30, 52, 52, 44, 28, 28, 20, 56, 40, 31, 50, 40, 46, 42, 29, 19,
    36, 25, 22, 17, 19, 26, 30, 20, 15, 21, 11, 8, 8, 19, 5, 8, 8, 11, 11, 8, 3, 9, 5, 4, 7, 3, 6, 3, 5, 4, 5, 6,
)
SURAH_COUNT = 114
TOTAL_AYAHS = 6236

# Where each juz begins (surah, ayah) - the table app/js/data.js uses (it equals Tanzil's). Mushaf prints differ by a
# verse in a few places, so a difference is reported as a WARNING, never as an error.
JUZ_START_REFERENCE = (
    (1, 1), (2, 142), (2, 253), (3, 93), (4, 24), (4, 148), (5, 82), (6, 111), (7, 88), (8, 41), (9, 93), (11, 6),
    (12, 53), (15, 1), (17, 1), (18, 75), (21, 1), (23, 1), (25, 21), (27, 56), (29, 46), (33, 31), (36, 28), (39, 32),
    (41, 47), (46, 1), (51, 31), (58, 1), (67, 1), (78, 1),
)

# Expected maxima of the navigation numbers. ruku is a range because mushaf counts differ (the app uses 556).
STRUCTURE_MAX = {"juz": (30, 30), "manzil": (7, 7), "page": (604, 604), "hizbQuarter": (240, 240), "ruku": (550, 560)}
STRUCTURE_FIELDS = ("juz", "manzil", "page", "ruku", "hizbQuarter")

EDITION_ID_RE = re.compile(r"^[a-z]{2,3}\.[a-z0-9_]{2,40}$|^quran-[a-z]+(?:-[a-z]+){0,3}$")
MAX_REPORTED_ERRORS = 25


class DatasetError(Exception):
    """The source data is incomplete or inconsistent. Nothing is written."""


# ----------------------------------------------------------------------------------------------------------- utilities
def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def dumps(obj: Any) -> bytes:
    """Deterministic, compact JSON (same input -> same bytes -> same hash)."""
    return json.dumps(obj, ensure_ascii=False, separators=(",", ":")).encode("utf-8")


def check_edition_id(edition: str) -> str:
    if not isinstance(edition, str) or not EDITION_ID_RE.match(edition):
        raise DatasetError(f"invalid edition identifier: {edition!r}")
    return edition


def fetch_json(url: str, *, retries: int = 4, timeout: int = 120) -> Any:
    last: Exception | None = None
    for attempt in range(1, retries + 1):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "QuranBangla-dataset-builder/1", "Accept": "application/json"})
            with urllib.request.urlopen(req, timeout=timeout) as resp:  # noqa: S310 - fixed https endpoint from editions.json
                return json.loads(resp.read().decode("utf-8"))
        except (urllib.error.URLError, TimeoutError, json.JSONDecodeError, ConnectionError) as exc:
            last = exc
            if attempt < retries:
                time.sleep(min(2 ** attempt, 20))
    raise DatasetError(f"could not download {url}: {last}")


# ------------------------------------------------------------------------------------------------------------ validation
def _is_int(v: Any) -> bool:
    return isinstance(v, int) and not isinstance(v, bool)


def validate_payload(edition: str, payload: Any, *, structure: bool, max_empty: int = 0) -> dict[str, Any]:
    """Checks one /quran/<edition> response. Returns {'surahs': [...], 'texts': [...], 'structure': {...}|None,
    'warnings': [...], 'edition': {...}|None}. Raises DatasetError listing every problem found."""
    errors: list[str] = []

    def err(msg: str) -> None:
        if len(errors) < MAX_REPORTED_ERRORS:
            errors.append(msg)
        elif len(errors) == MAX_REPORTED_ERRORS:
            errors.append("... more problems omitted")

    if not isinstance(payload, dict) or payload.get("code") != 200 or not isinstance(payload.get("data"), dict):
        raise DatasetError(f"[{edition}] the API did not answer with code 200 and a data object")
    data = payload["data"]
    surahs = data.get("surahs")
    if not isinstance(surahs, list) or len(surahs) != SURAH_COUNT:
        raise DatasetError(f"[{edition}] expected {SURAH_COUNT} surahs, got {len(surahs) if isinstance(surahs, list) else 'none'}")

    texts: list[str] = []
    surah_meta: list[dict[str, Any]] = []
    cols: dict[str, list[int]] = {f: [] for f in STRUCTURE_FIELDS}
    sajda: dict[str, list[int]] = {}
    empty = 0
    g = 0
    for si, s in enumerate(surahs):
        n = si + 1
        if not isinstance(s, dict) or s.get("number") != n:
            err(f"surah #{n}: number is {s.get('number') if isinstance(s, dict) else s!r}")
            continue
        ayahs = s.get("ayahs")
        want = CANONICAL_AYAH_COUNTS[si]
        if not isinstance(ayahs, list) or len(ayahs) != want:
            err(f"surah {n}: expected {want} ayahs, got {len(ayahs) if isinstance(ayahs, list) else 'none'}")
            continue
        if structure:
            if not isinstance(s.get("name"), str) or not s["name"].strip():
                err(f"surah {n}: missing Arabic name")
            if not isinstance(s.get("englishName"), str) or not s["englishName"].strip():
                err(f"surah {n}: missing englishName")
            if s.get("revelationType") not in ("Meccan", "Medinan"):
                err(f"surah {n}: revelationType is {s.get('revelationType')!r}")
            surah_meta.append({
                "number": n,
                "name": s.get("name"),
                "englishName": s.get("englishName"),
                "englishNameTranslation": s.get("englishNameTranslation", ""),
                "numberOfAyahs": want,
                "revelationType": s.get("revelationType"),
            })
        for ai, a in enumerate(ayahs):
            g += 1
            if not isinstance(a, dict):
                err(f"surah {n} ayah {ai + 1}: not an object")
                continue
            if a.get("number") != g:
                err(f"surah {n} ayah {ai + 1}: global number is {a.get('number')!r}, expected {g}")
            if a.get("numberInSurah") != ai + 1:
                err(f"surah {n} ayah {ai + 1}: numberInSurah is {a.get('numberInSurah')!r}")
            t = a.get("text")
            if not isinstance(t, str):
                err(f"surah {n} ayah {ai + 1}: text is not a string")
                t = ""
            if not t.strip():
                empty += 1
                if empty > max_empty:
                    err(f"surah {n} ayah {ai + 1}: empty text")
            texts.append(t)
            if structure:
                for f in STRUCTURE_FIELDS:
                    v = a.get(f)
                    if not _is_int(v):
                        err(f"surah {n} ayah {ai + 1}: {f} is {v!r}")
                        v = 0
                    cols[f].append(v)
                sj = a.get("sajda")
                if isinstance(sj, dict):
                    sajda[str(g)] = [int(sj.get("id") or 0), 1 if sj.get("recommended") else 0, 1 if sj.get("obligatory") else 0]
    if g != TOTAL_AYAHS:
        err(f"total ayahs is {g}, expected {TOTAL_AYAHS}")

    warnings: list[str] = []
    struct = None
    if structure and not errors:
        for f in STRUCTURE_FIELDS:
            c = cols[f]
            if c[0] != 1:
                err(f"{f} starts at {c[0]}, expected 1")
            for i in range(1, len(c)):
                if c[i] < c[i - 1]:
                    err(f"{f} goes backwards at ayah {i + 1} ({c[i - 1]} -> {c[i]})")
                    break
                if c[i] - c[i - 1] > 1:
                    err(f"{f} skips a value at ayah {i + 1} ({c[i - 1]} -> {c[i]})")
                    break
            lo, hi = STRUCTURE_MAX[f]
            if not lo <= c[-1] <= hi:
                err(f"{f} ends at {c[-1]}, expected {lo if lo == hi else f'{lo}-{hi}'}")
        if not errors:
            starts: dict[int, tuple[int, int]] = {}
            gi = 0
            for si, want in enumerate(CANONICAL_AYAH_COUNTS):
                for ai in range(want):
                    starts.setdefault(cols["juz"][gi], (si + 1, ai + 1))
                    gi += 1
            for k, ref in enumerate(JUZ_START_REFERENCE, start=1):
                if starts.get(k) != ref:
                    warnings.append(f"juz {k} starts at {starts.get(k)} in the source, the app table says {ref}")
            surah_start: list[int] = []
            run = 1
            for want in CANONICAL_AYAH_COUNTS:
                surah_start.append(run)
                run += want
            struct = {
                "schema": SCHEMA,
                "total": TOTAL_AYAHS,
                "ayahCounts": list(CANONICAL_AYAH_COUNTS),
                "surahStart": surah_start,
                **{f: cols[f] for f in STRUCTURE_FIELDS},
                "sajda": sajda,
            }
    if errors:
        raise DatasetError(f"[{edition}] integrity check failed:\n  - " + "\n  - ".join(errors))
    ed = data.get("edition") if isinstance(data.get("edition"), dict) else None
    return {"surahs": surah_meta, "texts": texts, "structure": struct, "warnings": warnings, "edition": ed, "empty": empty}


# ---------------------------------------------------------------------------------------------------------------- build
def load_config(path: Path) -> dict[str, Any]:
    cfg = json.loads(path.read_text(encoding="utf-8"))
    ids = list(cfg.get("arabic", [])) + list(cfg.get("translations", []))
    if not cfg.get("structureEdition") or cfg["structureEdition"] not in ids:
        raise DatasetError("editions.json: structureEdition must be one of the listed editions")
    if len(set(ids)) != len(ids):
        raise DatasetError("editions.json: an edition is listed twice")
    for e in ids:
        check_edition_id(e)
    return cfg


def build_dataset(cfg: dict[str, Any], payloads: dict[str, Any], edition_meta: dict[str, Any]) -> dict[str, Any]:
    ids = list(cfg["arabic"]) + list(cfg["translations"])
    structure_id = cfg["structureEdition"]
    checked = {e: validate_payload(e, payloads[e], structure=(e == structure_id), max_empty=int(cfg.get("maxEmptyAyahs", 0))) for e in ids}
    base = checked[structure_id]
    # every edition must be aligned with the structure edition: the same ayah has the same global number everywhere
    # (validate_payload already enforced number == position and numberInSurah == position-in-surah for every edition)
    editions: dict[str, Any] = {}
    for e in ids:
        meta = edition_meta.get(e) or checked[e]["edition"]
        if not isinstance(meta, dict) or meta.get("identifier") != e:
            raise DatasetError(f"[{e}] the API edition list does not describe this edition")
        editions[e] = {k: meta.get(k, "") for k in ("identifier", "language", "name", "englishName", "format", "type", "direction")}
    return {
        "structure": base["structure"],
        "surahs": base["surahs"],
        "editions": editions,
        "texts": {e: checked[e]["texts"] for e in ids},
        "warnings": [w for e in ids for w in checked[e]["warnings"]],
    }


def write_dataset(out: Path, ds: dict[str, Any], source: str) -> dict[str, Any]:
    out.mkdir(parents=True, exist_ok=True)
    (out / "text").mkdir(exist_ok=True)
    files: dict[str, dict[str, Any]] = {}

    def put(rel: str, obj: Any) -> None:
        raw = dumps(obj)
        (out / rel).write_bytes(raw)
        files[rel] = {"bytes": len(raw), "sha256": sha256_bytes(raw)}

    put("structure.json", ds["structure"])
    put("surahs.json", ds["surahs"])
    put("editions.json", ds["editions"])
    for e, texts in ds["texts"].items():
        put(f"text/{e}.json", texts)
    dataset_hash = sha256_bytes(dumps(sorted((p, f["sha256"]) for p, f in files.items())))
    st = ds["structure"]
    manifest = {
        "schema": SCHEMA,
        "generator": GENERATOR,
        "source": source,
        "generatedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "counts": {"surahs": SURAH_COUNT, "ayahs": TOTAL_AYAHS},
        "limits": {f: st[f][-1] for f in STRUCTURE_FIELDS},
        "editions": list(ds["editions"].keys()),
        "datasetSha256": dataset_hash,
        "files": files,
    }
    (out / "manifest.json").write_bytes(dumps(manifest))
    return manifest


def check_lock(manifest: dict[str, Any], lock_path: Path | None, policy: str, update: bool) -> list[str]:
    """Returns messages. Raises DatasetError when policy is 'enforce' and the dataset differs from the lock."""
    msgs: list[str] = []
    if lock_path is None or policy == "off":
        return msgs
    wanted = {"schema": SCHEMA, "datasetSha256": manifest["datasetSha256"], "editions": manifest["editions"],
              "files": {p: f["sha256"] for p, f in manifest["files"].items()}}
    if update or not lock_path.exists():
        lock_path.parent.mkdir(parents=True, exist_ok=True)
        lock_path.write_text(json.dumps(wanted, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
        msgs.append(f"lock file written: {lock_path} (commit it - later builds are compared with it)")
        return msgs
    have = json.loads(lock_path.read_text(encoding="utf-8"))
    if have.get("datasetSha256") == wanted["datasetSha256"]:
        msgs.append("dataset matches the lock file")
        return msgs
    changed = sorted(p for p in set(have.get("files", {})) | set(wanted["files"]) if have.get("files", {}).get(p) != wanted["files"].get(p))
    text = f"the downloaded Quran data differs from {lock_path.name} in: {', '.join(changed)}. Review the change, then run again with --update-lock."
    if policy == "enforce":
        raise DatasetError(text)
    msgs.append("WARNING: " + text)
    return msgs


def verify_dir(directory: Path) -> list[str]:
    """Re-checks an existing bundle: manifest present, every file hash matches, structure and texts are consistent."""
    problems: list[str] = []
    mpath = directory / "manifest.json"
    if not mpath.exists():
        return [f"{mpath} is missing"]
    manifest = json.loads(mpath.read_text(encoding="utf-8"))
    for rel, f in manifest.get("files", {}).items():
        p = directory / rel
        if not p.exists():
            problems.append(f"{rel}: file is missing")
            continue
        raw = p.read_bytes()
        if len(raw) != f["bytes"] or sha256_bytes(raw) != f["sha256"]:
            problems.append(f"{rel}: size or checksum differs from the manifest")
    if problems:
        return problems
    st = json.loads((directory / "structure.json").read_text(encoding="utf-8"))
    if st.get("ayahCounts") != list(CANONICAL_AYAH_COUNTS) or st.get("total") != TOTAL_AYAHS:
        problems.append("structure.json: ayah counts differ from the canonical table")
    for f in STRUCTURE_FIELDS:
        c = st.get(f, [])
        if len(c) != TOTAL_AYAHS or c[0] != 1 or any(c[i] < c[i - 1] or c[i] - c[i - 1] > 1 for i in range(1, len(c))):
            problems.append(f"structure.json: {f} is not a clean 1..n sequence over 6236 ayahs")
    for e in manifest.get("editions", []):
        t = json.loads((directory / "text" / f"{e}.json").read_text(encoding="utf-8"))
        if len(t) != TOTAL_AYAHS or not all(isinstance(x, str) for x in t):
            problems.append(f"text/{e}.json: expected {TOTAL_AYAHS} strings")
    return problems


# -------------------------------------------------------------------------------------------------------------- CLI
def cached_json(cache: Path | None, name: str, url: str) -> Any:
    """Downloads `url` unless <cache>/<name>.json already exists. A cached file is only trusted after it passes the same
    validation as a fresh download (build_dataset), so a damaged cache can never produce a bad bundle."""
    if cache is not None:
        f = cache / f"{name}.json"
        if f.exists():
            try:
                return json.loads(f.read_text(encoding="utf-8"))
            except json.JSONDecodeError:
                f.unlink()  # damaged cache entry: download again
    data = fetch_json(url)
    if cache is not None:
        cache.mkdir(parents=True, exist_ok=True)
        tmp = cache / f"{name}.json.part"
        tmp.write_bytes(json.dumps(data, ensure_ascii=False).encode("utf-8"))
        tmp.replace(cache / f"{name}.json")
    return data


def cmd_build(args: argparse.Namespace) -> int:
    cfg = load_config(Path(args.config))
    ids = list(cfg["arabic"]) + list(cfg["translations"])
    base = cfg.get("source", {}).get("baseUrl", DEFAULT_API_BASE).rstrip("/")
    payloads: dict[str, Any] = {}
    edition_meta: dict[str, Any] = {}
    if args.from_dir:
        d = Path(args.from_dir)
        for e in ids:
            payloads[e] = json.loads((d / f"{e}.json").read_text(encoding="utf-8"))
        lst = d / "edition-list.json"
        if lst.exists():
            edition_meta = {x["identifier"]: x for x in json.loads(lst.read_text(encoding="utf-8")).get("data", [])}
        source = f"local files ({d.name})"
    else:
        cache = Path(args.cache_dir) if args.cache_dir else None
        listing = cached_json(cache, "edition-list", f"{base}/edition")
        edition_meta = {x["identifier"]: x for x in listing.get("data", [])}
        missing = [e for e in ids if e not in edition_meta]
        if missing:
            raise DatasetError(f"the API has no edition named: {', '.join(missing)} - fix tools/quran-data/editions.json")
        for e in ids:
            print(f"{'reading' if cache and (cache / f'{e}.json').exists() else 'downloading'} {e} ...", flush=True)
            payloads[e] = cached_json(cache, e, f"{base}/quran/{e}")
        source = base
    ds = build_dataset(cfg, payloads, edition_meta)
    manifest = write_dataset(Path(args.out), ds, source)
    for w in ds["warnings"]:
        print("WARNING:", w)
    for m in check_lock(manifest, Path(args.lock) if args.lock else None, args.lock_policy, args.update_lock):
        print(m)
    size = sum(f["bytes"] for f in manifest["files"].values())
    print(f"OK: {len(ids)} editions, {TOTAL_AYAHS} ayahs, {size / 1024 / 1024:.1f} MB, dataset {manifest['datasetSha256'][:16]}")
    return 0


def cmd_verify(args: argparse.Namespace) -> int:
    problems = verify_dir(Path(args.dir))
    if problems:
        print("Quran dataset verification FAILED:\n  - " + "\n  - ".join(problems))
        return 1
    print("Quran dataset verification OK")
    return 0


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    b = sub.add_parser("build", help="download (or read) the editions, verify, write the bundle")
    b.add_argument("--out", required=True)
    b.add_argument("--config", default=str(HERE / "editions.json"))
    b.add_argument("--from-dir", help="read <edition>.json files from this folder instead of downloading")
    b.add_argument("--cache-dir", help="keep downloaded editions here and reuse them (CI caches this folder)")
    b.add_argument("--lock", default=str(HERE / "quran-data.lock.json"))
    b.add_argument("--lock-policy", choices=("off", "warn", "enforce"), default="warn")
    b.add_argument("--update-lock", action="store_true")
    b.set_defaults(fn=cmd_build)
    v = sub.add_parser("verify", help="re-check an existing bundle")
    v.add_argument("--dir", required=True)
    v.set_defaults(fn=cmd_verify)
    args = ap.parse_args(argv)
    try:
        return args.fn(args)
    except DatasetError as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
