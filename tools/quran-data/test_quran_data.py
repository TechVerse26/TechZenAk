"""Unit tests for quran_data.py (run: python3 -m unittest discover -s tools/quran-data -p 'test_*.py')."""
import copy
import json
import tempfile
import unittest
from pathlib import Path

import fixtures
import quran_data as qd

CFG = {"arabic": ["quran-uthmani", "quran-simple-clean"], "translations": ["bn.bengali", "en.sahih"],
       "structureEdition": "quran-uthmani", "maxEmptyAyahs": 0}


def payloads(**mutations):
    out = {}
    for e in fixtures.EDITIONS:
        out[e] = fixtures.make_payload(e, mutate=mutations.get(e))
    return out


def meta():
    return {e: fixtures.edition_meta(e) for e in fixtures.EDITIONS}


class CanonicalTable(unittest.TestCase):
    def test_table_shape(self):
        self.assertEqual(len(qd.CANONICAL_AYAH_COUNTS), 114)
        self.assertEqual(sum(qd.CANONICAL_AYAH_COUNTS), 6236)
        self.assertEqual(len(qd.JUZ_START_REFERENCE), 30)

    def test_edition_ids_are_safe_filenames(self):
        for bad in ("../x", "a/b", "BN.bengali", "", "bn.", "quran-"):
            with self.assertRaises(qd.DatasetError):
                qd.check_edition_id(bad)
        for good in ("bn.bengali", "en.sahih", "quran-uthmani", "quran-simple-clean"):
            self.assertEqual(qd.check_edition_id(good), good)


class Validation(unittest.TestCase):
    def test_valid_fixture_passes(self):
        ds = qd.build_dataset(CFG, payloads(), meta())
        self.assertEqual(len(ds["texts"]["bn.bengali"]), 6236)
        self.assertEqual(ds["structure"]["surahStart"][0], 1)
        self.assertEqual(ds["structure"]["surahStart"][1], 8)
        self.assertEqual(ds["structure"]["juz"][-1], 30)
        self.assertEqual(ds["structure"]["page"][-1], 604)

    def expect_error(self, edition, mutate, fragment):
        with self.assertRaises(qd.DatasetError) as ctx:
            qd.build_dataset(CFG, payloads(**{edition: mutate}), meta())
        self.assertIn(fragment, str(ctx.exception))

    def test_missing_ayah_is_rejected(self):
        self.expect_error("bn.bengali", lambda p: p["data"]["surahs"][1]["ayahs"].pop(), "surah 2: expected 286 ayahs")

    def test_wrong_surah_count_is_rejected(self):
        self.expect_error("en.sahih", lambda p: p["data"]["surahs"].pop(), "expected 114 surahs")

    def test_global_numbering_must_be_continuous(self):
        def m(p): p["data"]["surahs"][0]["ayahs"][3]["number"] = 99
        self.expect_error("quran-uthmani", m, "global number is 99")

    def test_number_in_surah_must_match_position(self):
        def m(p): p["data"]["surahs"][2]["ayahs"][0]["numberInSurah"] = 2
        self.expect_error("quran-simple-clean", m, "numberInSurah")

    def test_empty_text_is_rejected(self):
        def m(p): p["data"]["surahs"][5]["ayahs"][4]["text"] = "   "
        self.expect_error("bn.bengali", m, "empty text")

    def test_non_string_text_is_rejected(self):
        def m(p): p["data"]["surahs"][5]["ayahs"][4]["text"] = None
        self.expect_error("en.sahih", m, "text is not a string")

    def test_page_must_not_skip(self):
        def m(p):
            for s in p["data"]["surahs"][50:]:
                for a in s["ayahs"]:
                    a["page"] += 3
        self.expect_error("quran-uthmani", m, "skips a value")

    def test_juz_must_not_go_backwards(self):
        def m(p): p["data"]["surahs"][10]["ayahs"][0]["juz"] = 1
        self.expect_error("quran-uthmani", m, "goes backwards")

    def test_structure_must_end_at_expected_maximum(self):
        def m(p):
            for s in p["data"]["surahs"]:
                for a in s["ayahs"]:
                    a["manzil"] = min(a["manzil"], 6)
        self.expect_error("quran-uthmani", m, "manzil ends at 6")

    def test_api_error_response_is_rejected(self):
        with self.assertRaises(qd.DatasetError):
            qd.validate_payload("bn.bengali", {"code": 500, "status": "ERROR"}, structure=False)

    def test_unknown_edition_description_is_rejected(self):
        m = meta()
        m["en.sahih"]["identifier"] = "en.other"
        with self.assertRaises(qd.DatasetError):
            qd.build_dataset(CFG, payloads(), m)

    def test_juz_start_difference_is_only_a_warning(self):
        def m(p):
            # move the whole juz 4 start one ayah earlier: structure stays valid, the reference table disagrees
            for s in p["data"]["surahs"][2:3]:
                s["ayahs"][91]["juz"] = 4 if s["ayahs"][93]["juz"] == 4 else s["ayahs"][91]["juz"]
        ds = qd.build_dataset(CFG, payloads(**{"quran-uthmani": m}), meta())
        self.assertIsInstance(ds["warnings"], list)


class Output(unittest.TestCase):
    def build(self, directory, p=None):
        ds = qd.build_dataset(CFG, p or payloads(), meta())
        return ds, qd.write_dataset(Path(directory), ds, "fixture")

    def test_text_is_copied_byte_for_byte(self):
        src = payloads()
        with tempfile.TemporaryDirectory() as d:
            self.build(d, src)
            out = json.loads((Path(d) / "text" / "bn.bengali.json").read_text(encoding="utf-8"))
        want = [a["text"] for s in src["bn.bengali"]["data"]["surahs"] for a in s["ayahs"]]
        self.assertEqual(out, want)

    def test_manifest_hashes_and_determinism(self):
        with tempfile.TemporaryDirectory() as a, tempfile.TemporaryDirectory() as b:
            _, m1 = self.build(a)
            _, m2 = self.build(b)
            self.assertEqual(m1["datasetSha256"], m2["datasetSha256"])
            self.assertEqual(m1["counts"], {"surahs": 114, "ayahs": 6236})
            self.assertEqual(m1["limits"]["page"], 604)
            self.assertEqual(sorted(m1["editions"]), sorted(fixtures.EDITIONS))
            for rel, f in m1["files"].items():
                self.assertEqual(qd.sha256_bytes((Path(a) / rel).read_bytes()), f["sha256"], rel)

    def test_verify_dir_detects_tampering(self):
        with tempfile.TemporaryDirectory() as d:
            self.build(d)
            self.assertEqual(qd.verify_dir(Path(d)), [])
            f = Path(d) / "text" / "en.sahih.json"
            data = json.loads(f.read_text(encoding="utf-8"))
            data[10] = data[10] + "!"
            f.write_text(json.dumps(data, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
            problems = qd.verify_dir(Path(d))
            self.assertTrue(any("en.sahih.json" in p for p in problems), problems)

    def test_verify_dir_detects_missing_manifest(self):
        with tempfile.TemporaryDirectory() as d:
            self.assertTrue(qd.verify_dir(Path(d)))


class LockFile(unittest.TestCase):
    def test_lock_written_then_enforced(self):
        with tempfile.TemporaryDirectory() as d:
            ds = qd.build_dataset(CFG, payloads(), meta())
            m = qd.write_dataset(Path(d) / "out", ds, "fixture")
            lock = Path(d) / "lock.json"
            self.assertTrue(any("lock file written" in x for x in qd.check_lock(m, lock, "enforce", False)))
            self.assertTrue(any("matches" in x for x in qd.check_lock(m, lock, "enforce", False)))
            changed = copy.deepcopy(m)
            changed["datasetSha256"] = "0" * 64
            changed["files"]["text/en.sahih.json"]["sha256"] = "1" * 64
            with self.assertRaises(qd.DatasetError) as ctx:
                qd.check_lock(changed, lock, "enforce", False)
            self.assertIn("text/en.sahih.json", str(ctx.exception))
            self.assertTrue(any(x.startswith("WARNING") for x in qd.check_lock(changed, lock, "warn", False)))
            self.assertEqual(qd.check_lock(changed, lock, "off", False), [])
            qd.check_lock(changed, lock, "enforce", True)  # --update-lock accepts the new data
            self.assertTrue(any("matches" in x for x in qd.check_lock(changed, lock, "enforce", False)))


class CommandLine(unittest.TestCase):
    def test_build_and_verify_commands_offline(self):
        with tempfile.TemporaryDirectory() as d:
            src, out = Path(d) / "src", Path(d) / "out"
            fixtures.write_all(src)
            cfg = Path(d) / "editions.json"
            cfg.write_text(json.dumps(CFG), encoding="utf-8")
            code = qd.main(["build", "--out", str(out), "--config", str(cfg), "--from-dir", str(src), "--lock", str(Path(d) / "l.json")])
            self.assertEqual(code, 0)
            self.assertEqual(qd.main(["verify", "--dir", str(out)]), 0)


class DownloadCache(unittest.TestCase):
    def test_cached_json_downloads_once_and_survives_a_damaged_entry(self):
        calls = []
        original = qd.fetch_json
        qd.fetch_json = lambda url, **k: (calls.append(url), {"code": 200, "n": len(calls)})[1]
        try:
            with tempfile.TemporaryDirectory() as d:
                cache = Path(d) / "c"
                self.assertEqual(qd.cached_json(cache, "x", "u1")["n"], 1)
                self.assertEqual(qd.cached_json(cache, "x", "u1")["n"], 1, "second call is served from the cache")
                self.assertEqual(len(calls), 1)
                (cache / "x.json").write_text("{ broken", encoding="utf-8")
                self.assertEqual(qd.cached_json(cache, "x", "u1")["n"], 2, "a damaged entry is downloaded again")
                self.assertFalse(list(cache.glob("*.part")), "no half-written files are left behind")
                self.assertEqual(qd.cached_json(None, "y", "u2")["n"], 3, "no cache dir: always downloads")
        finally:
            qd.fetch_json = original


if __name__ == "__main__":
    unittest.main()
