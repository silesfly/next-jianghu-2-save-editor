# 하일참강호2 세이브 에디터 v1.0.3 (`NextJianghu2SaveEditor`)

백옥경(inmotiongame) 스튜디오의 **하일참강호 2(`Next Jianghu II`, Steam AppID `1606180`, 스팀 빌드 `26639277` · PC 제165차 호환)** 전용 오프라인 세이브 편집기입니다.

## 주요 실행 방식 (3종 표면)

- **Windows x64 단독 실행 파일**: `NextJianghu2SaveEditor-v1.0.3.exe` (`.NET Framework 4.8` + `WebView2` 내장, `%USERPROFILE%\AppData\LocalLow\inmotiongame\...\Save2` 및 Steam 설치 경로 자동 탐색)
- **단독 오프라인 HTML**: `dist/NextJianghu2SaveEditor-v1.0.3.html` (CSP `default-src 'none'; connect-src 'none'` 적용, 외부 네트워크 요청 0건, 밝은/어두운 테마 전환)
- **Python 3 CLI 및 로컬 웹 서버**: `nj2_editor.py` (`demo`, `discover`, `inspect`, `validate`, `presets`, `edit`, `serve`)

## 지원 세이브 형식 및 구조 (REA 검증 기반)

- **세이브 쌍 구조**: UTF-8(BOM 보존) JSON 본문(`savefile<N>.json` / `Auto/autosavefile<N>.json`)과 확장자 없는 동반 헤더(`savefile<N>` / `autosavefile<N>`)
- **동반 헤더 포맷**: `.NET BinaryWriter` 7비트 가변 길이 UTF-8 문자열 10개(`saveFileVersion == 76`) 또는 11개(`>= 77`, `gameType` 포함) 보존 라운드트립
- **스키마 (`LitJson` / `WritePropertyJson` 정본 호환)**:
  - `playerentity[<guid>]` 및 `Entitys[*]`의 `WritePropertyJson` 중첩 JSON 문자열 보존(`m_valueBase`, `m_learntSpell` [`Dictionary<int, List<long>>`], `m_EquipedStuntIds` [`Dictionary<int, long>`], `qgactive` [`Dictionary<int, int>`], `mijiIdList`, `m_StuntIds`, `talents`, `learnedpeifang`, 경맥 일반/오장 노드 `m0`/`m1` [0열 `JingMai_node.id`], 완료 경맥 `m8`/`m9`, `m_AchievementList`)
  - 실게임 `LitJson` `op_Explicit(double)` 엄격 타입 호환(`Item["4"]`, `Entitys[*].m_DaTiTime` 및 원본 부동소수점 경로 `.0` 보존) 및 `2^53` 초과 64비트 아이템 UID·`m_ItemIdGenerator` 정밀도 무손실 보존
  - `itemStorage.content["<slot>"]` 가방/장비(장착 `0..11`, 가방 `12+`, 단일 수량 키 `'2'` 및 강화 0 키 `'7'` 생략 호환)
  - > **이전 `v1.0.2` 이하에서 저장한 세이브 안내**: `v1.0.2` 이전 버전으로 이미 덮어쓴 세이브가 90~99% 로딩에서 멈추는 경우, `Save2` 폴더의 원본 자동 백업(`.backup-*.bak`)을 복원한 뒤 `v1.0.3`으로 다시 편집하는 것을 권장합니다.

## 편집 기능

- **요약 · 진행 · 프리셋**: 주인공 이름, 난이도(`1..5`), 경계 단계(`0..13`), 좌표(`X`/`Z`), 공력 배율, 게임 날짜 및 원클릭 프리셋 6종(`rich_start`, `core_stats_500`, `weapons_1000`, `life_master_1000`, `jingjie_13`, `starter_kit`)
- **능력치 · 재화**: 95종 전체 속성(`AttriType` `0..94`) 분류 필터·검색 및 동전(`68`)/수위(`69`)/감오(`70`)/위망(`66`)/정사(`71`) 빠른 편집
- **무공 · 비급 · 특기 · 천부 · 비방**: 3,253종 무학·252종 특기·204종 천부·7,394종 아이템 한국어 카탈로그 검색 및 목록 추가/제거
- **가방 · 장비**: 수량/품질/레벨/강화 수치 수정 및 신규 아이템 추가(자동 UID 채번)
- **경맥 · 경계 · 경공 · 업적 / 동료 · 문파 · 도감 / 변경 내역 · JSON**: 13단계 경계, 77종 경맥 노드, 47종 경공 노드, 1,211종 업적, 동료·문파·도감 뷰어, 실시간 검증·변경 diff·원문 JSON/헤더 Base64 미리보기

## 안전 장치

- 게임 실행 중 쓰기 차단 (`NJ2_SIMULATE_GAME_RUNNING=1` 시뮬레이션 검증 지원)
- 덮어쓰기 전 원본 SHA-256 동시성 검사, SHA-256 검증 `.backup-*.bak` 백업 생성 및 `MoveFileExW` / `os.replace` 기반 원자적 파일 교체
- 심볼릭 링크·디렉터리 정션·재분석 지점·하드링크·NTFS ADS(`:` 스트림)·예약 장치명(`CON`, `NUL` 등)·UNC 경로 차단
- 로컬 웹 서버 `127.0.0.1` 루프백 바인딩, `Host`/`Origin`/`Sec-Fetch-Site` 검사 및 일회성 `X-NJ2-Token` 인증(HTML 서빙 시에만 `connect-src 'self'` 허용)

## 빠른 실행 및 검증

```text
python3 tools/extract_catalog.py --check-only
python3 build.py
python3 nj2_editor.py presets
node tests/test_editor.cjs
python3 -W error -B -m unittest discover -s tests -v
node tests/test_playwright_e2e.cjs
```

## 라이선스

- 본 프로젝트 소스 코드: [MIT License](LICENSE)
- 내장 Microsoft WebView2 로더 재배포 고지: Windows 배포 압축에 `WebView2-LICENSE.txt` 포함
