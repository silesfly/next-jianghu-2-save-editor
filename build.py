#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""하일참강호2 세이브 에디터 단일 HTML 번들 빌더.

src/editor-page.html 내 <script src="..."> 태그를 실제 JS 파일 내용으로
인라인 병합하여 dist/NextJianghu2SaveEditor-v1.0.1.html 을 원자적으로 생성한다.

사용법:
    python3 build.py
    python3 build.py --check
"""

from __future__ import annotations

import argparse
import os
import re
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent
SRC_HTML = ROOT / "src" / "editor-page.html"
DIST_DIR = ROOT / "dist"
DIST_HTML = DIST_DIR / "NextJianghu2SaveEditor-v1.0.1.html"

JS_FILES = [
    "nj2-codec.js",
    "catalog-data.js",
    "editor-core.js",
    "editor-ui.js",
]

MAX_SIZE = 10 * 1024 * 1024  # 10 MiB

SCRIPT_SRC_RE = re.compile(
    r'<script\b[^>]*\bsrc\s*=\s*["\']([^"\']*)["\'][^>]*>\s*</script\s*>',
    re.IGNORECASE,
)
ANY_SCRIPT_SRC_RE = re.compile(r"<script\b[^>]*\bsrc\b", re.IGNORECASE)
BARE_PROTOCOL_RE = re.compile(r"(?:https?|ftp|wss?)://", re.IGNORECASE)
PROTO_REL_ATTR_RE = re.compile(r'(?:src|href|action|data)\s*=\s*["\']\s*//[A-Za-z0-9]', re.IGNORECASE)
HANZI_RE = re.compile(r"[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF]")
KANA_RE = re.compile(r"[\u3040-\u30FF]")


class BuildError(Exception):
    pass


def inline_scripts(html: str) -> str:
    js_cache: dict[str, str] = {}

    def repl(match: re.Match[str]) -> str:
        src = match.group(1).strip()
        base = os.path.basename(src.split("?")[0].split("#")[0])
        if base not in JS_FILES:
            raise BuildError(f"예상치 못한 스크립트 경로입니다: {src}")
        if base not in js_cache:
            path = SRC_HTML.parent / base
            if not path.is_file():
                raise BuildError(f"JS 파일을 찾을 수 없습니다: {path}")
            js_cache[base] = path.read_text(encoding="utf-8")
        body = js_cache[base].replace("</script", "<\\/script")
        return "<script>\n" + body + "\n</script>"

    return SCRIPT_SRC_RE.sub(repl, html)


def verify(html: str) -> None:
    errors: list[str] = []
    leftover = ANY_SCRIPT_SRC_RE.findall(html)
    if leftover:
        errors.append(f"인라인되지 않은 <script src=...> 태그가 {len(leftover)}개 남아 있습니다.")
    if "default-src 'none'" not in html:
        errors.append("CSP 메타 태그(default-src 'none')가 누락되었습니다.")
    for m in BARE_PROTOCOL_RE.finditer(html):
        snippet = html[max(0, m.start() - 20): m.end() + 20].replace("\n", " ")
        errors.append(f"외부 프로토콜 URL 발견: ...{snippet}...")
        break
    if PROTO_REL_ATTR_RE.search(html):
        errors.append("프로토콜 상대 URL(//...)이 발견되었습니다.")
    hz = HANZI_RE.findall(html)
    if hz:
        sample = "".join(dict.fromkeys(hz))[:20]
        errors.append(f"한자 문자가 {len(hz)}개 포함되어 있습니다: {sample}")
    kn = KANA_RE.findall(html)
    if kn:
        sample = "".join(dict.fromkeys(kn))[:20]
        errors.append(f"가나 문자가 {len(kn)}개 포함되어 있습니다: {sample}")
    raw_len = len(html.encode("utf-8"))
    if raw_len > MAX_SIZE:
        errors.append(f"번들 크기 초과: {raw_len:,} > {MAX_SIZE:,} 바이트")
    if errors:
        raise BuildError("\n".join(errors))


def atomic_write(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp_name = tempfile.mkstemp(dir=str(path.parent), prefix=".nj2-", suffix=".tmp")
    tmp_path = Path(tmp_name)
    try:
        with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as f:
            f.write(text)
            f.flush()
            os.fsync(f.fileno())
        os.replace(str(tmp_path), str(path))
    except BaseException:
        try:
            tmp_path.unlink()
        except OSError:
            pass
        raise


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="하일참강호2 세이브 에디터 HTML 빌더")
    parser.add_argument("--check", action="store_true", help="빌드 후(또는 기존 산출물) 검증")
    args = parser.parse_args(argv)

    try:
        if args.check and DIST_HTML.is_file():
            existing = DIST_HTML.read_text(encoding="utf-8")
            verify(existing)
            print(f"[기존 산출물] 검증 통과 — {DIST_HTML.stat().st_size:,} 바이트")
            return 0
        if not SRC_HTML.is_file():
            raise BuildError(f"템플릿을 찾을 수 없습니다: {SRC_HTML}")
        bundled = inline_scripts(SRC_HTML.read_text(encoding="utf-8"))
        verify(bundled)
        atomic_write(DIST_HTML, bundled)
        print(f"[빌드 완료] {DIST_HTML} ({DIST_HTML.stat().st_size:,} 바이트)")
        return 0
    except BuildError as exc:
        sys.stderr.write(f"[빌드 오류]\n{exc}\n")
        return 1


if __name__ == "__main__":
    sys.exit(main())
