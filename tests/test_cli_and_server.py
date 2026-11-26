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
        updated_doc = json.loads(save_p.read_text(encoding="utf-8"))
        player = next(iter(updated_doc["playerentity"].values()))
        self.assertEqual(player["m_valueBase"]["68"], 888888)
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

        doc = json.loads(base64.b64decode(loaded["jsonBase64"]).decode("utf-8"))
        next(iter(doc["playerentity"].values()))["m_valueBase"]["68"] = 7654321
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


class TestNoLiteralHanziKana(unittest.TestCase):
    def test_nj2_editor_source_has_no_literal_hanzi_or_kana(self):
        src = (ROOT / "nj2_editor.py").read_text(encoding="utf-8")
        self.assertIsNone(HANZI_RE.search(src))
        self.assertIsNone(KANA_RE.search(src))


if __name__ == "__main__":
    unittest.main()
