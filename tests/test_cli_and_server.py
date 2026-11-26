"""Stdlib integration tests for nj2_editor.py CLI and loopback HTTP server."""

from __future__ import annotations

import base64
import hashlib
import http.client
import json
import os
import re
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

import nj2_editor as E  # noqa: E402

HANZI_RE = re.compile(r"[\u4e00-\u9fff\u3400-\u4dbf]")
KANA_RE = re.compile(r"[\u3040-\u309f\u30a0-\u30ff\u31f0-\u31ff\uff66-\uff9f]")


def run_cli(*args: str, env: dict | None = None) -> subprocess.CompletedProcess:
    merged_env = os.environ.copy()
    if env:
        merged_env.update(env)
    return subprocess.run(
        [sys.executable, str(ROOT / "nj2_editor.py"), *args],
        cwd=str(ROOT),
        env=merged_env,
        capture_output=True,
        text=True,
        encoding="utf-8",
        timeout=30,
    )


class TestCompanionHeader(unittest.TestCase):
    def test_v76_10_strings_and_trailing(self):
        trailing = b"\xde\xad\xbe\xef"
        raw = E.encode_companion_header({
            "name": "\ud55c\uae00\uc601\uc6c5",
            "saveTime": "2026/11/17",
            "gameTime": "100",
            "posX": "1",
            "posZ": "2",
            "filename": "savefile0",
            "saveFileVersion": "76",
            "gameDiff": "1",
            "modelId": "1",
            "maintaskName": "\ucc9c\ud558",
            "trailing": trailing,
        })
        parsed = E.parse_companion_header(raw)
        self.assertEqual(parsed["stringCount"], 10)
        self.assertEqual(parsed["name"], "\ud55c\uae00\uc601\uc6c5")
        self.assertEqual(parsed["trailing"], trailing)

    def test_v77_11_strings_and_trailing(self):
        trailing = b"\x01\x02\x03"
        raw = E.encode_companion_header({
            "name": "\uc591\uc18c",
            "saveTime": "2026/11/17",
            "gameTime": "3600",
            "posX": "10",
            "posZ": "20",
            "filename": "savefile1",
            "saveFileVersion": "77",
            "gameDiff": "3",
            "modelId": "2",
            "maintaskName": "\uc2dc\uc791",
            "gameType": "0",
            "trailing": trailing,
        })
        parsed = E.parse_companion_header(raw)
        self.assertEqual(parsed["stringCount"], 11)
        self.assertEqual(parsed["gameType"], "0")
        self.assertEqual(parsed["trailing"], trailing)


class TestCliWorkflow(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.dir = Path(self.tmp.name)

    def _seed_demo(self) -> tuple[Path, Path]:
        proc = run_cli("demo", "--out-dir", str(self.dir))
        self.assertEqual(proc.returncode, 0, proc.stderr)
        return self.dir / "savefile0.json", self.dir / "savefile0"

    def test_cli_demo_discover_inspect_validate_presets(self):
        save_p, hdr_p = self._seed_demo()
        self.assertTrue(save_p.is_file())
        self.assertTrue(hdr_p.is_file())

        p_disc = run_cli("discover", "--root", str(self.dir))
        self.assertEqual(p_disc.returncode, 0, p_disc.stderr)
        disc = json.loads(p_disc.stdout)
        self.assertEqual(len(disc["slots"]), 1)
        self.assertTrue(disc["slots"][0]["hasCompanionHeader"])

        p_insp = run_cli("inspect", str(save_p), "--json")
        self.assertEqual(p_insp.returncode, 0, p_insp.stderr)
        insp = json.loads(p_insp.stdout)
        self.assertEqual(insp["summary"]["money"], 12345)

        p_val = run_cli("validate", str(save_p))
        self.assertEqual(p_val.returncode, 0, p_val.stderr)
        self.assertTrue(json.loads(p_val.stdout)["ok"])

        p_pre = run_cli("presets")
        self.assertEqual(p_pre.returncode, 0, p_pre.stderr)
        ids = [row["id"] for row in json.loads(p_pre.stdout)["presets"]]
        self.assertEqual(ids, list(E.PRESET_ORDER))

    def test_edit_dry_run_real_backup_and_safety_guards(self):
        save_p, _ = self._seed_demo()
        orig_bytes = save_p.read_bytes()

        p_dry = run_cli("edit", str(save_p), "--preset", "rich_start", "--dry-run")
        self.assertEqual(p_dry.returncode, 0, p_dry.stderr)
        self.assertTrue(json.loads(p_dry.stdout)["dryRun"])
        self.assertEqual(save_p.read_bytes(), orig_bytes)

        p_edit = run_cli("edit", str(save_p), "--preset", "rich_start", "--money", "888888", "--jingjie", "12")
        self.assertEqual(p_edit.returncode, 0, p_edit.stderr)
        edit_res = json.loads(p_edit.stdout)
        backup_p = Path(edit_res["backupPath"])
        self.assertTrue(backup_p.is_file())
        self.assertEqual(backup_p.read_bytes(), orig_bytes)
        updated_doc = json.loads(save_p.read_text(encoding="utf-8-sig"))
        player = next(iter(updated_doc["playerentity"].values()))
        self.assertIsInstance(player["m_valueBase"], str)
        self.assertEqual(json.loads(player["m_valueBase"])["68"], 888888)
        self.assertEqual(player["jingjieGangLevel"], 12)

        # Simulated game running blocks write
        p_lock = run_cli("edit", str(save_p), "--money", "1", env={"NJ2_SIMULATE_GAME_RUNNING": "1"})
        self.assertNotEqual(p_lock.returncode, 0)

        # Symlink path refusal
        sym_p = self.dir / "link.json"
        os.symlink(save_p, sym_p)
        with self.assertRaises(E.UnsafePathError):
            E.save_with_backup(sym_p, orig_bytes)

        # SHA mismatch optimistic concurrency check
        with self.assertRaises(E.ShaMismatchError):
            E.save_with_backup(save_p, orig_bytes, expected_sha256="0" * 64)

    def test_starter_kit_and_add_item_use_bag_slots_and_preserve_count(self):
        save_p, _ = self._seed_demo()
        p_edit = run_cli("edit", str(save_p), "--preset", "starter_kit", "--add-item", "1006:1")
        self.assertEqual(p_edit.returncode, 0, p_edit.stderr)
        doc = json.loads(save_p.read_text(encoding="utf-8"))
        player = next(iter(doc["playerentity"].values()))
        storage = player["itemStorage"]
        content = storage["content"]
        slot_nums = [int(k) for k in content.keys()]
        self.assertTrue(all(s >= E.SUB_SLOT_BAG_BEGIN for s in slot_nums), slot_nums)
        self.assertGreaterEqual(storage["count"], max(slot_nums) + 1)
        self.assertGreaterEqual(storage["count"], 120)
        # Slot 13 in demo omits key "2" (real qty-1 format) and still validates
        self.assertNotIn("2", content["13"])
        self.assertEqual(E.validate_doc(doc), [])

    def test_real_bom_stringified_save_cli_roundtrip(self):
        save_p = self.dir / "savefile1.json"
        payload = {
            "playerentity": {
                "1": {
                    "m_valueBase": json.dumps({"0": 4500, "68": 50000, "999": 42}, separators=(",", ":")),
                    "m_learntSpell": json.dumps({"0": [3, 4], "1": [500]}, separators=(",", ":")),
                    "m_EquipedStuntIds": json.dumps({"34": 3400}, separators=(",", ":")),
                    "qgactive": json.dumps({"101": 1010}, separators=(",", ":")),
                    "m0": json.dumps([10000, 10010], separators=(",", ":")),
                    "itemStorage": {"count": 120, "content": {"12": {"0": 1, "1": 1001, "4": 1.0}}},
                }
            },
            "Entitys": {"2": {"guid": 2, "m_DaTiTime": 0.0, "m_valueBase": json.dumps({"0": 2000}, separators=(",", ":"))}},
        }
        bom = b"\xef\xbb\xbf"
        save_p.write_bytes(bom + json.dumps(payload, indent=4, ensure_ascii=False).encode("utf-8"))

        p_val = run_cli("validate", str(save_p))
        self.assertEqual(p_val.returncode, 0, p_val.stderr + p_val.stdout)
        self.assertTrue(json.loads(p_val.stdout)["ok"])

        p_insp = run_cli("inspect", str(save_p), "--json")
        self.assertEqual(p_insp.returncode, 0, p_insp.stderr + p_insp.stdout)
        self.assertEqual(json.loads(p_insp.stdout)["summary"]["money"], 50000)

        p_edit = run_cli("edit", str(save_p), "--money", "777777")
        self.assertEqual(p_edit.returncode, 0, p_edit.stderr + p_edit.stdout)

        raw = save_p.read_bytes()
        self.assertTrue(raw.startswith(bom))
        text = raw.decode("utf-8-sig")
        parsed = json.loads(text)
        p = parsed["playerentity"]["1"]
        self.assertIsInstance(p["m_valueBase"], str)
        vb = json.loads(p["m_valueBase"])
        self.assertEqual(vb["68"], 777777)
        self.assertEqual(vb["999"], 42)
        self.assertRegex(text, r'"m_DaTiTime"\s*:\s*0\.0')
        self.assertRegex(text, r'"4"\s*:\s*1\.0')


class TestLoopbackServer(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.dir = Path(self.tmp.name)
        proc = run_cli("demo", "--out-dir", str(self.dir))
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.save_p = self.dir / "savefile0.json"

        self.srv = subprocess.Popen(
            [sys.executable, str(ROOT / "nj2_editor.py"), "serve", "--port", "0", "--no-browser", "--root", str(self.dir)],
            cwd=str(ROOT),
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            encoding="utf-8",
        )
        self.addCleanup(self._stop_srv)
        line = self.srv.stdout.readline()
        self.info = json.loads(line)
        self.port = int(self.info["port"])

    def _stop_srv(self):
        try:
            if self.srv.poll() is None:
                self.srv.terminate()
                try:
                    self.srv.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    self.srv.kill()
                    self.srv.wait(timeout=5)
        finally:
            for stream in (self.srv.stdout, self.srv.stderr):
                if stream is not None:
                    try:
                        stream.close()
                    except OSError:
                        pass

    def _req(self, method: str, path: str, body: bytes | None = None, headers: dict | None = None):
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=10)
        try:
            conn.request(method, path, body=body, headers=headers or {})
            resp = conn.getresponse()
            data = resp.read()
            return resp.status, data
        finally:
            conn.close()

    def test_html_security_headers_and_full_api_roundtrip(self):
        status, html_bytes = self._req("GET", "/")
        self.assertEqual(status, 200)
        html = html_bytes.decode("utf-8")
        self.assertIn("connect-src 'self'", html)
        m = re.search(r'window\.__NJ2_TOKEN__\s*=\s*"([0-9a-f]+)"', html)
        self.assertIsNotNone(m)
        token = m.group(1)

        st_health, health_raw = self._req("GET", "/api/health")
        self.assertEqual(st_health, 200)
        self.assertTrue(json.loads(health_raw.decode("utf-8"))["ok"])

        # Reject invalid Host, foreign Origin, cross-site Sec-Fetch-Site, bad/missing token
        self.assertEqual(self._req("GET", "/api/health", headers={"Host": "evil.example"})[0], 403)
        self.assertEqual(self._req("GET", "/api/slots", headers={"X-NJ2-Token": token, "Origin": "https://evil.example"})[0], 403)
        self.assertEqual(self._req("GET", "/api/slots", headers={"X-NJ2-Token": token, "Sec-Fetch-Site": "cross-site"})[0], 403)
        self.assertEqual(self._req("GET", "/api/slots")[0], 401)
        self.assertEqual(self._req("GET", "/api/slots", headers={"X-NJ2-Token": "wrong"})[0], 401)

        # Valid flow: slots -> load -> save -> conflict on stale SHA
        st_slots, raw_slots = self._req("GET", "/api/slots", headers={"X-NJ2-Token": token})
        self.assertEqual(st_slots, 200)
        slot_path = json.loads(raw_slots.decode("utf-8"))["slots"][0]["path"]

        load_body = json.dumps({"path": slot_path}).encode("utf-8")
        st_load, raw_load = self._req("POST", "/api/load", body=load_body, headers={"X-NJ2-Token": token, "Content-Type": "application/json"})
        self.assertEqual(st_load, 200)
        loaded = json.loads(raw_load.decode("utf-8"))

        doc = json.loads(base64.b64decode(loaded["jsonBase64"]).decode("utf-8-sig"))
        player = next(iter(doc["playerentity"].values()))
        vb = json.loads(player["m_valueBase"]) if isinstance(player["m_valueBase"], str) else dict(player["m_valueBase"])
        vb["68"] = 7654321
        player["m_valueBase"] = json.dumps(vb, separators=(",", ":"))
        new_b64 = base64.b64encode(json.dumps(doc).encode("utf-8")).decode("ascii")

        save_body = json.dumps({
            "path": slot_path,
            "jsonBase64": new_b64,
            "headerBase64": loaded["headerBase64"],
            "expectedSha256": loaded["sha256"],
        }).encode("utf-8")
        st_save, raw_save = self._req("POST", "/api/save", body=save_body, headers={"X-NJ2-Token": token, "Content-Type": "application/json"})
        self.assertEqual(st_save, 200)
        saved = json.loads(raw_save.decode("utf-8"))
        self.assertTrue(Path(saved["backupPath"]).is_file())

        # Repeat save with stale sha256 -> 409
        st_conflict, _ = self._req("POST", "/api/save", body=save_body, headers={"X-NJ2-Token": token, "Content-Type": "application/json"})
        self.assertEqual(st_conflict, 409)


class TestReviewRegressions(unittest.TestCase):
    def test_validate_rejects_raw_wpj_and_edit_repairs_and_enforces_int32(self):
        with tempfile.TemporaryDirectory() as td:
            p = Path(td) / "corrupted.json"
            raw_doc = {
                "playerentity": {
                    "1": {
                        "m_valueBase": {"68": 100},
                        "mijiIdList": [10000],
                        "m_learntSpell": {"0": [5]},
                        "itemStorage": {
                            "count": 20,
                            "content": {"12": {"0": 1001, "1": 1001, "4": 1, "9": 10, "10": 1}},
                        },
                    }
                },
                "Entitys": {
                    "2": {
                        "m_valueBase": {"68": 50},
                        "m_DaTiTime": 0,
                    }
                },
            }
            p.write_text(json.dumps(raw_doc, indent=2), encoding="utf-8")

            # validate must reject raw non-string WritePropertyJson fields
            res_val = run_cli("validate", str(p))
            self.assertNotEqual(res_val.returncode, 0)

            # edit with int32 overflow must fail
            res_over = run_cli("edit", str(p), "--money", "3000000000", "--out", str(Path(td) / "over.json"))
            self.assertNotEqual(res_over.returncode, 0)

            # edit repairs player + Entitys WritePropertyJson strings and known double floats
            out_p = Path(td) / "repaired.json"
            res_edit = run_cli("edit", str(p), "--money", "777", "--out", str(out_p))
            self.assertEqual(res_edit.returncode, 0, msg=res_edit.stderr)
            txt = out_p.read_text(encoding="utf-8")
            repaired = json.loads(txt)
            self.assertIsInstance(repaired["playerentity"]["1"]["m_valueBase"], str)
            self.assertIsInstance(repaired["playerentity"]["1"]["mijiIdList"], str)
            self.assertIsInstance(repaired["Entitys"]["2"]["m_valueBase"], str)
            self.assertIn('"m_DaTiTime": 0.0', txt)
            self.assertIn('"4": 1.0', txt)

            # repaired save now passes strict validate
            res_val2 = run_cli("validate", str(out_p))
            self.assertEqual(res_val2.returncode, 0, msg=res_val2.stdout + res_val2.stderr)

            # Strict validate individually rejects root raw array, NPC raw dict, and int m_DaTiTime / item["4"]
            base_ok = {
                "playerentity": {
                    "1": {
                        "m_valueBase": '{"68":100}',
                        "itemStorage": {"count": 20, "content": {"12": {"0": 1001, "1": 1001, "4": 1.0, "9": 10, "10": 1}}},
                    }
                },
                "Entitys": {"2": {"m_valueBase": '{"68":50}', "m_DaTiTime": 0.0}},
            }
            for tag, mutator in (
                ("root_raw", lambda d: d.__setitem__("allentityids", [1, 2])),
                ("root_npc_dic_list", lambda d: d.__setitem__("npcGuidProidDic", "[]")),
                ("npc_raw", lambda d: d["Entitys"]["2"].__setitem__("m_learntSpell", {"0": [1]})),
                ("npc_spell_scalar", lambda d: d["Entitys"]["2"].__setitem__("m_learntSpell", '{"0":42}')),
                ("npc_int_dt", lambda d: d["Entitys"]["2"].__setitem__("m_DaTiTime", 0)),
                ("item_int_4", lambda d: d["playerentity"]["1"]["itemStorage"]["content"]["12"].__setitem__("4", 1)),
            ):
                bad = json.loads(json.dumps(base_ok))
                mutator(bad)
                bp = Path(td) / f"{tag}.json"
                bp.write_text(json.dumps(bad), encoding="utf-8")
                rv = run_cli("validate", str(bp))
                self.assertNotEqual(rv.returncode, 0, msg=f"{tag} should fail strict validate")

            # Legacy v1.0.2 arrays in dict fields (m_learntSpell/m_EquipedStuntIds/qgactive/m9) repair via CLI edit
            legacy_arr = {
                "playerentity": {
                    "1": {
                        "m_valueBase": {"68": 100},
                        "m_learntSpell": [3, 4],
                        "m_EquipedStuntIds": [3401],
                        "qgactive": [1010],
                        "m9": [],
                    }
                }
            }
            lp = Path(td) / "legacy_arr.json"
            lp.write_text(json.dumps(legacy_arr), encoding="utf-8")
            lp_out = Path(td) / "legacy_arr_repaired.json"
            re_res = run_cli("edit", str(lp), "--money", "555", "--out", str(lp_out))
            self.assertEqual(re_res.returncode, 0, msg=re_res.stderr)
            rep_doc = json.loads(lp_out.read_text(encoding="utf-8"))
            p1 = rep_doc["playerentity"]["1"]
            self.assertEqual(json.loads(p1["m_learntSpell"]), {"0": [3, 4]})
            self.assertEqual(json.loads(p1["m_EquipedStuntIds"]), {"34": 3401})
            self.assertEqual(json.loads(p1["qgactive"]), {"101": 1010})
            self.assertEqual(json.loads(p1["m9"]), [])
            self.assertEqual(run_cli("validate", str(lp_out)).returncode, 0)


class TestNoLiteralHanziKana(unittest.TestCase):
    def test_nj2_editor_source_has_no_literal_hanzi_or_kana(self):
        src = (ROOT / "nj2_editor.py").read_text(encoding="utf-8")
        self.assertIsNone(HANZI_RE.search(src))
        self.assertIsNone(KANA_RE.search(src))


if __name__ == "__main__":
    unittest.main()
