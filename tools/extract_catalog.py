#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Next Jianghu II Save Editor catalog extractor.

Extracts a pure-Korean catalog from:
  - db1.txt (main table dump)
  - local_text_string.txt (string localization table)
  - corpus/*.json (codex, companion data)

Emits src/catalog-data.js as a UMD module (Nj2Catalog).

Usage:
    python3 tools/extract_catalog.py              # generate
    python3 tools/extract_catalog.py --check-only # validate
"""

import argparse
import json
import os
import re
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)

DB1_PATH = "/home/jiyoung/workspace/무협위키/.local/graph/next-jianghu-2-data/build_26585359/upgraded_bepinex/db1.txt"
LTS_PATH = "/home/jiyoung/workspace/무협위키/.local/graph/next-jianghu-2-data/build_26585359/upgraded_bepinex/local_text_string.txt"
CORPUS_DIR = "/home/jiyoung/workspace/무협위키/games/next-jianghu-2/corpus"
OUTPUT_PATH = os.path.join(ROOT, "src", "catalog-data.js")

TAG_RE = re.compile(r"<[^>]*>")
BRACKET_RE = re.compile(r"[\u3010\u3011\u300c\u300d\u300e\u300f\u3014\u3015\u300a\u300b\u3008\u3009\[\]\{\}<>]")
HANZI_RE = re.compile(r"[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF]")
KANA_RE = re.compile(r"[\u3040-\u30FF]")
WS_RE = re.compile(r"\s+")
HTML_ENT_RE = re.compile(r"&[a-zA-Z#0-9]{2,8};")


def sanitize(text):
    """Strip tags, brackets, Hanzi, Kana; normalize whitespace."""
    if not text:
        return ""
    s = str(text)
    s = TAG_RE.sub("", s)
    s = HTML_ENT_RE.sub(" ", s)
    s = BRACKET_RE.sub(" ", s)
    s = HANZI_RE.sub(" ", s)
    s = KANA_RE.sub(" ", s)
    s = WS_RE.sub(" ", s).strip()
    return s


def safe_name(text, fallback_id, kind="항목"):
    cleaned = sanitize(text)
    if not cleaned:
        return "{} {}".format(kind, fallback_id)
    return cleaned


def truncate(text, limit):
    if not text:
        return ""
    if len(text) <= limit:
        return text
    return text[: limit - 1].rstrip() + "…"


def read_tables(path):
    """Parse a `table|count` header dump into {table: [rows_of_cols]}."""
    tables = {}
    if not os.path.isfile(path):
        sys.stderr.write("missing file: %s\n" % path)
        return tables
    with open(path, "r", encoding="utf-8", errors="replace") as f:
        raw = f.read()
    lines = raw.split("\n")
    i = 0
    n = len(lines)
    while i < n:
        line = lines[i].rstrip("\r")
        i += 1
        if not line.strip() or "|" not in line:
            continue
        head, _, tail = line.partition("|")
        head = head.strip()
        tail = tail.strip()
        try:
            count = int(tail)
        except ValueError:
            continue
        rows = []
        for _ in range(count):
            if i >= n:
                break
            rows.append(lines[i].rstrip("\r").split("#"))
            i += 1
        tables[head] = rows
    return tables


ATTRI_CATEGORIES = (
    ["core"] * 20        # 0..19: 기혈, 진기, 현재체력, 현재진기, 원기..호방
    + ["combat"] * 14    # 20..33: 외공..독, 경공치
    + ["weapon"] * 8     # 34..41: 도법..독기술
    + ["doctrine"] * 8   # 42..49: 도학..농학
    + ["life"] * 16      # 50..65: 연단..재배
    + ["resource"] * 8   # 66..73: 위망, 도덕, 동전, 수위, 감오, 정사, 등급, 오성
    + ["extra"] * 21     # 74..94: 명중..포쾌
)
assert len(ATTRI_CATEGORIES) == 95

CATEGORY_DEFAULT = {
    "core": "기본 능력",
    "combat": "전투 능력",
    "weapon": "무기 숙련",
    "doctrine": "학식 소양",
    "life": "생활 기예",
    "resource": "자원 명성",
    "extra": "보조 능력",
}


def default_attri_name(index):
    return "{} {}".format(CATEGORY_DEFAULT[ATTRI_CATEGORIES[index]], index)


def extract_stringlang(tables):
    out = {}
    for row in tables.get("stringlang", []):
        if len(row) < 2:
            continue
        try:
            sid = int(row[0])
        except ValueError:
            continue
        text = sanitize(row[1])
        if text:
            out[sid] = text
    return out


def extract_local_text(path):
    """Read local_text_string.txt (either plain lines or table|count format)."""
    by_id = {}
    by_key = {}
    attri_by_id = {}
    if not os.path.isfile(path):
        return by_id, by_key, attri_by_id
    with open(path, "r", encoding="utf-8", errors="replace") as f:
        for line in f:
            line = line.rstrip("\r\n")
            if "#" not in line:
                continue
            row = line.split("#")
            if len(row) < 3:
                continue
            try:
                sid = int(row[0])
            except ValueError:
                continue
            key = row[1].strip()
            text = sanitize(row[2])
            by_id[sid] = text
            if key:
                by_key[key] = text
                if key.startswith("attriName_") and 1 <= sid <= 95:
                    attri_by_id[sid - 1] = text
    return by_id, by_key, attri_by_id


def build_attri_types(attri_by_id):
    result = []
    for idx in range(95):
        cat = ATTRI_CATEGORIES[idx]
        text = attri_by_id.get(idx, "")
        name = safe_name(text, idx, "속성") if text else default_attri_name(idx)
        result.append({"index": idx, "cat": cat, "name": name})
    return result


def resolve(text_map, sl_id, fallback_id, kind="항목"):
    try:
        sl = int(sl_id)
    except (ValueError, TypeError):
        return safe_name("", fallback_id, kind)
    return safe_name(text_map.get(sl, ""), fallback_id, kind)


def extract_item_base(tables, text_map):
    out = []
    for row in tables.get("item_base", []):
        if len(row) < 16:
            continue
        try:
            iid = int(row[0])
            grade = int(row[4]) if row[4].strip() else 10
        except ValueError:
            continue
        # row[1] in item_base is direct Korean text (not a stringlang ID)
        name = safe_name(row[1], iid, "아이템")
        main_type = sanitize(row[2]) or "0"
        sub_type = sanitize(row[3]) or "0"
        try:
            price = int(row[6]) if row[6].strip() else 0
        except ValueError:
            price = 0
        desc = resolve(text_map, row[15], iid, "아이템")
        if desc.startswith("아이템 "):
            desc = ""
        out.append({
            "id": iid,
            "name": name,
            "mainType": main_type,
            "subType": sub_type,
            "grade": grade,
            "price": price,
            "desc": truncate(desc, 100),
        })
    return out


def extract_spellprotype(tables, text_map):
    out = []
    for row in tables.get("spellprotype", []):
        if len(row) < 6:
            continue
        try:
            sid = int(row[0])
        except ValueError:
            continue
        name = resolve(text_map, row[2], sid, "무공")
        if name.startswith("무공 ") and row[3].strip():
            name = safe_name(row[3], sid, "무공")
        desc = resolve(text_map, row[5], sid, "무공")
        if desc.startswith("무공 "):
            desc = ""
        if not name or name.startswith("무공 ") or "테스트" in name or "공용 효과" in name or "공용효과" in name:
            continue
        try:
            spell_type = int(row[8]) if len(row) > 8 and row[8].strip() else 0
        except ValueError:
            spell_type = 0
        out.append({"id": sid, "spellType": spell_type, "name": name, "desc": truncate(desc, 90)})
    return out


def extract_talent_proto(tables, text_map):
    out = []
    for row in tables.get("talent_proto", []):
        if len(row) < 4:
            continue
        try:
            tid = int(row[0])
        except ValueError:
            continue
        name = resolve(text_map, row[1], tid, "재능")
        if name.startswith("재능 ") and row[2].strip():
            name = safe_name(row[2], tid, "재능")
        desc = resolve(text_map, row[3], tid, "재능")
        if desc.startswith("재능 "):
            desc = ""
        out.append({"id": tid, "name": name, "desc": truncate(desc, 90)})
    return out


def extract_stunt_proto(tables, text_map):
    out = []
    for row in tables.get("stunt_proto", []):
        if len(row) < 4:
            continue
        try:
            sid = int(row[0])
        except ValueError:
            continue
        name = resolve(text_map, row[1], sid, "기예")
        desc = resolve(text_map, row[3], sid, "기예")
        if desc.startswith("기예 "):
            desc = ""
        try:
            stunt_type = int(row[5]) if len(row) > 5 and row[5].strip() else 0
        except ValueError:
            stunt_type = 0
        out.append({"id": sid, "stuntType": stunt_type, "name": name, "desc": truncate(desc, 90)})
    return out


def extract_jingmai_node(tables, text_map):
    out = []
    for row in tables.get("jingmai_node", []):
        if len(row) < 16:
            continue
        try:
            nid = int(row[0])
            node_id = int(row[4])
        except ValueError:
            continue
        try:
            jm_type = int(row[1]) if row[1].strip() else 1
        except ValueError:
            jm_type = 1
        try:
            jm_group = int(row[6]) if row[6].strip() else 0
        except ValueError:
            jm_group = 0
        name = resolve(text_map, row[14], nid, "경맥")
        desc = resolve(text_map, row[15], nid, "경맥")
        if desc.startswith("경맥 "):
            desc = ""
        out.append({"id": nid, "nodeId": node_id, "type": jm_type, "group": jm_group, "name": name, "desc": truncate(desc, 90)})
    return out


def extract_jingjie_node(tables, text_map):
    out = []
    for row in tables.get("jingjie_node", []):
        if len(row) < 19:
            continue
        try:
            nid = int(row[0])
            node_id = int(row[4])
        except ValueError:
            continue
        name = resolve(text_map, row[17], nid, "경계")
        desc = resolve(text_map, row[18], nid, "경계")
        if desc.startswith("경계 "):
            desc = ""
        out.append({"id": nid, "nodeId": node_id, "name": name, "desc": truncate(desc, 90)})
    return out


def extract_qinggong_node(tables, text_map):
    out = []
    for row in tables.get("qinggong_node", []):
        if len(row) < 8:
            continue
        try:
            nid = int(row[0])
        except ValueError:
            continue
        name = resolve(text_map, row[6], nid, "경공")
        desc = resolve(text_map, row[7], nid, "경공")
        if desc.startswith("경공 "):
            desc = ""
        try:
            group_id = int(row[3]) if row[3].strip() else (nid // 10)
        except ValueError:
            group_id = nid // 10
        try:
            level = int(row[4]) if row[4].strip() else 1
        except ValueError:
            level = 1
        out.append({"id": nid, "groupId": group_id, "level": level, "name": name, "desc": truncate(desc, 90)})
    return out


def extract_menpai(tables, text_map):
    out = []
    for row in tables.get("menpai", []):
        if len(row) < 3:
            continue
        try:
            mid = int(row[0])
        except ValueError:
            continue
        if mid == 0:
            continue
        name = resolve(text_map, row[2], mid, "문파")
        if not name or name.startswith("문파 ") or "불명" in name:
            continue
        out.append({"id": mid, "name": name})
    return out


def extract_achievement(tables, text_map):
    out = []
    for row in tables.get("achievement", []):
        if len(row) < 3:
            continue
        try:
            aid = int(row[0])
        except ValueError:
            continue
        name = resolve(text_map, row[1], aid, "업적")
        if name.startswith("업적 ") and row[2].strip():
            name = safe_name(row[2], aid, "업적")
        out.append({"id": aid, "name": name})
    return out


def extract_questproto(tables, text_map):
    out = []
    for row in tables.get("questprototype", []):
        if len(row) < 17:
            continue
        try:
            qid = int(row[0])
        except ValueError:
            continue
        name = resolve(text_map, row[14], qid, "퀘스트")
        if not name or name.startswith("퀘스트 "):
            continue
        desc = resolve(text_map, row[16], qid, "퀘스트")
        if desc.startswith("퀘스트 "):
            desc = ""
        out.append({"id": qid, "name": name, "desc": truncate(desc, 90)})
    return out


def extract_wordentry(tables, text_map):
    out = []
    seen = set()
    for row in tables.get("wordentry", []):
        if len(row) < 9:
            continue
        try:
            wid = int(row[0])
        except ValueError:
            continue
        desc = resolve(text_map, row[8], wid, "용어")
        if not desc or desc.startswith("용어 ") or len(desc) < 2:
            continue
        key = desc[:48]
        if key in seen:
            continue
        seen.add(key)
        out.append({"id": wid, "desc": truncate(desc, 120)})
        if len(out) >= 600:
            break
    return out


def _load_json(path):
    if not os.path.isfile(path):
        return None
    try:
        with open(path, "r", encoding="utf-8", errors="replace") as f:
            return json.load(f)
    except (ValueError, OSError):
        return None


def extract_companions(tables, text_map):
    out = []
    seen = set()
    dash = _load_json(os.path.join(CORPUS_DIR, "companion-dashboard.json"))
    if isinstance(dash, dict):
        comps = dash.get("companions")
        if isinstance(comps, list):
            for entry in comps:
                if not isinstance(entry, dict):
                    continue
                name = sanitize(entry.get("name_ko") or entry.get("name") or "")
                if not name or name in seen:
                    continue
                seen.add(name)
                out.append({
                    "id": entry.get("uid") or entry.get("id") or 0,
                    "name": name,
                    "title": sanitize(entry.get("title_ko") or entry.get("title") or ""),
                    "sect": sanitize(entry.get("sect_ko") or entry.get("sect") or ""),
                })
    generic = {"마을 사람", "강호인", "산적", "경비병", "관병"}
    for row in tables.get("npc_prototype", []):
        if len(row) < 3:
            continue
        try:
            pid = int(row[0])
        except ValueError:
            continue
        name = sanitize(row[1])
        if not name or len(name) < 2 or name in generic or name in seen:
            continue
        seen.add(name)
        out.append({"id": pid, "name": name, "title": "", "sect": ""})
        if len(out) >= 400:
            break
    return out[:400]


def extract_codex():
    out = []
    data = _load_json(os.path.join(CORPUS_DIR, "codex-atlas.json"))
    if not isinstance(data, dict):
        return out
    entries = data.get("entries")
    if not isinstance(entries, list):
        return out
    for entry in entries:
        if not isinstance(entry, dict):
            continue
        name = sanitize(entry.get("name_ko") or entry.get("name") or "")
        if not name:
            continue
        out.append({
            "id": entry.get("id") or 0,
            "category": sanitize(entry.get("category") or ""),
            "subType": sanitize(entry.get("sub_type") or entry.get("subType") or ""),
            "name": name,
            "tier": sanitize(entry.get("tier") or ""),
            "effects": truncate(sanitize(entry.get("effects") or ""), 120),
        })
        if len(out) >= 580:
            break
    return out


def build_catalog():
    db1_tables = read_tables(DB1_PATH)
    lts_by_id, _, attri_by_id = extract_local_text(LTS_PATH)
    text_by_id = extract_stringlang(db1_tables)
    for sid, text in lts_by_id.items():
        if text and sid not in text_by_id:
            text_by_id[sid] = text

    return {
        "version": "1.0",
        "generated": True,
        "attriTypes": build_attri_types(attri_by_id),
        "items": extract_item_base(db1_tables, text_by_id),
        "spells": extract_spellprotype(db1_tables, text_by_id),
        "talents": extract_talent_proto(db1_tables, text_by_id),
        "stunts": extract_stunt_proto(db1_tables, text_by_id),
        "jingmaiNodes": extract_jingmai_node(db1_tables, text_by_id),
        "jingjieNodes": extract_jingjie_node(db1_tables, text_by_id),
        "qinggongNodes": extract_qinggong_node(db1_tables, text_by_id),
        "sects": extract_menpai(db1_tables, text_by_id),
        "achievements": extract_achievement(db1_tables, text_by_id),
        "quests": extract_questproto(db1_tables, text_by_id),
        "words": extract_wordentry(db1_tables, text_by_id),
        "companions": extract_companions(db1_tables, text_by_id),
        "codex": extract_codex(),
    }


def emit_catalog_file(catalog):
    payload = json.dumps(catalog, ensure_ascii=False, separators=(",", ":"))
    header = (
        "/* Auto-generated by tools/extract_catalog.py — DO NOT EDIT. */\n"
        "(function (root, factory) {\n"
        "  if (typeof module === 'object' && module.exports) {\n"
        "    module.exports = factory();\n"
        "  } else {\n"
        "    root.Nj2Catalog = factory();\n"
        "  }\n"
        "}(typeof globalThis !== 'undefined' ? globalThis : this, function () {\n"
        "  'use strict';\n"
        "  var data = "
    )
    footer = ";\n  return data;\n}));\n"
    return header + payload + footer


def write_atomic(path, text):
    d = os.path.dirname(path)
    if d and not os.path.isdir(d):
        os.makedirs(d)
    fd, tmp = tempfile.mkstemp(prefix=".catalog-", suffix=".js", dir=d or ".")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write(text)
        os.replace(tmp, path)
    except Exception:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


CHECKS = (("Hanzi", HANZI_RE), ("Kana", KANA_RE), ("Tags", TAG_RE))


def check_existing(path):
    if not os.path.isfile(path):
        sys.stderr.write("catalog missing: %s\n" % path)
        return 1
    with open(path, "r", encoding="utf-8", errors="replace") as f:
        body = f.read()
    start = body.find("var data = ")
    scan = body[start:] if start >= 0 else body
    failed = False
    for label, pat in CHECKS:
        hits = len(pat.findall(scan))
        status = "OK" if hits == 0 else "FAIL"
        if hits:
            failed = True
        print("[%s] %s: %d" % (status, label, hits))
    if failed:
        print("catalog contains forbidden characters")
        return 2
    return 0


def main(argv=None):
    parser = argparse.ArgumentParser(description="Next Jianghu II catalog extractor")
    parser.add_argument("--check-only", action="store_true", help="validate existing catalog")
    parser.add_argument("--out", default=OUTPUT_PATH, help="output javascript path")
    args = parser.parse_args(argv)
    if args.check_only:
        return check_existing(args.out)

    catalog = build_catalog()
    text = emit_catalog_file(catalog)
    write_atomic(args.out, text)
    size = os.path.getsize(args.out)
    print("wrote %s (%d bytes)" % (args.out, size))
    print(
        "counts: attri=%d, items=%d, spells=%d, talents=%d, stunts=%d, "
        "jingmai=%d, jingjie=%d, qg=%d, sects=%d, achievements=%d, "
        "quests=%d, words=%d, companions=%d, codex=%d"
        % (
            len(catalog["attriTypes"]),
            len(catalog["items"]),
            len(catalog["spells"]),
            len(catalog["talents"]),
            len(catalog["stunts"]),
            len(catalog["jingmaiNodes"]),
            len(catalog["jingjieNodes"]),
            len(catalog["qinggongNodes"]),
            len(catalog["sects"]),
            len(catalog["achievements"]),
            len(catalog["quests"]),
            len(catalog["words"]),
            len(catalog["companions"]),
            len(catalog["codex"]),
        )
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
