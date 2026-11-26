#!/usr/bin/env python3
"""
nj2_editor.py

Zero-dependency save editor CLI and loopback HTTP server for a certain
locally installed game. The game directory name is kept as Unicode escapes
so this source file remains free of literal Hanzi/Kana characters.
"""

from __future__ import annotations

import argparse
import base64
import binascii
import hashlib
import hmac
import http.server
import json
import os
import re
import secrets
import stat
import subprocess
import sys
import tempfile
import threading
import time
import traceback
import urllib.parse
import webbrowser
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Sequence, Tuple

GAME_DIR_NAME = "\u4e0b\u4e00\u7ad9\u6c5f\u6e56\u2161"
GAME_PROCESS_NAMES = ("NextJianghu", GAME_DIR_NAME)
SAVE_JSON_RE = re.compile(r"^(?:savefile|autosavefile)(\d+)\.json$", re.IGNORECASE)
COMPANION_FIELDS = (
    "name",
    "saveTime",
    "gameTime",
    "posX",
    "posZ",
    "filename",
    "saveFileVersion",
    "gameDiff",
    "modelId",
    "maintaskName",
    "gameType",
)
SKIP_SUFFIX_PATTERNS = (".bak", ".backup-", ".pending-")

PRESET_ORDER = (
    "rich_start",
    "core_stats_500",
    "weapons_1000",
    "life_master_1000",
    "jingjie_13",
    "starter_kit",
)
PRESET_DESCRIPTIONS = {
    "rich_start": "Set money, xiuwei and ganwu to large starting values.",
    "core_stats_500": "Raise attribute keys 0 through 9 to at least 500.",
    "weapons_1000": "Raise attribute keys 27 through 33 to at least 1000.",
    "life_master_1000": "Raise attribute keys 43 through 61 to at least 1000.",
    "jingjie_13": "Set m_jingJieLevel to 13.",
    "starter_kit": "Add basic starter items to item storage.",
}

HTML_CANDIDATES = (
    Path("dist") / "NextJianghu2SaveEditor-v1.0.3.html",
    Path("src") / "editor-page.html",
)
SUB_SLOT_BAG_BEGIN = 12

FILE_ATTRIBUTE_REPARSE_POINT = getattr(stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0x400)
MAX_REQUEST_BODY = 64 * 1024 * 1024


class Nj2Error(Exception):
    """Base class for explicit editor errors."""


class GameRunningError(Nj2Error):
    pass


class ShaMismatchError(Nj2Error):
    pass


class UnsafePathError(Nj2Error):
    pass


class ValidationError(Nj2Error):
    pass


class BadRequestError(Nj2Error):
    pass


def _utc_now_iso() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat()


def _safe_print(text: str = "") -> None:
    try:
        print(text)
    except UnicodeEncodeError:
        print(text.encode("utf-8", "backslashreplace").decode("ascii", "replace"))


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def sha256_file(path: os.PathLike[str] | str) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        while True:
            chunk = f.read(1024 * 1024)
            if not chunk:
                break
            h.update(chunk)
    return h.hexdigest()


def _read_varint(raw: bytes, offset: int) -> Tuple[int, int]:
    value = 0
    shift = 0
    while True:
        if offset >= len(raw):
            raise ValueError("truncated companion header varint")
        b = raw[offset]
        offset += 1
        value |= (b & 0x7F) << shift
        if (b & 0x80) == 0:
            return value, offset
        shift += 7
        if shift > 35:
            raise ValueError("invalid companion header varint")


def _encode_varint(value: int) -> bytes:
    if value < 0:
        raise ValueError("varint value must be non-negative")
    out = bytearray()
    while True:
        b = value & 0x7F
        value >>= 7
        if value:
            out.append(b | 0x80)
        else:
            out.append(b)
            return bytes(out)


def parse_companion_header(raw: bytes) -> Dict[str, Any]:
    """
    Parse the companion file header.

    The file is a sequence of .NET BinaryWriter strings:
      7-bit LEB128 byte length + UTF-8 bytes.

    Version 76 uses 10 strings; versions >= 77 use 11 strings. The parser is
    intentionally tolerant about the exact count and preserves trailing bytes
    so an unknown trailing region can survive a round trip.
    """
    if not isinstance(raw, (bytes, bytearray)):
        raise ValueError("companion header must be bytes")
    raw = bytes(raw)
    offset = 0
    strings: List[str] = []
    for _ in range(10):
        if offset >= len(raw):
            break
        length, offset = _read_varint(raw, offset)
        if offset + length > len(raw):
            raise ValueError("truncated companion header string")
        try:
            s = raw[offset:offset + length].decode("utf-8")
        except UnicodeDecodeError as exc:
            raise ValueError("companion header string is not valid UTF-8") from exc
        offset += length
        strings.append(s)

    if len(strings) < 10:
        raise ValueError("companion header must contain at least 10 strings")

    save_ver = strings[6] if len(strings) > 6 else ""
    if save_ver != "76" and offset < len(raw):
        length, offset = _read_varint(raw, offset)
        if offset + length > len(raw):
            raise ValueError("truncated companion header string")
        try:
            s = raw[offset:offset + length].decode("utf-8")
        except UnicodeDecodeError as exc:
            raise ValueError("companion header string is not valid UTF-8") from exc
        offset += length
        strings.append(s)

    trailing = raw[offset:]
    meta: Dict[str, Any] = {
        "strings": strings,
        "stringCount": len(strings),
        "trailing": trailing,
        "trailingBase64": base64.b64encode(trailing).decode("ascii") if trailing else "",
        "rawSize": len(raw),
    }
    for idx, key in enumerate(COMPANION_FIELDS):
        meta[key] = strings[idx] if idx < len(strings) else ""
    return meta


def encode_companion_header(meta: Dict[str, Any]) -> bytes:
    """
    Encode a companion header dict back to bytes.

    Accepts either meta["strings"] or the named fields. If no explicit string
    count is present, version 76 is encoded as 10 strings and newer versions
    as 11 strings.
    """
    if not isinstance(meta, dict):
        raise ValueError("companion meta must be a dict")

    strings: List[str]
    if isinstance(meta.get("strings"), list):
        strings = [str(x) for x in meta["strings"]]
    else:
        version = str(meta.get("saveFileVersion", "") or "77")
        count = 10 if version == "76" else 11
        strings = []
        for idx in range(count):
            key = COMPANION_FIELDS[idx] if idx < len(COMPANION_FIELDS) else ""
            strings.append(str(meta.get(key, "") or ""))

    if isinstance(meta.get("stringCount"), int):
        count = int(meta["stringCount"])
        if count not in (10, 11):
            raise ValueError("companion stringCount must be 10 or 11")
        if len(strings) < count:
            strings.extend([""] * (count - len(strings)))
        strings = strings[:count]
    else:
        if len(strings) not in (10, 11):
            version = str(meta.get("saveFileVersion", "") or "77")
            count = 10 if version == "76" else 11
            if len(strings) < count:
                strings.extend([""] * (count - len(strings)))
            strings = strings[:count]

    if len(strings) not in (10, 11):
        raise ValueError("companion header must contain 10 or 11 strings")

    out = bytearray()
    for s in strings:
        data = s.encode("utf-8")
        out.extend(_encode_varint(len(data)))
        out.extend(data)

    trailing = meta.get("trailing")
    if isinstance(trailing, (bytes, bytearray)):
        out.extend(bytes(trailing))
    elif isinstance(meta.get("trailingBase64"), str) and meta["trailingBase64"]:
        try:
            out.extend(base64.b64decode(meta["trailingBase64"], validate=True))
        except (binascii.Error, ValueError) as exc:
            raise ValueError("invalid trailingBase64") from exc
    return bytes(out)


def _is_skipped_json_name(name: str) -> bool:
    lower = name.lower()
    if not lower.endswith(".json"):
        return True
    if any(pat in lower for pat in SKIP_SUFFIX_PATTERNS):
        return True
    return False


def _json_sort_key(path: Path) -> Tuple[str, str]:
    m = SAVE_JSON_RE.match(path.name)
    if m:
        return (path.parent.as_posix().lower(), path.name.lower())
    return (path.parent.as_posix().lower(), path.name.lower())


def _default_save_roots() -> List[Path]:
    roots: List[Path] = []
    home = Path.home()
    userprofile = os.environ.get("USERPROFILE")
    if userprofile:
        try:
            roots.append(Path(userprofile) / "AppData" / "LocalLow" / "inmotiongame" / GAME_DIR_NAME / "Save2")
        except OSError:
            pass
    if home:
        roots.append(home / "AppData" / "LocalLow" / "inmotiongame" / GAME_DIR_NAME / "Save2")

    steam_candidates: List[Path] = []
    for env_name in ("ProgramFiles(x86)", "ProgramFiles", "SteamPath", "STEAM_PATH"):
        value = os.environ.get(env_name)
        if value:
            steam_candidates.append(Path(value))
    steam_candidates.extend(
        [
            Path("C:/Program Files (x86)/Steam"),
            Path("C:/Program Files/Steam"),
            home / ".steam" / "steam",
            home / ".local" / "share" / "Steam",
        ]
    )
    seen_steam = set()
    for steam in steam_candidates:
        try:
            key = str(steam).lower()
        except OSError:
            continue
        if key in seen_steam:
            continue
        seen_steam.add(key)
        game_data = steam / "steamapps" / "common" / GAME_DIR_NAME / GAME_DIR_NAME / (GAME_DIR_NAME + "_Data") / "Save2"
        roots.append(game_data)

    unique: List[Path] = []
    seen = set()
    for root in roots:
        try:
            key = str(root).lower()
        except OSError:
            continue
        if key in seen:
            continue
        seen.add(key)
        unique.append(root)
    return unique


def _scan_json_dir(directory: Path, recursive: bool = False) -> List[Path]:
    result: List[Path] = []
    if not directory.exists() or not directory.is_dir():
        return result
    try:
        if recursive:
            iterator = directory.rglob("*.json")
        else:
            iterator = directory.glob("*.json")
        for p in iterator:
            try:
                if p.is_file() and not _is_skipped_json_name(p.name):
                    result.append(p)
            except OSError:
                continue
    except OSError:
        return result
    return result


def discover_saves(root: Optional[os.PathLike[str] | str] = None) -> List[Dict[str, Any]]:
    searched: List[Path] = []
    json_paths: List[Path] = []

    if root is not None:
        r = Path(root).expanduser()
        searched.append(r)
        json_paths.extend(_scan_json_dir(r, recursive=False))
        json_paths.extend(_scan_json_dir(r / "Auto", recursive=False))
        if not json_paths and r.is_dir():
            json_paths.extend(_scan_json_dir(r, recursive=True))
    else:
        for r in _default_save_roots():
            searched.append(r)
            json_paths.extend(_scan_json_dir(r, recursive=False))
            json_paths.extend(_scan_json_dir(r / "Auto", recursive=False))

    seen = set()
    slots: List[Dict[str, Any]] = []
    for json_path in sorted(json_paths, key=_json_sort_key):
        try:
            absolute = json_path.absolute()
            key = str(absolute).lower()
        except OSError:
            continue
        if key in seen:
            continue
        seen.add(key)

        companion_path = absolute.with_suffix("")
        has_header = False
        header_size: Optional[int] = None
        header_sha: Optional[str] = None
        try:
            has_header = companion_path.is_file()
            if has_header:
                st_h = companion_path.stat()
                header_size = st_h.st_size
                header_sha = sha256_file(companion_path)
        except OSError:
            has_header = False

        try:
            st = absolute.stat()
            size = st.st_size
            mtime = datetime.fromtimestamp(st.st_mtime, tz=timezone.utc).replace(microsecond=0).isoformat()
            json_sha = sha256_file(absolute)
        except OSError:
            size = None
            mtime = None
            json_sha = None

        m = SAVE_JSON_RE.match(absolute.name)
        slot_number: Optional[int] = None
        kind = "save"
        if m:
            try:
                slot_number = int(m.group(1))
            except ValueError:
                slot_number = None
            if absolute.name.lower().startswith("autosavefile"):
                kind = "autosave"

        slots.append(
            {
                "name": absolute.name,
                "path": str(absolute),
                "directory": str(absolute.parent),
                "size": size,
                "mtime": mtime,
                "sha256": json_sha,
                "kind": kind,
                "slot": slot_number,
                "hasCompanionHeader": has_header,
                "companionPath": str(companion_path) if has_header else None,
                "companionSize": header_size,
                "companionSha256": header_sha,
            }
        )

    return {"root": str(Path(root).expanduser()) if root is not None else None,
            "searched": [str(p) for p in searched],
            "slots": slots}


def _decode_json_field(value: Any) -> Any:
    if isinstance(value, str):
        s = value.strip()
        if not s:
            return None
        try:
            return json.loads(s)
        except (ValueError, TypeError):
            return None
    if isinstance(value, (dict, list)):
        return value
    return None


def _encode_json_field(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


def _get_player_from_doc(doc: Dict[str, Any]) -> Tuple[str, Dict[str, Any]]:
    if not isinstance(doc, dict):
        raise ValueError("save JSON root must be an object")
    pe = doc.get("playerentity")
    if not isinstance(pe, dict):
        raise ValueError("save JSON has no playerentity object")
    for guid, player in pe.items():
        if isinstance(player, dict) and isinstance(_decode_json_field(player.get("m_valueBase")), dict):
            return str(guid), player
    for guid, player in pe.items():
        if isinstance(player, dict):
            return str(guid), player
    raise ValueError("save JSON playerentity contains no player object")


def get_player(doc: Dict[str, Any]) -> Dict[str, Any]:
    _guid, player = _get_player_from_doc(doc)
    return player


def _value_base(player: Dict[str, Any]) -> Dict[str, Any]:
    vb = _decode_json_field(player.get("m_valueBase"))
    if not isinstance(vb, dict):
        raise ValueError("player has no m_valueBase object")
    return dict(vb)


INT32_MIN = -2147483648
INT32_MAX = 2147483647
WPJ_DICT_FIELDS = ("m_valueBase", "m_learntSpell", "m_EquipedStuntIds", "qgactive")
WPJ_LIST_FIELDS = ("mijiIdList", "m_StuntIds", "talents", "learnedpeifang", "m0", "m1", "m8", "m9", "m_AchievementList")
WPJ_ROOT_FIELDS = ("allentityids", "npcGuidProidDic")


def _write_value_base(player: Dict[str, Any], vb: Dict[str, Any]) -> None:
    out: Dict[str, int] = {}
    for k, v in vb.items():
        iv = _int_like(v, f"m_valueBase[{k}]")
        if iv < INT32_MIN or iv > INT32_MAX:
            raise ValueError(f"m_valueBase[{k}] out of int32 range: {iv}")
        out[str(k)] = iv
    player["m_valueBase"] = _encode_json_field(out)


_STUNT_TYPE_OVERRIDES = {6400: 94, 6401: 94, 6402: 94, 6403: 94, 6405: 94, 6406: 94}


def _convert_legacy_dict_list(field: str, items: List[Any]) -> Dict[str, Any]:
    ints: List[int] = []
    for x in items:
        try:
            ints.append(_int_like(x, field))
        except ValueError:
            continue
    if field == "m_learntSpell":
        return {"0": ints} if ints else {}
    if field == "qgactive":
        out_qg: Dict[str, int] = {}
        for v in ints:
            out_qg[str(v // 10)] = v
        return out_qg
    out_st: Dict[str, int] = {}
    for v in ints:
        out_st[str(_STUNT_TYPE_OVERRIDES.get(v, v // 100))] = v
    return out_st


def normalize_write_property_json_root(doc: Dict[str, Any]) -> None:
    if not isinstance(doc, dict):
        return
    for group_key in ("playerentity", "Entitys"):
        group = doc.get(group_key)
        if not isinstance(group, dict):
            continue
        for ent in group.values():
            if not isinstance(ent, dict):
                continue
            for fn in WPJ_DICT_FIELDS:
                if fn not in ent or ent[fn] is None:
                    continue
                val = ent[fn]
                decoded = _decode_json_field(val)
                if fn != "m_valueBase" and isinstance(decoded, list):
                    ent[fn] = _encode_json_field(_convert_legacy_dict_list(fn, decoded))
                elif not isinstance(val, str):
                    ent[fn] = _encode_json_field(val)
            for fn in WPJ_LIST_FIELDS:
                if fn in ent and ent[fn] is not None and not isinstance(ent[fn], str):
                    ent[fn] = _encode_json_field(ent[fn])
            dt = ent.get("m_DaTiTime")
            if isinstance(dt, int) and not isinstance(dt, bool):
                ent["m_DaTiTime"] = float(dt)
            storage = ent.get("itemStorage")
            if isinstance(storage, dict) and isinstance(storage.get("content"), dict):
                for row in storage["content"].values():
                    if isinstance(row, dict) and "4" in row:
                        p4 = row["4"]
                        if isinstance(p4, int) and not isinstance(p4, bool):
                            row["4"] = float(p4)
    for rk in WPJ_ROOT_FIELDS:
        if rk in doc and doc[rk] is not None and not isinstance(doc[rk], str):
            doc[rk] = _encode_json_field(doc[rk])


def _int_like(value: Any, label: str = "value") -> int:
    if isinstance(value, bool):
        return int(value)
    if isinstance(value, int):
        return value
    if isinstance(value, float) and value.is_integer():
        return int(value)
    if isinstance(value, str):
        s = value.strip()
        if re.match(r"^-?\d+$", s):
            return int(s)
    raise ValueError(f"{label} must be an integer")


def _set_int_like(container: Dict[str, Any], key: str, value: int) -> None:
    container[key] = int(value)


def _validate_entity_wpj(
    ent: Dict[str, Any],
    prefix: str,
    errors: List[str],
    strict_strings: bool,
    require_value_base: bool,
) -> None:
    if require_value_base or ("m_valueBase" in ent and ent["m_valueBase"] not in (None, "")):
        raw_vb = ent.get("m_valueBase")
        if strict_strings and not isinstance(raw_vb, str):
            errors.append(f"{prefix}.m_valueBase must be a WritePropertyJson string")
        elif not isinstance(_decode_json_field(raw_vb), dict):
            errors.append(f"{prefix}.m_valueBase is missing or not a valid JSON object")
    for dict_key in ("m_learntSpell", "m_EquipedStuntIds", "qgactive"):
        if dict_key in ent and ent.get(dict_key) not in (None, ""):
            raw_val = ent.get(dict_key)
            if strict_strings and not isinstance(raw_val, str):
                errors.append(f"{prefix}.{dict_key} must be a WritePropertyJson string")
            else:
                decoded = _decode_json_field(raw_val)
                if strict_strings:
                    if not isinstance(decoded, dict):
                        errors.append(f"{prefix}.{dict_key} is not a valid JSON dictionary")
                    elif dict_key == "m_learntSpell" and any(not isinstance(v, list) for v in decoded.values()):
                        errors.append(f"{prefix}.m_learntSpell values must be JSON lists")
                elif not isinstance(decoded, (dict, list)):
                    errors.append(f"{prefix}.{dict_key} is not a valid JSON dictionary or legacy list")
    for list_key in WPJ_LIST_FIELDS:
        if list_key in ent and ent.get(list_key) not in (None, ""):
            raw_val = ent.get(list_key)
            if strict_strings and not isinstance(raw_val, str):
                errors.append(f"{prefix}.{list_key} must be a WritePropertyJson string")
            else:
                decoded = _decode_json_field(raw_val)
                if not isinstance(decoded, list):
                    errors.append(f"{prefix}.{list_key} is not a valid JSON list")
    if strict_strings:
        if "m_DaTiTime" in ent:
            dt = ent.get("m_DaTiTime")
            if isinstance(dt, int) and not isinstance(dt, bool):
                errors.append(f"{prefix}.m_DaTiTime must be a float/double literal")
        storage = ent.get("itemStorage")
        if isinstance(storage, dict) and isinstance(storage.get("content"), dict):
            for slot_k, row in storage["content"].items():
                if isinstance(row, dict) and "4" in row:
                    p4 = row["4"]
                    if isinstance(p4, int) and not isinstance(p4, bool):
                        errors.append(f"{prefix}.itemStorage.content.{slot_k}.4 must be a float/double literal")


def validate_doc(doc: Dict[str, Any], strict_strings: bool = True) -> List[str]:
    errors: List[str] = []
    if not isinstance(doc, dict):
        return ["root is not an object"]
    if strict_strings:
        for rk in WPJ_ROOT_FIELDS:
            if rk in doc and doc[rk] not in (None, ""):
                if not isinstance(doc[rk], str):
                    errors.append(f"root.{rk} must be a WritePropertyJson string")
                else:
                    decoded_root = _decode_json_field(doc[rk])
                    if rk == "allentityids" and not isinstance(decoded_root, list):
                        errors.append("root.allentityids must decode to a JSON list")
                    elif rk == "npcGuidProidDic" and not isinstance(decoded_root, dict):
                        errors.append("root.npcGuidProidDic must decode to a JSON dictionary")
    if "playerentity" not in doc or not isinstance(doc["playerentity"], dict):
        errors.append("missing playerentity object")
    else:
        try:
            _guid, player = _get_player_from_doc(doc)
        except ValueError as exc:
            errors.append(str(exc))
            player = None
        if isinstance(player, dict):
            _validate_entity_wpj(player, "player", errors, strict_strings, require_value_base=True)
            if "itemStorage" in player and not isinstance(player.get("itemStorage"), dict):
                errors.append("player.itemStorage is not an object")
            elif isinstance(player.get("itemStorage"), dict) and isinstance(player["itemStorage"].get("content"), dict):
                seen_uids: Dict[str, str] = {}
                for slot_k, row in player["itemStorage"]["content"].items():
                    if isinstance(row, dict) and "0" in row and row["0"] is not None:
                        uid_s = str(row["0"])
                        if uid_s and uid_s != "0":
                            if uid_s in seen_uids:
                                errors.append(f"duplicate item UID {uid_s} in slots {seen_uids[uid_s]} and {slot_k}")
                            else:
                                seen_uids[uid_s] = str(slot_k)
            jj_key = "jingjieGangLevel" if "jingjieGangLevel" in player else "m_jingJieLevel"
            if jj_key in player:
                try:
                    level = _int_like(player.get(jj_key), jj_key)
                    if level < 0:
                        errors.append(f"{jj_key} must be non-negative")
                except ValueError as exc:
                    errors.append(str(exc))
    if isinstance(doc.get("Entitys"), dict):
        for ek, npc in doc["Entitys"].items():
            if not isinstance(npc, dict):
                continue
            _validate_entity_wpj(npc, f"Entitys.{ek}", errors, strict_strings, require_value_base=False)
    if "m_ItemIdGenerator" in doc:
        try:
            _int_like(doc["m_ItemIdGenerator"], "m_ItemIdGenerator")
        except ValueError as exc:
            errors.append(str(exc))
    return errors


def load_save(path: os.PathLike[str] | str) -> Dict[str, Any]:
    p = Path(path)
    with open(p, "rb") as f:
        data = f.read()
    try:
        doc = json.loads(data.decode("utf-8-sig"))
    except UnicodeDecodeError as exc:
        raise ValidationError("save JSON is not valid UTF-8") from exc
    except json.JSONDecodeError as exc:
        raise ValidationError(f"save JSON is invalid: {exc}") from exc
    return doc


def _summary_from_doc(doc: Dict[str, Any]) -> Dict[str, Any]:
    guid, player = _get_player_from_doc(doc)
    decoded_vb = _decode_json_field(player.get("m_valueBase"))
    vb = decoded_vb if isinstance(decoded_vb, dict) else {}
    item_count = 0
    try:
        content = player.get("itemStorage", {}).get("content", {})
        if isinstance(content, dict):
            item_count = len(content)
    except (AttributeError, TypeError):
        item_count = 0
    jingjie = player.get("jingjieGangLevel", player.get("m_jingJieLevel"))
    name = None
    for k in ("name", "m_name", "playerName", "m_playerName"):
        if isinstance(player.get(k), str):
            name = player[k]
            break
    if name is None:
        for k in ("playername", "name", "m_name", "playerName", "m_playerName"):
            if isinstance(doc.get(k), str):
                name = doc[k]
                break
    return {
        "playerGuid": guid,
        "playerName": name,
        "money": vb.get("68"),
        "xiuwei": vb.get("69"),
        "ganwu": vb.get("70"),
        "zhengxie": vb.get("71"),
        "bukui": vb.get("94"),
        "itemCount": item_count,
        "jingjie": jingjie,
    }


def inspect_save(path: os.PathLike[str] | str) -> Dict[str, Any]:
    p = Path(path)
    doc = load_save(p)
    summary = _summary_from_doc(doc)
    companion = p.with_suffix("")
    header_info: Optional[Dict[str, Any]] = None
    if companion.exists() and companion.is_file():
        try:
            raw = companion.read_bytes()
            meta = parse_companion_header(raw)
            header_info = {
                "path": str(companion),
                "size": len(raw),
                "sha256": sha256_bytes(raw),
                "stringCount": meta.get("stringCount"),
                "name": meta.get("name"),
                "saveTime": meta.get("saveTime"),
                "gameTime": meta.get("gameTime"),
                "saveFileVersion": meta.get("saveFileVersion"),
                "gameDiff": meta.get("gameDiff"),
                "maintaskName": meta.get("maintaskName"),
                "gameType": meta.get("gameType"),
                "trailingBytes": len(meta.get("trailing", b"")),
            }
        except Exception as exc:
            header_info = {"path": str(companion), "error": str(exc)}
    result = {
        "path": str(p.absolute()),
        "sha256": sha256_file(p),
        "size": p.stat().st_size,
        "header": header_info,
        "summary": summary,
    }
    # Include selected save-level fields without dumping the entire save.
    for k in ("version", "maintaskName", "gameDiff", "posX", "posZ", "gameTime", "saveTime"):
        if k in doc:
            result[k] = doc[k]
    return result


def _ensure_not_symlink(path: Path) -> None:
    try:
        absolute = Path(os.path.abspath(os.fspath(path)))
    except OSError as exc:
        raise UnsafePathError(f"invalid path: {path}") from exc

    parts: List[Path] = []
    cur = absolute
    while True:
        parts.append(cur)
        parent = cur.parent
        if parent == cur:
            break
        cur = parent
    parts.reverse()

    for p in parts:
        try:
            st = os.lstat(p)
        except FileNotFoundError:
            continue
        except OSError as exc:
            raise UnsafePathError(f"cannot inspect path component: {p}") from exc
        mode = st.st_mode
        is_link = stat.S_ISLNK(mode)
        is_reparse = bool(getattr(st, "st_file_attributes", 0) & FILE_ATTRIBUTE_REPARSE_POINT)
        if is_link or is_reparse:
            raise UnsafePathError(f"refusing symlink or junction path component: {p}")


def game_is_running() -> bool:
    env = os.environ.get("NJ2_SIMULATE_GAME_RUNNING", "")
    if env.strip().lower() in ("1", "true", "yes", "on"):
        return True
    if os.name != "nt":
        return False
    try:
        proc = subprocess.run(
            ["tasklist", "/FO", "CSV", "/NH"],
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            timeout=5,
            check=False,
        )
    except Exception:
        return False
    text = proc.stdout.decode("utf-8", "replace")
    lower = text.lower()
    for name in GAME_PROCESS_NAMES:
        if name.lower() in lower:
            return True
    return False


def require_game_not_running() -> None:
    if game_is_running():
        raise GameRunningError("game process appears to be running; refusing to write")


def _timestamp() -> str:
    return datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")


def _make_backup(path: Path) -> Path:
    _ensure_not_symlink(path)
    if not path.exists():
        raise FileNotFoundError(str(path))
    if path.is_dir():
        raise IsADirectoryError(str(path))
    backup = path.with_name(f"{path.name}.backup-{_timestamp()}-{os.getpid()}-{secrets.token_hex(4)}.bak")
    _ensure_not_symlink(backup)
    with open(path, "rb") as src, open(backup, "xb") as dst:
        while True:
            chunk = src.read(1024 * 1024)
            if not chunk:
                break
            dst.write(chunk)
        dst.flush()
        os.fsync(dst.fileno())
    src_sha = sha256_file(path)
    bak_sha = sha256_file(backup)
    if src_sha != bak_sha:
        try:
            backup.unlink()
        except OSError:
            pass
        raise RuntimeError("backup SHA-256 verification failed")
    return backup


def _atomic_replace_bytes(path: Path, data: bytes) -> None:
    _ensure_not_symlink(path)
    parent = path.parent
    _ensure_not_symlink(parent)
    fd, tmp_name = tempfile.mkstemp(prefix=f".{path.name}.pending-", dir=str(parent))
    tmp_path = Path(tmp_name)
    own_pending = True
    try:
        with os.fdopen(fd, "wb") as f:
            f.write(data)
            f.flush()
            os.fsync(f.fileno())
        _ensure_not_symlink(tmp_path)
        os.replace(tmp_path, path)
        own_pending = False
        try:
            dir_fd = os.open(str(parent), os.O_RDONLY)
            try:
                os.fsync(dir_fd)
            finally:
                os.close(dir_fd)
        except OSError:
            pass
    finally:
        if own_pending:
            try:
                tmp_path.unlink()
            except OSError:
                pass


def save_with_backup(
    json_path: os.PathLike[str] | str,
    json_bytes: bytes,
    header_bytes: Optional[bytes] = None,
    expected_sha256: Optional[str] = None,
    dry_run: bool = False,
) -> Dict[str, Any]:
    path = Path(json_path).expanduser()
    try:
        path = Path(os.path.abspath(os.fspath(path)))
    except OSError as exc:
        raise UnsafePathError(f"invalid save path: {json_path}") from exc

    companion_path = path.with_suffix("")
    have_header = header_bytes is not None

    if not dry_run:
        require_game_not_running()

    _ensure_not_symlink(path)
    if have_header:
        _ensure_not_symlink(companion_path)
    if path.exists():
        _ensure_not_symlink(path)
        if path.is_dir():
            raise UnsafePathError(f"save path is a directory: {path}")

    actual_sha: Optional[str] = None
    if path.exists() and path.is_file():
        actual_sha = sha256_file(path)
        if expected_sha256 is not None:
            expected = str(expected_sha256).strip().lower()
            if expected and actual_sha.lower() != expected:
                raise ShaMismatchError(
                    f"save SHA-256 mismatch: expected {expected}, got {actual_sha}"
                )

    if dry_run:
        return {
            "ok": True,
            "dryRun": True,
            "path": str(path),
            "sha256": sha256_bytes(json_bytes),
            "existingSha256": actual_sha,
            "companionPath": str(companion_path) if have_header else None,
            "headerSha256": sha256_bytes(header_bytes) if have_header else None,
            "backupPath": None,
            "companionBackupPath": None,
        }

    backup_path: Optional[Path] = None
    companion_backup_path: Optional[Path] = None
    try:
        if path.exists() and path.is_file():
            backup_path = _make_backup(path)
        if have_header and companion_path.exists() and companion_path.is_file():
            companion_backup_path = _make_backup(companion_path)

        _atomic_replace_bytes(path, json_bytes)
        if have_header:
            _atomic_replace_bytes(companion_path, header_bytes or b"")

        return {
            "ok": True,
            "path": str(path),
            "sha256": sha256_file(path),
            "headerSha256": sha256_file(companion_path) if have_header else None,
            "backupPath": str(backup_path) if backup_path else None,
            "companionBackupPath": str(companion_backup_path) if companion_backup_path else None,
            "companionPath": str(companion_path) if have_header else None,
        }
    except Exception:
        raise


def _clamp_int(value: Any) -> int:
    return _int_like(value, "value")


def _set_minimum(vb: Dict[str, Any], keys: Iterable[str], minimum: int) -> None:
    for key in keys:
        cur = vb.get(key, 0)
        try:
            cur_i = _int_like(cur, f"m_valueBase[{key}]")
        except ValueError:
            cur_i = 0
        if cur_i < minimum:
            _set_int_like(vb, key, minimum)


def _find_free_bag_slot(content: Dict[str, Any]) -> int:
    used = set()
    for k in content.keys():
        try:
            idx = int(str(k).strip(), 10)
            if idx >= SUB_SLOT_BAG_BEGIN:
                used.add(idx)
        except ValueError:
            pass
    slot = SUB_SLOT_BAG_BEGIN
    while slot in used:
        slot += 1
    return slot


def _sync_storage_count_min(storage: Dict[str, Any], min_slot: int) -> None:
    max_slot = min_slot
    content = storage.get("content")
    if isinstance(content, dict):
        for k in content.keys():
            try:
                idx = int(str(k).strip(), 10)
                if idx > max_slot:
                    max_slot = idx
            except ValueError:
                pass
    try:
        cur = _int_like(storage.get("count", 0), "itemStorage.count")
    except ValueError:
        cur = 0
    if cur < max_slot + 1:
        storage["count"] = max_slot + 1


def _collect_max_item_uid(content: Dict[str, Any]) -> int:
    max_uid = 0
    for k, v in content.items():
        if isinstance(v, dict) and "0" in v:
            try:
                max_uid = max(max_uid, _int_like(v.get("0"), "item uid"))
                continue
            except ValueError:
                pass
        try:
            max_uid = max(max_uid, _int_like(k, "item uid"))
        except ValueError:
            pass
    return max_uid


def _starter_kit(doc: Dict[str, Any], player: Dict[str, Any]) -> None:
    storage = player.get("itemStorage")
    if not isinstance(storage, dict):
        storage = {}
        player["itemStorage"] = storage
    content = storage.get("content")
    if not isinstance(content, dict):
        content = {}
        storage["content"] = content

    try:
        generator = _int_like(doc.get("m_ItemIdGenerator", 0), "m_ItemIdGenerator")
    except ValueError:
        generator = 0
    generator = max(generator, _collect_max_item_uid(content))

    additions = ((1001, 10), (1002, 10), (1003, 10), (1004, 10), (1005, 10))
    last_slot = SUB_SLOT_BAG_BEGIN - 1
    for proto, count in additions:
        generator += 1
        uid = generator
        slot = _find_free_bag_slot(content)
        last_slot = max(last_slot, slot)
        item_row: Dict[str, Any] = {
            "0": uid,
            "1": proto,
            "9": 10,
            "10": 1,
        }
        if count > 1:
            item_row["2"] = count
        content[str(slot)] = item_row
    _sync_storage_count_min(storage, last_slot)
    doc["m_ItemIdGenerator"] = generator


def apply_presets(
    doc: Dict[str, Any],
    presets: Sequence[str],
    money: Optional[int] = None,
    xiuwei: Optional[int] = None,
    ganwu: Optional[int] = None,
    attrs: Optional[Sequence[str]] = None,
    add_items: Optional[Sequence[str]] = None,
    jingjie: Optional[int] = None,
) -> Dict[str, Any]:
    _guid, player = _get_player_from_doc(doc)
    vb = _value_base(player)
    vb_dirty = not isinstance(player.get("m_valueBase"), str)
    applied: List[str] = []

    for preset in presets:
        if preset not in PRESET_DESCRIPTIONS:
            raise ValueError(f"unknown preset: {preset}")
        if preset == "rich_start":
            _set_int_like(vb, "68", 10000000)
            _set_int_like(vb, "69", 1000000)
            _set_int_like(vb, "70", 500000)
            _set_int_like(vb, "66", 5000)
            vb_dirty = True
        elif preset == "core_stats_500":
            _set_minimum(vb, [str(i) for i in range(4, 13)] + ["73"], 500)
            _set_minimum(vb, [str(i) for i in range(0, 4)], 50000)
            vb_dirty = True
        elif preset == "weapons_1000":
            _set_minimum(vb, [str(i) for i in range(34, 50)], 1000)
            vb_dirty = True
        elif preset == "life_master_1000":
            _set_minimum(vb, [str(i) for i in range(50, 66)], 1000)
            vb_dirty = True
        elif preset == "jingjie_13":
            player["jingjieGangLevel"] = 13
        elif preset == "starter_kit":
            _starter_kit(doc, player)
        applied.append(preset)

    if money is not None:
        _set_int_like(vb, "68", int(money))
        vb_dirty = True
    if xiuwei is not None:
        _set_int_like(vb, "69", int(xiuwei))
        vb_dirty = True
    if ganwu is not None:
        _set_int_like(vb, "70", int(ganwu))
        vb_dirty = True

    if attrs:
        for item in attrs:
            if "=" not in item:
                raise ValueError(f"attribute must be K=V: {item}")
            key, raw_val = item.split("=", 1)
            key = key.strip()
            if not key:
                raise ValueError("attribute key cannot be empty")
            try:
                val = int(raw_val.strip(), 10)
            except ValueError as exc:
                raise ValueError(f"attribute value must be an integer: {item}") from exc
            _set_int_like(vb, key, val)
            vb_dirty = True

    if vb_dirty:
        _write_value_base(player, vb)

    if jingjie is not None:
        jj = int(jingjie)
        if jj < 0 or jj > 13:
            raise ValueError("jingjie must be in 0..13")
        player["jingjieGangLevel"] = jj

    if add_items:
        storage = player.get("itemStorage")
        if not isinstance(storage, dict):
            storage = {}
            player["itemStorage"] = storage
        content = storage.get("content")
        if not isinstance(content, dict):
            content = {}
            storage["content"] = content
        try:
            generator = _int_like(doc.get("m_ItemIdGenerator", 0), "m_ItemIdGenerator")
        except ValueError:
            generator = 0
        generator = max(generator, _collect_max_item_uid(content))
        last_slot = SUB_SLOT_BAG_BEGIN - 1
        for item in add_items:
            if ":" not in item:
                raise ValueError(f"item must be PROTO:COUNT: {item}")
            proto_s, count_s = item.split(":", 1)
            try:
                proto = int(proto_s.strip(), 10)
                count = int(count_s.strip(), 10)
            except ValueError as exc:
                raise ValueError(f"invalid item spec: {item}") from exc
            if proto <= 0 or count <= 0:
                raise ValueError(f"item proto and count must be positive: {item}")
            generator += 1
            uid = generator
            slot = _find_free_bag_slot(content)
            last_slot = max(last_slot, slot)
            item_row = {
                "0": uid,
                "1": proto,
                "9": 1,
                "10": 1,
            }
            if count > 1:
                item_row["2"] = count
            content[str(slot)] = item_row
        _sync_storage_count_min(storage, last_slot)
        doc["m_ItemIdGenerator"] = generator

    normalize_write_property_json_root(doc)
    return {"playerGuid": _guid, "applied": applied}


def _write_companion_from_doc_if_possible(doc: Dict[str, Any]) -> Optional[bytes]:
    # Companion fields are not normally derived from JSON. Return None; callers
    # that loaded a companion can pass its bytes back explicitly.
    return None


def cmd_demo(args: argparse.Namespace) -> int:
    out_dir = Path(getattr(args, "out_dir", None) or getattr(args, "path", None) or "demo_saves").expanduser()
    out_dir.mkdir(parents=True, exist_ok=True)
    save_path = out_dir / "savefile0.json"
    header_path = out_dir / "savefile0"

    if (save_path.exists() or header_path.exists()) and not args.force:
        raise Nj2Error(f"demo output already exists in {out_dir}; use --force")

    guid = "1"
    now = _utc_now_iso()
    vb = {str(i): 100 + i for i in range(0, 95)}
    vb["68"] = 12345
    vb["69"] = 6789
    vb["70"] = 4321
    vb["71"] = 10
    vb["94"] = 2

    player: Dict[str, Any] = {
        "m_valueBase": _encode_json_field(vb),
        "itemStorage": {"count": 120, "content": {}},
        "name": "DemoHero",
        "jingjieGangLevel": 3,
        "m_GameTimeYear": 1,
        "m_GameTimeMonth": 3,
        "m_GameTimeDay": 15,
        "gongliRate": 100,
        "m_learntSpell": _encode_json_field({"0": [3, 4]}),
        "mijiIdList": _encode_json_field([10000]),
        "m_StuntIds": _encode_json_field([3400, 3401]),
        "m_EquipedStuntIds": _encode_json_field({"34": 3400}),
        "talents": _encode_json_field([1, 2]),
        "learnedpeifang": _encode_json_field([1001, 1002]),
        "m0": _encode_json_field([10000, 10010]),
        "m8": _encode_json_field([1]),
        "qgactive": _encode_json_field({"101": 1010}),
        "m_AchievementList": _encode_json_field([1, 2]),
    }

    content = player["itemStorage"]["content"]
    content["12"] = {"0": 1, "1": 10001, "2": 10, "9": 10, "10": 1}
    content["13"] = {"0": 2, "1": 10002, "4": 1.0, "9": 11, "10": 1}
    content["14"] = {"0": 3, "1": 10003, "2": 3, "9": 12, "10": 1}

    doc = {
        "version": "77",
        "playername": "DemoHero",
        "filename": "savefile0",
        "playerentity": {guid: player},
        "Entitys": {
            "2": {
                "guid": 2,
                "m_DaTiTime": 0.0,
                "m_valueBase": _encode_json_field({"0": 3200, "1": 900, "68": 500}),
            }
        },
        "m_ItemIdGenerator": 3,
        "maintaskName": "Demo Main Task",
        "m_GameDiff": 1,
        "posX": 0.0,
        "posZ": 0.0,
        "gameTime": 3600.5,
        "saveTime": now,
    }
    json_data = json.dumps(doc, ensure_ascii=True, separators=(",", ":")).encode("utf-8")
    meta = {
        "name": "DemoHero",
        "saveTime": now,
        "gameTime": "2024-01-01 00:00:00",
        "posX": "0.0",
        "posZ": "0.0",
        "filename": "savefile0.json",
        "saveFileVersion": "77",
        "gameDiff": "1",
        "modelId": "1",
        "maintaskName": "Demo Main Task",
        "gameType": "normal",
        "stringCount": 11,
    }
    header_data = encode_companion_header(meta)

    if save_path.exists() and args.force:
        save_path.unlink()
    if header_path.exists() and args.force:
        header_path.unlink()

    save_with_backup(save_path, json_data, header_bytes=header_data, expected_sha256=None, dry_run=False)
    _safe_print(json.dumps({"ok": True, "json": str(save_path), "header": str(header_path)}, ensure_ascii=True))
    return 0


def cmd_discover(args: argparse.Namespace) -> int:
    result = discover_saves(args.root)
    _safe_print(json.dumps(result, ensure_ascii=True, indent=2))
    return 0


def cmd_inspect(args: argparse.Namespace) -> int:
    try:
        result = inspect_save(args.save_path)
    except Exception as exc:
        if args.json:
            _safe_print(json.dumps({"ok": False, "error": str(exc)}, ensure_ascii=True))
        else:
            print(f"ERROR: {exc}", file=sys.stderr)
        return 1
    if args.json:
        _safe_print(json.dumps(result, ensure_ascii=True, indent=2))
    else:
        summary = result.get("summary", {})
        print(f"Path: {result.get('path')}")
        print(f"SHA-256: {result.get('sha256')}")
        print(f"Player GUID: {summary.get('playerGuid')}")
        print(f"Player name: {summary.get('playerName')}")
        print(f"Money (68): {summary.get('money')}")
        print(f"XiuWei (69): {summary.get('xiuwei')}")
        print(f"GanWu (70): {summary.get('ganwu')}")
        print(f"Items: {summary.get('itemCount')}")
        print(f"Jingjie: {summary.get('jingjie')}")
        header = result.get("header")
        if header:
            print(f"Header: {header.get('path')} ({header.get('stringCount')} strings)")
        else:
            print("Header: absent")
    return 0


def cmd_validate(args: argparse.Namespace) -> int:
    path = Path(args.save_path)
    errors: List[str] = []
    try:
        raw = path.read_bytes()
        sha256_bytes(raw)
    except Exception as exc:
        errors.append(f"cannot read save: {exc}")
        raw = b""
    doc: Any = None
    if not errors:
        try:
            doc = json.loads(raw.decode("utf-8-sig"))
        except Exception as exc:
            errors.append(f"invalid JSON: {exc}")
    if doc is not None:
        errors.extend(validate_doc(doc))
    companion = path.with_suffix("")
    header_info: Dict[str, Any] = {"present": companion.exists()}
    if companion.exists():
        try:
            hraw = companion.read_bytes()
            meta = parse_companion_header(hraw)
            header_info["stringCount"] = meta.get("stringCount")
            header_info["saveFileVersion"] = meta.get("saveFileVersion")
            version = str(meta.get("saveFileVersion", "") or "")
            if version.isdigit():
                expected = 10 if int(version) <= 76 else 11
                if int(meta.get("stringCount", 0)) != expected:
                    errors.append(f"header string count {meta.get('stringCount')} does not match version {version}")
        except Exception as exc:
            errors.append(f"invalid companion header: {exc}")
    result = {"ok": not errors, "path": str(path.absolute()), "errors": errors, "header": header_info}
    _safe_print(json.dumps(result, ensure_ascii=True, indent=2))
    return 0 if not errors else 1


def cmd_presets(_args: argparse.Namespace) -> int:
    output = {
        "presets": [
            {"id": pid, "description": PRESET_DESCRIPTIONS[pid]}
            for pid in PRESET_ORDER
        ]
    }
    _safe_print(json.dumps(output, ensure_ascii=True, indent=2))
    return 0



def cmd_edit(args: argparse.Namespace) -> int:
    src = Path(args.save_path).expanduser().resolve()
    _ensure_not_symlink(src)
    if not src.is_file():
        raise Nj2Error(f"save file not found: {src}")

    raw_src = src.read_bytes()
    has_bom = raw_src.startswith(b"\xef\xbb\xbf")
    try:
        doc = json.loads(raw_src.decode("utf-8-sig"))
    except UnicodeDecodeError as exc:
        raise ValidationError("save JSON is not valid UTF-8") from exc
    except json.JSONDecodeError as exc:
        raise ValidationError(f"save JSON is invalid: {exc}") from exc
    errors = validate_doc(doc, strict_strings=False)
    if errors:
        raise ValidationError("; ".join(errors))

    apply_presets(
        doc,
        args.preset or [],
        money=args.money,
        xiuwei=args.xiuwei,
        ganwu=args.ganwu,
        attrs=args.attr,
        add_items=args.add_item,
        jingjie=args.jingjie,
    )

    post_errors = validate_doc(doc, strict_strings=True)
    if post_errors:
        raise ValidationError("; ".join(post_errors))

    json_bytes = (b"\xef\xbb\xbf" if has_bom else b"") + json.dumps(doc, ensure_ascii=False, indent=2).encode("utf-8")

    header_bytes: Optional[bytes] = None
    companion = src.with_suffix("")
    if companion.is_file():
        _ensure_not_symlink(companion)
        header_bytes = companion.read_bytes()

    out_path = getattr(args, "out", None) or getattr(args, "output", None)
    dst = Path(out_path).expanduser().resolve() if out_path else src
    expected = getattr(args, "expected_sha256", None)
    if expected is None and dst.exists() and not getattr(args, "dry_run", False):
        expected = sha256_file(dst)

    result = save_with_backup(
        dst,
        json_bytes,
        header_bytes=header_bytes,
        expected_sha256=expected,
        dry_run=bool(getattr(args, "dry_run", False)),
    )
    summary = {"ok": True, "path": str(dst), "bytes": len(json_bytes)}
    if isinstance(result, dict):
        summary.update(result)
    if header_bytes is not None:
        summary.setdefault("headerBytes", len(header_bytes))
    _safe_print(json.dumps(summary, ensure_ascii=True, sort_keys=True))
    return 0


def _find_html_path(explicit_html: Optional[str]) -> Path:
    from pathlib import Path

    if explicit_html:
        path = Path(explicit_html).expanduser()
        if not path.is_absolute():
            path = (Path.cwd() / path).resolve()
        else:
            path = path.resolve()
        if not path.is_file():
            raise Nj2Error(f"HTML file not found: {path}")
        return path

    search_roots = []
    try:
        search_roots.append(Path(__file__).resolve().parent)
    except NameError:
        pass
    search_roots.append(Path.cwd().resolve())

    seen = set()
    for root in search_roots:
        for candidate in HTML_CANDIDATES:
            path = (root / candidate).resolve()
            if path in seen:
                continue
            seen.add(path)
            if path.is_file():
                return path

    names = ", ".join(str(p) for p in HTML_CANDIDATES)
    raise Nj2Error(f"could not find editor HTML; looked for {names}")


def _prepare_served_html(html_bytes: bytes, token: str) -> bytes:
    html = html_bytes.decode("utf-8")

    # Allow same-origin API fetches from the served page while leaving any
    # stricter directive that is not connect-src untouched.
    if "connect-src 'none'" in html:
        html = html.replace("connect-src 'none'", "connect-src 'self'")
    elif "connect-src 'self'" not in html:
        lower = html.lower()
        idx = lower.find("content-security-policy")
        if idx >= 0:
            meta_end = lower.find(">", idx)
            if meta_end >= 0:
                meta = html[idx:meta_end]
                if "connect-src" not in meta:
                    if ";" in meta:
                        html = html[:meta_end] + "; connect-src 'self'" + html[meta_end:]
                    else:
                        html = html[:meta_end] + " connect-src 'self'" + html[meta_end:]

    token_json = token.replace("\\", "\\\\").replace('"', '\\"')
    injection = (
        "<script>"
        f'window.__NJ2_TOKEN__ = "{token_json}"; '
        f'window.__NJ2_SERVER__ = {{token: "{token_json}", mode: "python"}};'
        "</script>"
    )

    lower = html.lower()
    head_close = lower.find("</head>")
    if head_close >= 0:
        html = html[:head_close] + injection + html[head_close:]
    else:
        script_open = lower.find("<script")
        if script_open >= 0:
            html = html[:script_open] + injection + html[script_open:]
        else:
            html = injection + html

    return html.encode("utf-8")


class _Nj2RequestHandler(http.server.BaseHTTPRequestHandler):
    server_version = "NJ2Editor/1.0"
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt: str, *args: object) -> None:
        if getattr(self.server, "verbose", False):
            super().log_message(fmt, *args)

    def _server_port(self) -> int:
        try:
            return int(self.server.server_address[1])
        except Exception:
            return int(getattr(self.server, "port", 0))

    def _host_ok(self) -> bool:
        host = self.headers.get("Host", "")
        port = self._server_port()
        allowed = {
            f"127.0.0.1:{port}",
            f"localhost:{port}",
            f"[::1]:{port}",
        }
        return host in allowed

    def _origin_ok(self) -> bool:
        origin = self.headers.get("Origin")
        if not origin:
            return True
        port = self._server_port()
        allowed = {
            f"http://127.0.0.1:{port}",
            f"http://localhost:{port}",
        }
        return origin in allowed

    def _fetch_site_ok(self) -> bool:
        site = self.headers.get("Sec-Fetch-Site")
        if not site:
            return True
        return site in ("same-origin", "none")

    def _token_ok(self) -> bool:
        supplied = self.headers.get("X-NJ2-Token", "")
        expected = getattr(self.server, "token", "")
        if not supplied or not expected:
            return False
        return hmac.compare_digest(str(supplied), str(expected))

    def _send_json(self, status: int, payload: dict) -> None:
        body = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Connection", "close")
        self.end_headers()
        try:
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def _send_html(self, body: bytes) -> None:
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Connection", "close")
        self.end_headers()
        try:
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def _security_gate(self, require_token: bool) -> bool:
        if not self._host_ok():
            self._send_json(403, {"ok": False, "error": "invalid host header"})
            return False
        if not self._origin_ok():
            self._send_json(403, {"ok": False, "error": "invalid origin header"})
            return False
        if not self._fetch_site_ok():
            self._send_json(403, {"ok": False, "error": "invalid sec-fetch-site header"})
            return False
        if require_token and not self._token_ok():
            self._send_json(401, {"ok": False, "error": "invalid or missing token"})
            return False
        return True

    def _read_json_body(self) -> dict:
        length_header = self.headers.get("Content-Length")
        if not length_header:
            raise BadRequestError("missing Content-Length")
        try:
            length = int(length_header)
        except ValueError as exc:
            raise BadRequestError("invalid Content-Length") from exc
        if length < 0 or length > MAX_REQUEST_BODY:
            raise BadRequestError("request body too large")
        raw = self.rfile.read(length)
        if len(raw) != length:
            raise BadRequestError("incomplete request body")
        try:
            payload = json.loads(raw.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise BadRequestError("invalid JSON body") from exc
        if not isinstance(payload, dict):
            raise BadRequestError("JSON body must be an object")
        return payload

    def do_GET(self) -> None:
        try:
            parsed = urllib.parse.urlsplit(self.path)
            route = parsed.path

            if route == "/":
                if not self._security_gate(require_token=False):
                    return
                self._send_html(self.server.prepared_html)
                return

            if route == "/api/health":
                if not self._security_gate(require_token=False):
                    return
                self._send_json(200, {"ok": True})
                return

            if route == "/api/slots":
                if not self._security_gate(require_token=True):
                    return
                result = discover_saves(root=self.server.root_dir)
                if isinstance(result, dict):
                    payload = {"ok": True}
                    payload.update(result)
                elif isinstance(result, (list, tuple)):
                    payload = {"ok": True, "slots": list(result), "saves": list(result)}
                else:
                    payload = {"ok": True, "slots": result, "saves": result}
                self._send_json(200, payload)
                return

            self._send_json(404, {"ok": False, "error": "not found"})
        except Exception as exc:
            if getattr(self.server, "verbose", False):
                import traceback
                traceback.print_exc()
            self._send_json(500, {"ok": False, "error": str(exc)})

    def do_POST(self) -> None:
        try:
            parsed = urllib.parse.urlsplit(self.path)
            route = parsed.path

            if route == "/api/load":
                if not self._security_gate(require_token=True):
                    return
                payload = self._read_json_body()
                raw_path = payload.get("path")
                if not isinstance(raw_path, str) or not raw_path:
                    raise BadRequestError("path must be a non-empty string")

                path = Path(raw_path).expanduser()
                if not path.is_absolute():
                    path = (self.server.root_dir / path).resolve()
                else:
                    path = path.resolve()

                _ensure_not_symlink(path)
                if not path.is_file():
                    raise BadRequestError(f"save file not found: {path}")

                raw_json = path.read_bytes()
                try:
                    text = raw_json.decode("utf-8-sig")
                    doc = json.loads(text)
                except (UnicodeDecodeError, json.JSONDecodeError) as exc:
                    raise ValidationError("save is not valid UTF-8 JSON") from exc
                errs = validate_doc(doc)
                if errs:
                    raise ValidationError("; ".join(errs))

                header_bytes = b""
                companion = path.with_suffix("")
                companion_path = None
                if companion.is_file():
                    _ensure_not_symlink(companion)
                    header_bytes = companion.read_bytes()
                    companion_path = str(companion)

                self._send_json(
                    200,
                    {
                        "ok": True,
                        "path": str(path),
                        "sha256": sha256_bytes(raw_json),
                        "jsonBase64": base64.b64encode(raw_json).decode("ascii"),
                        "headerBase64": base64.b64encode(header_bytes).decode("ascii"),
                        "companionPath": companion_path,
                    },
                )
                return

            if route == "/api/save":
                if not self._security_gate(require_token=True):
                    return
                payload = self._read_json_body()

                raw_path = payload.get("path")
                if not isinstance(raw_path, str) or not raw_path:
                    raise BadRequestError("path must be a non-empty string")

                path = Path(raw_path).expanduser()
                if not path.is_absolute():
                    path = (self.server.root_dir / path).resolve()
                else:
                    path = path.resolve()

                _ensure_not_symlink(path)

                json_base64 = payload.get("jsonBase64")
                json_text = payload.get("jsonText")
                if isinstance(json_base64, str):
                    try:
                        json_bytes = base64.b64decode(json_base64.encode("ascii"), validate=True)
                    except Exception as exc:
                        raise BadRequestError("invalid jsonBase64") from exc
                elif isinstance(json_text, str):
                    json_bytes = json_text.encode("utf-8")
                else:
                    raise BadRequestError("jsonBase64 or jsonText is required")

                try:
                    doc = json.loads(json_bytes.decode("utf-8-sig"))
                except (UnicodeDecodeError, json.JSONDecodeError) as exc:
                    raise ValidationError("save data is not valid UTF-8 JSON") from exc
                errs = validate_doc(doc)
                if errs:
                    raise ValidationError("; ".join(errs))

                header_bytes = None
                header_base64 = payload.get("headerBase64")
                if isinstance(header_base64, str):
                    try:
                        header_bytes = base64.b64decode(header_base64.encode("ascii"), validate=True)
                    except Exception as exc:
                        raise BadRequestError("invalid headerBase64") from exc
                    if header_bytes:
                        parse_companion_header(header_bytes)

                expected_sha256 = payload.get("expectedSha256")
                if expected_sha256 is None:
                    expected_sha256 = payload.get("expected_sha256")
                if expected_sha256 is not None and not isinstance(expected_sha256, str):
                    raise BadRequestError("expectedSha256 must be a string")

                result = save_with_backup(
                    path,
                    json_bytes,
                    header_bytes=header_bytes,
                    expected_sha256=expected_sha256,
                )

                response = {"ok": True, "path": str(path), "sha256": sha256_bytes(json_bytes)}
                if isinstance(result, dict):
                    response.update(result)
                elif result is not None:
                    response["result"] = result
                self._send_json(200, response)
                return

            self._send_json(404, {"ok": False, "error": "not found"})
        except ShaMismatchError as exc:
            self._send_json(409, {"ok": False, "error": str(exc), "code": "sha_mismatch"})
        except GameRunningError as exc:
            self._send_json(409, {"ok": False, "error": str(exc), "code": "game_running"})
        except UnsafePathError as exc:
            self._send_json(403, {"ok": False, "error": str(exc), "code": "unsafe_path"})
        except (ValidationError, BadRequestError) as exc:
            self._send_json(400, {"ok": False, "error": str(exc)})
        except Exception as exc:
            if getattr(self.server, "verbose", False):
                import traceback
                traceback.print_exc()
            self._send_json(500, {"ok": False, "error": str(exc)})


def cmd_serve(args: argparse.Namespace) -> int:
    import http.server
    import secrets
    import threading
    import webbrowser

    html_path = _find_html_path(getattr(args, "html", None))
    html_bytes = html_path.read_bytes()
    token = secrets.token_hex(32)
    prepared_html = _prepare_served_html(html_bytes, token)

    root_value = getattr(args, "root", None)
    if root_value:
        root_dir = Path(root_value).expanduser()
        if not root_dir.is_absolute():
            root_dir = (Path.cwd() / root_dir).resolve()
        else:
            root_dir = root_dir.resolve()
    else:
        root_dir = Path.cwd().resolve()
    if not root_dir.is_dir():
        raise Nj2Error(f"root directory not found: {root_dir}")

    requested_port = int(getattr(args, "port", 0) or 0)
    bind_host = "127.0.0.1"

    server = http.server.ThreadingHTTPServer((bind_host, requested_port), _Nj2RequestHandler)
    server.root_dir = root_dir
    server.token = token
    server.prepared_html = prepared_html
    server.verbose = bool(getattr(args, "verbose", False))
    actual_port = int(server.server_address[1])
    server.port = actual_port

    url = f"http://127.0.0.1:{actual_port}/"
    print(
        json.dumps(
            {
                "ok": True,
                "url": url,
                "host": bind_host,
                "port": actual_port,
                "root": str(root_dir),
                "html": str(html_path),
            },
            ensure_ascii=False,
            sort_keys=True,
        ),
        flush=True,
    )

    no_browser = bool(getattr(args, "no_browser", False))
    if os.environ.get("NJ2_NO_BROWSER") == "1":
        no_browser = True
    if not no_browser and actual_port > 0:
        def _open_browser() -> None:
            try:
                webbrowser.open(url, new=2)
            except Exception:
                pass

        threading.Timer(0.25, _open_browser).start()

    try:
        server.serve_forever(poll_interval=0.25)
    except KeyboardInterrupt:
        pass
    finally:
        try:
            server.shutdown()
        except Exception:
            pass
        try:
            server.server_close()
        except Exception:
            pass
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="nj2_editor.py",
        description="Next Jianghu 2 save editor utility",
    )
    parser.add_argument("-v", "--verbose", action="store_true", help="enable verbose output")

    subparsers = parser.add_subparsers(dest="command", required=True)

    demo_parser = subparsers.add_parser("demo", help="write a demonstration save")
    demo_parser.add_argument("path", nargs="?", default=None, help="output directory")
    demo_parser.add_argument("--out-dir", dest="out_dir", default=None, help="output directory")
    demo_parser.add_argument("--force", action="store_true", help="overwrite existing demo files")
    demo_parser.set_defaults(func=cmd_demo)

    discover_parser = subparsers.add_parser("discover", help="discover save files")
    discover_parser.add_argument("--root", default=None, help="root directory to search")
    discover_parser.set_defaults(func=cmd_discover)

    inspect_parser = subparsers.add_parser("inspect", help="inspect a save file")
    inspect_parser.add_argument("save_path", help="save file path")
    inspect_parser.add_argument("--json", action="store_true", help="output JSON")
    inspect_parser.set_defaults(func=cmd_inspect)

    validate_parser = subparsers.add_parser("validate", help="validate a save file")
    validate_parser.add_argument("save_path", help="save file path")
    validate_parser.set_defaults(func=cmd_validate)

    presets_parser = subparsers.add_parser("presets", help="list available presets")
    presets_parser.set_defaults(func=cmd_presets)

    edit_parser = subparsers.add_parser("edit", help="apply edits/presets and save a file")
    edit_parser.add_argument("save_path", help="save file path")
    edit_parser.add_argument("-o", "--out", "--output", dest="out", default=None, help="output save path")
    edit_parser.add_argument("--preset", action="append", default=[], help="preset id")
    edit_parser.add_argument("--money", type=int, default=None, help="set money (attr 68)")
    edit_parser.add_argument("--xiuwei", type=int, default=None, help="set xiuwei (attr 69)")
    edit_parser.add_argument("--ganwu", type=int, default=None, help="set ganwu (attr 70)")
    edit_parser.add_argument("--attr", action="append", default=[], help="set attribute K=V")
    edit_parser.add_argument("--add-item", action="append", default=[], help="add item PROTO:COUNT")
    edit_parser.add_argument("--jingjie", type=int, default=None, help="set jingjie level 0..13")
    edit_parser.add_argument("--expected-sha256", default=None, help="required current SHA-256")
    edit_parser.add_argument("--dry-run", action="store_true", help="validate and summarize without writing")
    edit_parser.set_defaults(func=cmd_edit)

    serve_parser = subparsers.add_parser("serve", help="serve the local editor UI")
    serve_parser.add_argument("--html", default=None, help="explicit editor HTML path")
    serve_parser.add_argument("--root", default=None, help="save root directory")
    serve_parser.add_argument("--port", type=int, default=0, help="loopback port (0 chooses one)")
    serve_parser.add_argument("--no-browser", action="store_true", help="do not open a browser")
    serve_parser.set_defaults(func=cmd_serve)

    return parser


def main(argv: Optional[list] = None) -> int:
    parser = build_parser()
    try:
        args = parser.parse_args(argv)
        return int(args.func(args))
    except KeyboardInterrupt:
        return 130
    except Nj2Error as exc:
        print(json.dumps({"ok": False, "error": str(exc)}, ensure_ascii=True), file=sys.stderr)
        return 1
    except Exception as exc:
        print(json.dumps({"ok": False, "error": str(exc)}, ensure_ascii=True), file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
