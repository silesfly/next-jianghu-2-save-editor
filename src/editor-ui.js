'use strict';

/* src/editor-ui.js - 하일참강호2 세이브 에디터 UI 브리지 계층
 * 모든 DOM 쓰기는 textContent / 안전한 createElement를 통해 수행합니다.
 */

(function () {
  const CORE = window.Nj2EditorCore;
  const CODEC = window.Nj2Codec || {};
  const CATALOG = window.Nj2Catalog || {};

  const $ = (id) => document.getElementById(id);

  function el(tag, opts, children) {
    const node = document.createElement(tag);
    if (opts) {
      if (opts.className) node.className = opts.className;
      if (opts.text != null) node.textContent = String(opts.text);
      if (opts.title != null) node.title = String(opts.title);
      if (opts.type != null) node.type = String(opts.type);
      if (opts.value != null && ('value' in node)) node.value = String(opts.value);
      if (opts.attrs) {
        for (const k in opts.attrs) {
          try { node.setAttribute(k, opts.attrs[k]); } catch (_) {}
        }
      }
      if (opts.style) {
        for (const k in opts.style) node.style[k] = opts.style[k];
      }
      if (opts.on) {
        for (const k in opts.on) node.addEventListener(k, opts.on[k]);
      }
    }
    if (children) {
      for (const c of children) {
        if (c == null) continue;
        node.appendChild(c instanceof Node ? c : document.createTextNode(String(c)));
      }
    }
    return node;
  }

  function clear(node) {
    while (node && node.firstChild) node.removeChild(node.firstChild);
  }

  function safeArray(v) { return Array.isArray(v) ? v : []; }

  const state = {
    session: null,
    companionHeader: null,
    currentFileName: null,
    currentPath: null,
    currentSourceName: '',
    token: (typeof window !== 'undefined' && (window.__NJ2_TOKEN__ || (window.__NJ2_SERVER__ && window.__NJ2_SERVER__.token))) || null,
    isWebView2: !!(window.chrome && window.chrome.webview),
    activeTab: 'summary',
    statSearch: '',
    statCategory: 'all',
    skillSearch: '',
    skillMode: 'spell',
    invSearch: '',
    achSearch: '',
    codexSearch: '',
    codexKind: 'companions',
    jsonMode: 'current',
    presetList: [],
    lastValidation: null,
    summarySnapshot: null,
    selectedCompanionGuid: '',
    serverSha: '',
  };

  // ---------------------------------------------------------------- 알림 / 상태 배지

  function showToast(message, kind) {
    const host = $('toast-host');
    if (!host) return;
    let text = String(message == null ? '' : message);
    if (text.length > 240) {
      text = text.slice(0, 237) + '... (변경 내역 탭 확인)';
    }
    const cls = 'toast' + (kind === 'ok' || kind === 'warn' || kind === 'error' ? ' ' + kind : '');
    const node = el('div', { className: cls, text });
    host.appendChild(node);
    const delay = kind === 'error' ? 4800 : 3200;
    setTimeout(() => { try { host.removeChild(node); } catch (_) {} }, delay);
  }

  function setStatus(text, kind) {
    const badge = $('status-badge');
    if (!badge) return;
    badge.textContent = text;
    badge.setAttribute('data-state', kind || 'idle');
  }

  function refreshDirtyBadge() {
    const badge = $('dirty-badge');
    if (!badge) return;
    if (!state.session) {
      badge.classList.add('hidden');
      return;
    }
    const s = CORE.getSummary(state.session);
    if (s && s.dirty) {
      badge.textContent = '변경됨';
      badge.classList.remove('hidden');
    } else {
      badge.classList.add('hidden');
    }
  }

  // ---------------------------------------------------------------- 바이트 / 파일 도우미

  function toBytes(input) {
    if (input == null) return null;
    if (input instanceof Uint8Array) return input;
    if (input instanceof ArrayBuffer) return new Uint8Array(input);
    if (ArrayBuffer.isView(input)) return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
    if (typeof input === 'string') return new TextEncoder().encode(input);
    if (Array.isArray(input)) return new Uint8Array(input);
    return null;
  }

  function decodeInputBytesOrB64(val) {
    if (val == null || val === '') return null;
    if (typeof val === 'string') {
      const trimmed = val.trim();
      if (trimmed.startsWith('{') || trimmed.startsWith('[')) return toBytes(val);
      try { return base64ToBytes(val); } catch (_) { return toBytes(val); }
    }
    return toBytes(val);
  }

  function bytesToBase64(bytes) {
    if (!bytes) return '';
    let bin = '';
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
      bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
    }
    return btoa(bin);
  }

  function base64ToBytes(b64) {
    if (!b64) return null;
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  function downloadBytes(filename, bytes, mime) {
    const blob = new Blob([bytes], { type: mime || 'application/octet-stream' });
    const url = URL.createObjectURL(blob);
    const a = el('a', { attrs: { href: url, download: filename } });
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { try { document.body.removeChild(a); URL.revokeObjectURL(url); } catch (_) {} }, 0);
  }

  // ---------------------------------------------------------------- 세션 불러오기

  function applyLoadedSession(session, opts) {
    opts = opts || {};
    state.session = session;
    state.companionHeader = opts.headerBytes || null;
    state.currentFileName = opts.filename || (session && session.root && session.root.filename) || 'savefile0.json';
    state.currentPath = opts.path || null;
    state.currentSourceName = opts.source || 'file';
    state.summarySnapshot = null;
    state.lastValidation = null;
    state.selectedCompanionGuid = '';
    setStatus('불러옴', 'ok');
    refreshDirtyBadge();
    refreshAll();
    if (opts.toast !== false) showToast('세이브 세션을 불러왔습니다.', 'ok');
  }

  function loadFromBytes(jsonInput, headerInput, opts) {
    opts = opts || {};
    try {
      const jsonBytes = decodeInputBytesOrB64(jsonInput);
      const headerBytes = decodeInputBytesOrB64(headerInput);
      let companionMeta = null;
      if (headerBytes && typeof CODEC.parseCompanionHeader === 'function') {
        try { companionMeta = CODEC.parseCompanionHeader(headerBytes); } catch (_) {}
      }
      const session = CORE.createSession(jsonBytes, companionMeta);
      applyLoadedSession(session, {
        headerBytes: headerBytes || null,
        filename: opts.filename || (session && session.root && session.root.filename),
        path: opts.path || null,
        source: opts.source || 'bytes',
        toast: opts.toast,
      });
      return session;
    } catch (err) {
      setStatus('불러오기 오류', 'error');
      showToast('불러오기 실패: ' + (err && err.message ? err.message : String(err)), 'error');
      throw err;
    }
  }

  function loadDemo() {
    if (!CODEC || typeof CODEC.createDemoSave !== 'function') {
      showToast('데모 생성 모듈을 찾을 수 없습니다.', 'error');
      return null;
    }
    const demo = CODEC.createDemoSave();
    const jsonBytes = typeof CODEC.serializeSaveJson === 'function'
      ? toBytes(CODEC.serializeSaveJson(demo.saveJson, { pretty: true, indent: '  ' }))
      : new TextEncoder().encode(JSON.stringify(demo.saveJson, null, 2));
    const headerBytes = toBytes(demo.headerBytes);
    state.currentPath = null;
    state.serverSha = '';
    return loadFromBytes(jsonBytes, headerBytes, {
      filename: 'savefile0.json',
      source: 'demo',
    });
  }

  async function handleFiles(fileList) {
    const files = Array.from(fileList || []);
    if (!files.length) return;
    const jsonFiles = files.filter((f) => /\.json$/i.test(f.name || ''));
    const byStem = new Map();
    for (const f of files) {
      const name = f.name || 'file';
      const stem = name.replace(/\.json$/i, '').replace(/\.(header|hdr|bin|nj2h)$/i, '');
      if (!byStem.has(stem)) byStem.set(stem, { json: null, header: null });
      const entry = byStem.get(stem);
      if (/\.json$/i.test(name)) entry.json = f;
      else entry.header = f;
    }
    if (!jsonFiles.length) {
      showToast('JSON 세이브 파일을 선택해 주세요.', 'warn');
      return;
    }
    for (const [stem, group] of byStem) {
      if (!group.json) continue;
      try {
        const jsonBytes = new Uint8Array(await group.json.arrayBuffer());
        const headerBytes = group.header ? new Uint8Array(await group.header.arrayBuffer()) : null;
        state.currentPath = null;
        state.serverSha = '';
        loadFromBytes(jsonBytes, headerBytes, { filename: group.json.name || (stem + '.json'), source: 'file' });
      } catch (err) {
        showToast('파일 열기 실패: ' + (err && err.message ? err.message : String(err)), 'error');
      }
    }
  }

  // ---------------------------------------------------------------- 서버 / WebView2 브리지

  async function serverFetch(url, opts) {
    opts = opts || {};
    const headers = Object.assign({ 'Content-Type': 'application/json' }, opts.headers || {});
    if (state.token) headers['X-NJ2-Token'] = state.token;
    const res = await fetch(url, Object.assign({}, opts, { headers }));
    const ct = res.headers.get('content-type') || '';
    const data = ct.includes('application/json') ? await res.json() : await res.text();
    if (!res.ok) {
      const msg = (data && data.error) ? data.error : ('HTTP ' + res.status);
      throw new Error(msg);
    }
    return data;
  }

  async function discoverSlots() {
    if (state.token) {
      try {
        const data = await serverFetch('/api/slots', { method: 'GET' });
        renderSlotOptions(Array.isArray(data && data.slots) ? data.slots : []);
        return;
      } catch (_) {}
    }
    if (state.isWebView2) {
      try { window.chrome.webview.postMessage({ type: 'discover' }); } catch (_) {}
    }
  }

  function renderSlotOptions(slots) {
    const wrap = $('slot-wrap');
    const sel = $('slot-select');
    if (!sel) return;
    clear(sel);
    sel.appendChild(el('option', { value: '', text: slots.length ? '슬롯 선택...' : '발견된 슬롯 없음' }));
    for (const slot of slots) {
      const sig = typeof slot === 'string' ? slot : (slot && (slot.path || slot.Path || slot.name || slot.Name)) || '';
      const rawName = typeof slot === 'string' ? slot : (slot && (slot.label || slot.name || slot.Name || slot.path || slot.Path)) || sig;
      const autoTag = (slot && (slot.isAuto || slot.IsAuto || slot.kind === 'autosave')) ? ' [자동]' : '';
      sel.appendChild(el('option', { value: sig, text: rawName + autoTag }));
    }
    if (wrap) wrap.classList.toggle('hidden', !slots.length);
  }

  async function loadServerSlot(path) {
    if (state.isWebView2 && !state.token) {
      try {
        setStatus('불러오는 중...', 'busy');
        window.chrome.webview.postMessage({ type: 'load', path });
      } catch (err) {
        setStatus('불러오기 오류', 'error');
        showToast('슬롯 불러오기 실패: ' + (err && err.message ? err.message : String(err)), 'error');
      }
      return;
    }
    try {
      setStatus('불러오는 중...', 'busy');
      const data = await serverFetch('/api/load', { method: 'POST', body: JSON.stringify({ path }) });
      const jsonBytes = data.jsonBase64 ? base64ToBytes(data.jsonBase64) : toBytes(data.jsonText || '');
      const headerBytes = data.headerBase64 ? base64ToBytes(data.headerBase64) : null;
      state.serverSha = data.sha256 || '';
      loadFromBytes(jsonBytes, headerBytes, {
        filename: (path || '').split(/[\\/]/).pop() || 'savefile0.json',
        path,
        source: 'server',
      });
    } catch (err) {
      setStatus('불러오기 오류', 'error');
      showToast('슬롯 불러오기 실패: ' + (err && err.message ? err.message : String(err)), 'error');
    }
  }

  function exportAsBase64Payload() {
    if (!state.session) throw new Error('불러온 세이브가 없습니다.');
    const exported = CORE.exportSave(state.session, {});
    const jsonBytes = toBytes(exported.jsonBytes);
    const headerBytes = toBytes(exported.headerBytes) || state.companionHeader;
    return {
      jsonBytes,
      headerBytes,
      jsonBase64: bytesToBase64(jsonBytes),
      headerBase64: headerBytes ? bytesToBase64(headerBytes) : '',
    };
  }

  async function saveToServer() {
    if (!state.session) {
      showToast('저장할 세이브가 없습니다.', 'error');
      return;
    }
    let payload;
    try {
      payload = exportAsBase64Payload();
    } catch (err) {
      showToast('검증 실패: ' + (err && err.message ? err.message : String(err)), 'error');
      return;
    }

    if (state.isWebView2 && state.currentPath) {
      window.chrome.webview.postMessage({
        type: 'save',
        path: state.currentPath,
        jsonBase64: payload.jsonBase64,
        dataBase64: payload.jsonBase64,
        headerBase64: payload.headerBase64,
        expectedSha256: state.serverSha || '',
      });
      return;
    }

    if (state.token && state.currentPath) {
      try {
        setStatus('저장 중...', 'busy');
        const data = await serverFetch('/api/save', {
          method: 'POST',
          body: JSON.stringify({
            path: state.currentPath,
            jsonBase64: payload.jsonBase64,
            headerBase64: payload.headerBase64 || undefined,
            expectedSha256: state.serverSha || '',
          }),
        });
        state.serverSha = (data && data.sha256) || state.serverSha;
        CORE.commitSnapshot(state.session);
        setStatus('저장됨', 'ok');
        refreshDirtyBadge();
        showToast('백업 생성 후 안전하게 저장되었습니다.', 'ok');
      } catch (err) {
        setStatus('저장 오류', 'error');
        showToast('서버 저장 실패: ' + (err && err.message ? err.message : String(err)), 'error');
      }
      return;
    }

    // 독립 HTML 모드: 파일 다운로드로 내보내기
    const fname = state.currentFileName || 'savefile0.json';
    downloadBytes(fname, payload.jsonBytes, 'application/json');
    if (payload.headerBytes) {
      downloadBytes(fname.replace(/\.json$/i, ''), payload.headerBytes, 'application/octet-stream');
    }
    CORE.commitSnapshot(state.session);
    setStatus('내보내기 완료', 'ok');
    refreshDirtyBadge();
    showToast('편집된 세이브를 다운로드했습니다.', 'ok');
  }

  function onWebView2Message(evt) {
    let payload = evt && (evt.data !== undefined ? evt.data : evt);
    if (typeof payload === 'string') {
      try { payload = JSON.parse(payload); } catch (_) { return; }
    }
    if (!payload || !payload.type) return;
    if (payload.type === 'slots') {
      renderSlotOptions(Array.isArray(payload.slots) ? payload.slots : []);
    } else if (payload.type === 'loaded') {
      const b64 = payload.jsonBase64 || payload.dataBase64 || '';
      const jsonBytes = b64 ? base64ToBytes(b64) : toBytes(payload.jsonText || '');
      const headerBytes = payload.headerBase64 ? base64ToBytes(payload.headerBase64) : null;
      state.serverSha = payload.sha256 || '';
      loadFromBytes(jsonBytes, headerBytes, {
        filename: (payload.path || '').split(/[\\/]/).pop() || 'savefile0.json',
        path: payload.path || null,
        source: 'webview2',
      });
    } else if (payload.type === 'saved') {
      state.serverSha = payload.sha256 || state.serverSha;
      if (state.session) CORE.commitSnapshot(state.session);
      refreshDirtyBadge();
      setStatus('저장됨', 'ok');
      showToast('백업 생성 후 안전하게 저장되었습니다.', 'ok');
    } else if (payload.type === 'error') {
      setStatus('오류', 'error');
      showToast('호스트 오류: ' + (payload.message || '알 수 없는 오류'), 'error');
    }
  }

  // ---------------------------------------------------------------- 요약 탭

  function bindSummary() {
    const apply = $('btn-apply-summary');
    const revert = $('btn-revert-summary');
    const refresh = $('btn-refresh-summary');
    if (apply) apply.addEventListener('click', applySummary);
    if (revert) revert.addEventListener('click', revertSummary);
    if (refresh) refresh.addEventListener('click', renderSummary);
  }

  function applySummary() {
    if (!state.session) { showToast('먼저 세이브를 불러오세요.', 'warn'); return; }
    const patch = {};
    const get = (id) => { const n = $(id); return n ? n.value : ''; };
    const str = (id) => { const v = get(id).trim(); return v === '' ? undefined : v; };
    const num = (id) => { const v = get(id).trim(); if (v === '') return undefined; const n = Number(v); return Number.isFinite(n) ? n : undefined; };
    if (str('f-playername') !== undefined) patch.playername = str('f-playername');
    if (num('f-gamediff') !== undefined) patch.m_GameDiff = num('f-gamediff');
    if (num('f-jingjie') !== undefined) patch.jingjieGangLevel = num('f-jingjie');
    if (num('f-posx') !== undefined) patch.posX = num('f-posx');
    if (num('f-posz') !== undefined) patch.posZ = num('f-posz');
    if (num('f-gonglirate') !== undefined) patch.gongliRate = num('f-gonglirate');
    if (num('f-year') !== undefined) patch.m_GameTimeYear = num('f-year');
    if (num('f-month') !== undefined) patch.m_GameTimeMonth = num('f-month');
    if (num('f-day') !== undefined) patch.m_GameTimeDay = num('f-day');

    const res = CORE.setSummary(state.session, patch);
    if (!res || !res.ok) {
      showToast('적용 실패: ' + ((res && res.error) || '알 수 없는 오류'), 'error');
      return;
    }
    refreshDirtyBadge();
    renderSummary();
    showToast('진행 정보가 반영되었습니다.', 'ok');
  }

  function revertSummary() {
    if (!state.session || !state.summarySnapshot) return;
    const snap = state.summarySnapshot;
    CORE.setSummary(state.session, {
      playername: snap.playername,
      m_GameDiff: snap.gameDiff,
      jingjieGangLevel: snap.jingjieGangLevel,
      posX: snap.posX,
      posZ: snap.posZ,
      gongliRate: snap.gongliRate,
      m_GameTimeYear: snap.gameTime && snap.gameTime.year,
      m_GameTimeMonth: snap.gameTime && snap.gameTime.month,
      m_GameTimeDay: snap.gameTime && snap.gameTime.day,
    });
    renderSummary();
    refreshDirtyBadge();
    showToast('요약 입력을 초기 상태로 되돌렸습니다.', 'ok');
  }

  function refreshSummaryStrips() {
    const host = $('summary-strips');
    if (!host || !state.session) return;
    const s = CORE.getSummary(state.session);
    clear(host);
    const cards = [
      ['기혈 (체력)', s.core.hp.toLocaleString('ko-KR')],
      ['진기 (내력)', s.core.mp.toLocaleString('ko-KR')],
      ['동전', s.core.money.toLocaleString('ko-KR')],
      ['수위', s.core.xiuwei.toLocaleString('ko-KR')],
      ['감오', s.core.ganwu.toLocaleString('ko-KR')],
      ['위망', s.core.weiwang.toLocaleString('ko-KR')],
      ['소지 아이템', s.itemCount + '종'],
      ['동료 엔티티', s.companionCount + '명'],
      ['검증 상태', s.validation.ok ? '정상' : ('오류 ' + s.validation.errorCount + '건')],
    ];
    for (const [label, val] of cards) {
      host.appendChild(el('div', { className: 'quick-card' }, [
        el('span', { className: 'q-label', text: label }),
        el('span', { className: 'q-value', text: String(val) }),
      ]));
    }
  }

  function renderSummary() {
    if (!state.session) return;
    const s = CORE.getSummary(state.session);
    if (!state.summarySnapshot) state.summarySnapshot = s;
    const setVal = (id, v) => { const n = $(id); if (n) n.value = v == null ? '' : v; };
    setVal('f-playername', s.playername || s.name || '');
    setVal('f-gamediff', s.gameDiff);
    setVal('f-jingjie', s.jingjieGangLevel);
    setVal('f-posx', s.posX);
    setVal('f-posz', s.posZ);
    setVal('f-gonglirate', s.gongliRate);
    setVal('f-year', s.gameTime && s.gameTime.year);
    setVal('f-month', s.gameTime && s.gameTime.month);
    setVal('f-day', s.gameTime && s.gameTime.day);
    const src = $('summary-source');
    if (src) {
      const originLabel = state.currentSourceName === 'demo' ? '합성 데모'
        : state.currentSourceName === 'server' ? '로컬 서버'
        : state.currentSourceName === 'webview2' ? '데스크톱 호스트'
        : '로컬 파일';
      src.textContent = originLabel + ' · ' + (state.currentFileName || s.filename || 'savefile0.json') + ' · 경계 ' + (s.jingjieLabel || '-');
    }
    refreshSummaryStrips();
    renderPresetChips();
  }

  function renderPresetChips() {
    const host = $('preset-chips');
    if (!host) return;
    clear(host);
    if (!state.session) return;
    let presets = [];
    try { presets = CORE.listPresets() || []; } catch (_) { presets = []; }
    state.presetList = presets;
    for (const p of presets) {
      const id = typeof p === 'string' ? p : (p && p.id);
      const title = typeof p === 'string' ? p : (p && (p.title || p.id));
      const desc = (p && p.description) || title;
      if (!id) continue;
      host.appendChild(el('button', {
        type: 'button',
        className: 'chip',
        text: title,
        title: desc,
        on: {
          click: () => {
            const r = CORE.applyPreset(state.session, id);
            if (!r || !r.ok) {
              showToast('프리셋 실패: ' + ((r && r.error) || id), 'error');
              return;
            }
            refreshAll();
            refreshDirtyBadge();
            showToast('프리셋 적용됨: ' + title, 'ok');
          },
        },
      }));
    }
  }

  // ---------------------------------------------------------------- 능력치 · 재화 탭

  const ATTR_CAT_LABELS = {
    all: '전체 (95)',
    core: '기본 · 자질',
    combat: '전투 · 방어',
    weapon: '병기 · 무예',
    doctrine: '학파 · 조예',
    life: '생산 · 기예',
    resource: '재화 · 평판',
    extra: '보조 · 기타',
  };

  const QUICK_ATTRS = [
    { idx: 68, label: '68 · 동전' },
    { idx: 69, label: '69 · 수위' },
    { idx: 70, label: '70 · 감오' },
    { idx: 66, label: '66 · 위망' },
    { idx: 71, label: '71 · 정사' },
  ];

  function attrCatMap() {
    const map = {};
    for (const row of safeArray(CATALOG.attriTypes)) {
      map[row.index] = row.cat || 'extra';
    }
    return map;
  }

  function attrLabelSafe(idx) {
    try { return CORE.attrLabel(idx) || ('속성 #' + idx); } catch (_) { return '속성 #' + idx; }
  }

  function renderStats() {
    if (!state.session) return;
    renderStatQuick();
    renderStatChips();
    renderStatTable();
  }

  function renderStatQuick() {
    const host = $('stat-quick-cards');
    if (!host) return;
    clear(host);
    const base = CORE.getAttributes(state.session) || {};
    for (const q of QUICK_ATTRS) {
      const cur = base[String(q.idx)] != null ? base[String(q.idx)] : 0;
      const wrap = el('div', { className: 'quick-card' }, [
        el('label', { className: 'q-label', text: q.label }),
        el('input', {
          type: 'number',
          attrs: { 'data-attr': String(q.idx), 'aria-label': q.label },
          value: String(cur),
          on: {
            change: (e) => {
              const v = Number(e.target.value);
              if (!Number.isFinite(v)) return;
              const r = CORE.setAttribute(state.session, q.idx, v);
              if (!r || !r.ok) {
                showToast('설정 실패: ' + ((r && r.error) || ''), 'error');
                return;
              }
              refreshDirtyBadge();
              renderStatTable();
            },
          },
        }),
      ]);
      host.appendChild(wrap);
    }
  }

  function renderStatChips() {
    const host = $('stat-cat-chips');
    const sel = $('stat-category');
    const cats = ['all', 'core', 'combat', 'weapon', 'doctrine', 'life', 'resource', 'extra'];
    if (sel && sel.options.length === 0) {
      for (const c of cats) {
        sel.appendChild(el('option', { value: c, text: ATTR_CAT_LABELS[c] || c }));
      }
      sel.value = state.statCategory;
    } else if (sel) {
      sel.value = state.statCategory;
    }
    if (!host) return;
    clear(host);
    for (const c of cats) {
      host.appendChild(el('button', {
        type: 'button',
        className: 'chip',
        text: ATTR_CAT_LABELS[c] || c,
        attrs: { 'aria-pressed': state.statCategory === c ? 'true' : 'false' },
        on: {
          click: () => {
            state.statCategory = c;
            renderStatChips();
            renderStatTable();
          },
        },
      }));
    }
  }

  function renderStatTable() {
    const tbody = $('stat-tbody');
    const empty = $('stat-empty');
    if (!tbody) return;
    clear(tbody);
    if (!state.session) {
      if (empty) empty.classList.remove('hidden');
      return;
    }
    const base = CORE.getAttributes(state.session) || {};
    const catByIdx = attrCatMap();
    const search = (state.statSearch || '').trim().toLowerCase();
    let shown = 0;

    for (let idx = 0; idx < CORE.ATTR_COUNT; idx++) {
      const cat = catByIdx[idx] || 'extra';
      if (state.statCategory !== 'all' && cat !== state.statCategory) continue;
      const label = attrLabelSafe(idx);
      const key = String(idx);
      if (search && !label.toLowerCase().includes(search) && !key.includes(search)) continue;
      const cur = base[key] != null ? base[key] : 0;
      shown++;
      const input = el('input', {
        type: 'number',
        attrs: { 'data-stat-idx': key, 'aria-label': label },
        value: String(cur),
        on: {
          change: (e) => {
            const v = Number(e.target.value);
            if (!Number.isFinite(v)) return;
            const r = CORE.setAttribute(state.session, idx, v);
            if (!r || !r.ok) {
              showToast('변경 실패: ' + ((r && r.error) || ''), 'error');
              renderStatTable();
              return;
            }
            refreshDirtyBadge();
            renderStatQuick();
          },
        },
      });
      tbody.appendChild(el('tr', {}, [
        el('td', { className: 'num id-cell', text: String(idx) }),
        el('td', { className: 'name-cell', text: label }),
        el('td', { className: 'num' }, [input]),
        el('td', {}, [el('span', { className: 'pill', text: ATTR_CAT_LABELS[cat] || cat })]),
      ]));
    }
    if (empty) empty.classList.toggle('hidden', shown > 0);
  }

  function bindStats() {
    const search = $('stat-search');
    if (search) search.addEventListener('input', (e) => { state.statSearch = e.target.value || ''; renderStatTable(); });
    const sel = $('stat-category');
    if (sel) sel.addEventListener('change', (e) => { state.statCategory = e.target.value || 'all'; renderStatChips(); renderStatTable(); });
    renderStatChips();
  }

  // ---------------------------------------------------------------- 무공 · 비급 · 특기 · 천부 탭

  const SKILL_FIELDS = {
    spell: { listId: 'list-spell', countId: 'count-spell', field: 'm_learntSpell', kind: 'spell', catKey: 'spells' },
    miji: { listId: 'list-miji', countId: 'count-miji', field: 'mijiIdList', kind: 'miji', catKey: 'spells' },
    stunt: { listId: 'list-stunt', countId: 'count-stunt', equippedId: 'list-stunt-equipped', field: 'm_StuntIds', kind: 'stunt', catKey: 'stunts' },
    peifang: { listId: 'list-peifang', countId: 'count-peifang', field: 'learnedpeifang', kind: 'peifang', catKey: 'items' },
    talent: { listId: 'list-talent', countId: 'count-talent', field: 'talents', kind: 'talent', catKey: 'talents' },
  };

  function getPlayerList(field) {
    if (!state.session) return [];
    if (typeof CORE.getFieldIds === 'function') {
      return CORE.getFieldIds(state.session, field);
    }
    const player = (state.session && state.session.player) || {};
    const v = player[field];
    return Array.isArray(v) ? v.slice() : [];
  }

  function lookupNameSafe(kind, id) {
    try {
      const v = CORE.lookupName(kind, id);
      if (v) return String(v);
    } catch (_) {}
    return null;
  }

  function renderSkills() {
    if (!state.session) return;
    for (const key of Object.keys(SKILL_FIELDS)) {
      const cfg = SKILL_FIELDS[key];
      const listHost = $(cfg.listId);
      const countHost = $(cfg.countId);
      if (!listHost) continue;
      clear(listHost);
      const ids = getPlayerList(cfg.field);
      if (countHost) countHost.textContent = String(ids.length);
      if (!ids.length) {
        listHost.appendChild(el('div', { className: 'empty', text: '등록된 항목이 없습니다.' }));
      } else {
        for (const id of ids) {
          const name = lookupNameSafe(cfg.kind, id) || ('항목 #' + id);
          listHost.appendChild(el('div', { className: 'list-row' }, [
            el('span', { className: 'lname', text: name, title: name }),
            el('span', { className: 'lid', text: '#' + id }),
            el('button', {
              type: 'button',
              className: 'btn btn-sm',
              text: '제거',
              on: {
                click: () => {
                  const r = CORE.toggleIdInList(state.session, cfg.field, id, false);
                  if (!r || !r.ok) showToast('제거 실패', 'error');
                  else { renderSkills(); refreshDirtyBadge(); }
                },
              },
            }),
          ]));
        }
      }
      if (cfg.equippedId) {
        const eqHost = $(cfg.equippedId);
        if (eqHost) {
          clear(eqHost);
          const eq = getPlayerList('m_EquipedStuntIds');
          for (const id of eq) {
            const name = lookupNameSafe('stunt', id) || ('특기 #' + id);
            eqHost.appendChild(el('span', { className: 'pill gold', text: name + ' (#' + id + ')' }));
          }
        }
      }
    }
    renderSkillSearchResults();
  }

  function renderSkillSearchResults() {
    const host = $('skill-search-results');
    if (!host) return;
    clear(host);
    const term = (state.skillSearch || '').trim().toLowerCase();
    if (!state.session) {
      host.appendChild(el('div', { className: 'empty', text: '세이브를 불러온 뒤 검색하세요.' }));
      return;
    }
    if (!term) {
      host.appendChild(el('div', { className: 'empty', text: '이름 또는 식별자 번호를 입력하세요.' }));
      return;
    }
    const cfg = SKILL_FIELDS[state.skillMode] || SKILL_FIELDS.spell;
    const have = new Set(getPlayerList(cfg.field).map(String));
    const arr = safeArray(CATALOG[cfg.catKey]);
    const candidates = [];
    for (const row of arr) {
      const id = row.id != null ? row.id : row.nodeId;
      if (id == null) continue;
      const name = String(row.name || ('#' + id));
      if (name.toLowerCase().includes(term) || String(id).includes(term)) {
        candidates.push({ id, name });
        if (candidates.length >= 60) break;
      }
    }
    if (!candidates.length && /^\d+$/.test(term)) {
      const numId = Number(term);
      candidates.push({ id: numId, name: lookupNameSafe(cfg.kind, numId) || ('직접 입력 #' + numId) });
    }
    if (!candidates.length) {
      host.appendChild(el('div', { className: 'empty', text: '일치하는 항목이 없습니다.' }));
      return;
    }
    for (const c of candidates) {
      const already = have.has(String(c.id));
      host.appendChild(el('div', { className: 'list-row' }, [
        el('span', { className: 'lname', text: c.name, title: c.name }),
        el('span', { className: 'lid', text: '#' + c.id }),
        el('button', {
          type: 'button',
          className: 'btn btn-sm' + (already ? '' : ' btn-primary'),
          text: already ? '제거' : '추가',
          on: {
            click: () => {
              const r = CORE.toggleIdInList(state.session, cfg.field, c.id, !already);
              if (!r || !r.ok) showToast('적용 실패', 'error');
              else { renderSkills(); refreshDirtyBadge(); }
            },
          },
        }),
      ]));
    }
  }

  function bindSkills() {
    const search = $('skill-search');
    if (search) search.addEventListener('input', (e) => { state.skillSearch = e.target.value || ''; renderSkillSearchResults(); });
    const sel = $('skill-list-select');
    if (sel) sel.addEventListener('change', (e) => { state.skillMode = e.target.value || 'spell'; renderSkillSearchResults(); });
  }

  // ---------------------------------------------------------------- 가방 · 장비 탭

  function refreshItemCatalogSelect() {
    const sel = $('add-item-proto');
    const filter = $('add-item-filter');
    const hint = $('add-item-hint');
    if (!sel) return;
    const term = filter ? filter.value.trim().toLowerCase() : '';
    const items = safeArray(CATALOG.items);
    const prev = sel.value;
    clear(sel);
    const matches = [];
    for (const it of items) {
      const name = String(it.name || ('아이템 #' + it.id));
      const idStr = String(it.id);
      if (!term || name.toLowerCase().includes(term) || idStr.includes(term)) {
        matches.push(it);
        if (matches.length >= 200) break;
      }
    }
    for (const it of matches) {
      sel.appendChild(el('option', { value: String(it.id), text: '[' + it.id + '] ' + (it.name || '미상 아이템') }));
    }
    if (prev && Array.from(sel.options).some((o) => o.value === prev)) sel.value = prev;
    if (hint) {
      if (!items.length) hint.textContent = '카탈로그 데이터가 비어 있습니다.';
      else hint.textContent = '전체 ' + items.length.toLocaleString('ko-KR') + '종 중 ' + matches.length + '종 표시 중';
    }
  }

  function renderInventory() {
    refreshItemCatalogSelect();
    const tbody = $('inv-tbody');
    const empty = $('inv-empty');
    const count = $('count-items');
    if (!tbody) return;
    clear(tbody);
    if (!state.session) {
      if (count) count.textContent = '0';
      if (empty) empty.classList.remove('hidden');
      return;
    }
    const player = state.session.player || {};
    const content = (player.itemStorage && player.itemStorage.content) || {};
    const entries = Object.entries(content);
    if (count) count.textContent = String(entries.length);
    const search = (state.invSearch || '').trim().toLowerCase();
    let shown = 0;

    for (const [key, row] of entries) {
      if (!row || typeof row !== 'object') continue;
      const uid = row['0'] != null ? row['0'] : key;
      const proto = row['1'] != null ? row['1'] : '';
      const slotNum = Number(key);
      const slotTag = Number.isInteger(slotNum)
        ? (slotNum < (CORE.SUB_SLOT_BAG_BEGIN || 12) ? ('장착 ' + slotNum) : ('가방 ' + slotNum))
        : String(key);
      const name = lookupNameSafe('item', proto) || ('아이템 #' + proto);
      if (search && !name.toLowerCase().includes(search) && !String(uid).includes(search) && !String(proto).includes(search) && !slotTag.includes(search)) continue;
      shown++;

      const itemOpts = { slot: key, entityId: state.session.playerKey };
      const mkNum = (val, minVal, fieldName) => el('input', {
        type: 'number',
        attrs: { min: String(minVal), 'aria-label': name + ' ' + fieldName },
        value: String(val != null ? val : minVal),
        on: {
          change: (e) => {
            const v = Number(e.target.value);
            if (!Number.isFinite(v) || v < minVal) return;
            const patch = {};
            patch[fieldName] = v;
            const r = CORE.updateItem(state.session, uid, patch, itemOpts);
            if (!r || !r.ok) showToast('수정 실패: ' + ((r && r.error) || ''), 'error');
            else refreshDirtyBadge();
          },
        },
      });

      tbody.appendChild(el('tr', {}, [
        el('td', { className: 'id-cell', text: slotTag + ' · #' + proto, title: '슬롯 ' + key + ' / UID ' + uid + ' / 원형 #' + proto }),
        el('td', { className: 'name-cell', text: name }),
        el('td', { className: 'num' }, [mkNum(row['2'] != null ? row['2'] : 1, 1, 'count')]),
        el('td', { className: 'num' }, [mkNum(row['9'] != null ? row['9'] : 10, 1, 'grade')]),
        el('td', { className: 'num' }, [mkNum(row['10'] != null ? row['10'] : 1, 1, 'level')]),
        el('td', { className: 'num' }, [mkNum(row['7'] != null ? row['7'] : 0, 0, 'intensify')]),
        el('td', {}, [el('button', {
          type: 'button',
          className: 'btn btn-sm',
          text: '삭제',
          on: {
            click: () => {
              const r = CORE.removeItem(state.session, uid, itemOpts);
              if (!r || !r.ok) showToast('삭제 실패', 'error');
              else { renderInventory(); refreshDirtyBadge(); }
            },
          },
        })]),
      ]));
    }
    if (empty) empty.classList.toggle('hidden', shown > 0);
  }

  function bindInventory() {
    const filter = $('add-item-filter');
    if (filter) filter.addEventListener('input', refreshItemCatalogSelect);
    const search = $('inv-search');
    if (search) search.addEventListener('input', (e) => { state.invSearch = e.target.value || ''; renderInventory(); });
    const btn = $('btn-add-item');
    if (btn) btn.addEventListener('click', () => {
      if (!state.session) { showToast('먼저 세이브를 불러오세요.', 'warn'); return; }
      const protoSel = $('add-item-proto');
      const countInput = $('add-item-count');
      const protoId = protoSel ? protoSel.value.trim() : '';
      const count = countInput ? Number(countInput.value) : 1;
      if (!protoId) { showToast('추가할 아이템을 선택하세요.', 'warn'); return; }
      const r = CORE.addItem(state.session, protoId, Number.isFinite(count) && count > 0 ? count : 1, {});
      if (!r || !r.ok) {
        showToast('아이템 추가 실패: ' + ((r && r.error) || ''), 'error');
        return;
      }
      renderInventory();
      refreshDirtyBadge();
      showToast('아이템이 가방에 추가되었습니다.', 'ok');
    });
    refreshItemCatalogSelect();
  }

  // ---------------------------------------------------------------- 경맥 · 경계 · 경공 탭

  function renderGraphs() {
    if (!state.session) return;
    const summary = CORE.getSummary(state.session);
    const cur = $('jingjie-current');
    const current = summary ? summary.jingjieGangLevel : 0;
    if (cur) cur.textContent = '현재: ' + current + '단계 (' + (CORE.JINGJIE_LABELS[current] || '-') + ')';

    const grid = $('jingjie-grid');
    if (grid) {
      clear(grid);
      for (let i = 0; i <= CORE.JINGJIE_MAX; i++) {
        const label = CORE.JINGJIE_LABELS[i] || ('단계 ' + i);
        grid.appendChild(el('button', {
          type: 'button',
          className: 'jj',
          text: i + ' · ' + label,
          attrs: { 'aria-pressed': i === current ? 'true' : 'false' },
          on: {
            click: () => {
              const r = CORE.setJingjieLevel(state.session, i);
              if (!r || !r.ok) showToast('경계 변경 실패', 'error');
              else { renderGraphs(); refreshDirtyBadge(); }
            },
          },
        }));
      }
    }

    renderNodeGrid(['m0', 'm1'], 'm8-grid', 'count-m8', safeArray(CATALOG.jingmaiNodes), 'jingmai');
    renderNodeGrid('qgactive', 'qg-grid', 'count-qg', safeArray(CATALOG.qinggongNodes), 'qg');
    renderAchievements();
  }

  function renderNodeGrid(fieldSpec, gridId, countId, catalogNodes, kind) {
    const grid = $(gridId);
    const countPill = $(countId);
    if (!grid) return;
    clear(grid);
    const fields = Array.isArray(fieldSpec) ? fieldSpec : [fieldSpec];
    const activeByField = {};
    for (const f of fields) activeByField[f] = new Set(getPlayerList(f).map(Number));

    const nodes = [];
    const seen = new Set();
    for (const row of catalogNodes) {
      const id = row.id != null ? Number(row.id) : (row.nodeId != null ? Number(row.nodeId) : null);
      if (id == null || seen.has(id)) continue;
      seen.add(id);
      const targetField = fields.length > 1 ? (row.type === 2 ? fields[1] : fields[0]) : fields[0];
      nodes.push({ id, field: targetField, name: row.name || ('노드 #' + id) });
    }
    for (const f of fields) {
      for (const id of activeByField[f]) {
        if (!seen.has(id)) {
          seen.add(id);
          nodes.push({ id, field: f, name: lookupNameSafe(kind, id) || ('노드 #' + id) });
        }
      }
    }

    let activeCount = 0;
    for (const n of nodes) {
      const on = activeByField[n.field].has(n.id);
      if (on) activeCount++;
      grid.appendChild(el('button', {
        type: 'button',
        className: 'node',
        title: n.name + ' (#' + n.id + ')',
        attrs: { 'aria-pressed': on ? 'true' : 'false' },
        on: {
          click: () => {
            const r = CORE.toggleIdInList(state.session, n.field, n.id, !on);
            if (!r || !r.ok) showToast('토글 실패', 'error');
            else { renderGraphs(); refreshDirtyBadge(); }
          },
        },
      }, [
        el('span', { text: n.name.length > 6 ? n.name.slice(0, 6) : n.name }),
        el('span', { className: 'n-idx', text: '#' + n.id }),
      ]));
    }
    if (countPill) countPill.textContent = activeCount + ' / ' + nodes.length;
  }

  function renderAchievements() {
    const host = $('ach-list');
    if (!host) return;
    clear(host);
    const have = new Set(getPlayerList('m_AchievementList').map(String));
    const search = (state.achSearch || '').trim().toLowerCase();
    const source = safeArray(CATALOG.achievements);
    let shown = 0;
    for (const row of source) {
      const id = row.id;
      const name = String(row.name || ('업적 #' + id));
      if (search && !name.toLowerCase().includes(search) && !String(id).includes(search)) continue;
      if (shown >= 150) break;
      shown++;
      const on = have.has(String(id));
      host.appendChild(el('div', { className: 'list-row' }, [
        el('span', { className: 'lname', text: name }),
        el('span', { className: 'lid', text: '#' + id }),
        el('button', {
          type: 'button',
          className: 'btn btn-sm' + (on ? '' : ' btn-primary'),
          text: on ? '해제' : '달성',
          on: {
            click: () => {
              const r = CORE.toggleIdInList(state.session, 'm_AchievementList', id, !on);
              if (!r || !r.ok) showToast('업적 변경 실패', 'error');
              else { renderAchievements(); refreshDirtyBadge(); }
            },
          },
        }),
      ]));
    }
    if (!shown) {
      host.appendChild(el('div', { className: 'empty', text: '표시할 업적이 없습니다.' }));
    }
  }

  function bindGraphs() {
    const ach = $('ach-search');
    if (ach) ach.addEventListener('input', (e) => { state.achSearch = e.target.value || ''; renderAchievements(); });
  }

  // ---------------------------------------------------------------- 동료 · 문파 · 도감 탭

  function renderCompanions() {
    if (!state.session) return;
    const sel = $('companion-select');
    const detail = $('companion-detail');
    const entsObj = (state.session.root && state.session.root.Entitys) || {};
    const entries = Object.entries(entsObj).filter((pair) => pair[1] && typeof pair[1] === 'object');

    if (sel) {
      clear(sel);
      sel.appendChild(el('option', { value: '', text: entries.length ? '동료 선택 (' + entries.length + '명)...' : '등록된 동료 없음' }));
      for (const [guid, c] of entries) {
        const name = c.name || c.m_NpcName || lookupNameSafe('companion', c.npcId || c.id || guid) || ('동료 ' + guid.slice(0, 8));
        sel.appendChild(el('option', { value: guid, text: name }));
      }
      if (entries.length) {
        const targetGuid = (state.selectedCompanionGuid && entsObj[state.selectedCompanionGuid])
          ? state.selectedCompanionGuid
          : entries[0][0];
        state.selectedCompanionGuid = targetGuid;
        sel.value = targetGuid;
        renderCompanionDetail(targetGuid, entsObj[targetGuid]);
      } else if (detail) {
        clear(detail);
        detail.appendChild(el('div', { className: 'empty', text: '현재 세이브에 동료 엔티티가 없습니다.' }));
      }
    }
    renderCodex();
  }

  function renderCompanionDetail(guid, c) {
    const detail = $('companion-detail');
    if (!detail) return;
    clear(detail);
    if (!c) {
      detail.appendChild(el('div', { className: 'empty', text: '동료를 선택해 주세요.' }));
      return;
    }
    const vb = CORE.getAttributes(state.session, guid) || {};
    const invCount = (c.itemStorage && c.itemStorage.content) ? Object.keys(c.itemStorage.content).length : 0;
    const rows = [
      ['엔티티 GUID', guid],
      ['이름', c.name || c.m_NpcName || '-'],
      ['원형 ID', c.npcId != null ? c.npcId : (c.id != null ? c.id : '-')],
      ['기혈 / 진기', (vb['0'] != null ? vb['0'] : '-') + ' / ' + (vb['1'] != null ? vb['1'] : '-')],
      ['소지 아이템 수', invCount + '개'],
    ];
    const grid = el('div', { className: 'grid grid-2' });
    for (const [k, v] of rows) {
      grid.appendChild(el('div', { className: 'quick-card' }, [
        el('span', { className: 'q-label', text: k }),
        el('span', { className: 'q-value', style: { fontSize: '13px' }, text: String(v) }),
      ]));
    }
    detail.appendChild(grid);
  }

  function renderCodex() {
    const host = $('codex-list');
    if (!host) return;
    clear(host);
    const term = (state.codexSearch || '').trim().toLowerCase();
    const kind = state.codexKind || 'companions';
    const src = safeArray(CATALOG[kind]);
    if (!src.length) {
      host.appendChild(el('div', { className: 'empty', text: '카탈로그 데이터가 없습니다.' }));
      return;
    }
    let shown = 0;
    for (let i = 0; i < src.length; i++) {
      const row = src[i];
      const id = row.id != null ? row.id : i;
      const name = String(row.name || ('항목 #' + id));
      const extra = row.title || row.sect || row.category || row.subType || '';
      if (term && !name.toLowerCase().includes(term) && !String(id).includes(term) && !String(extra).toLowerCase().includes(term)) continue;
      if (shown >= 200) break;
      shown++;
      host.appendChild(el('div', { className: 'list-row' }, [
        el('span', { className: 'lname', text: extra ? (name + ' · ' + extra) : name }),
        el('span', { className: 'lid', text: '#' + id }),
      ]));
    }
    if (!shown) {
      host.appendChild(el('div', { className: 'empty', text: '일치하는 도감 항목이 없습니다.' }));
    }
  }

  function bindCompanions() {
    const sel = $('companion-select');
    if (sel) sel.addEventListener('change', (e) => {
      const guid = e.target.value;
      const entsObj = (state.session && state.session.root && state.session.root.Entitys) || {};
      if (guid && entsObj[guid]) {
        state.selectedCompanionGuid = guid;
        renderCompanionDetail(guid, entsObj[guid]);
      }
    });
    const search = $('codex-search');
    if (search) search.addEventListener('input', (e) => { state.codexSearch = e.target.value || ''; renderCodex(); });
    const kind = $('codex-kind');
    if (kind) kind.addEventListener('change', (e) => { state.codexKind = e.target.value || 'companions'; renderCodex(); });
  }

  // ---------------------------------------------------------------- 변경 내역 · 검증 · JSON 탭

  function renderValidation() {
    const pill = $('validate-pill');
    const list = $('validate-list');
    if (!state.session) return;
    let result = { ok: true, errors: [], warnings: [] };
    try { result = CORE.validate(state.session) || result; } catch (_) {}
    state.lastValidation = result;
    const errN = (result.errors || []).length;
    const warnN = (result.warnings || []).length;
    if (pill) {
      pill.textContent = result.ok ? ('정상' + (warnN ? ' (경고 ' + warnN + '건)' : '')) : ('오류 ' + errN + '건');
      pill.className = 'pill ' + (result.ok ? (warnN ? 'gold' : 'jade') : 'err');
    }
    if (list) {
      clear(list);
      for (const e of (result.errors || [])) {
        list.appendChild(el('div', { className: 'notice error' }, [
          el('span', { className: 'n-tag', text: '오류' }),
          el('span', { text: String(e) }),
        ]));
      }
      for (const w of (result.warnings || [])) {
        list.appendChild(el('div', { className: 'notice warn' }, [
          el('span', { className: 'n-tag', text: '경고' }),
          el('span', { text: String(w) }),
        ]));
      }
      if (!errN && !warnN) {
        list.appendChild(el('div', { className: 'notice info' }, [
          el('span', { className: 'n-tag', text: '정상' }),
          el('span', { text: '검사된 모든 스키마 및 범위 규칙을 통과했습니다.' }),
        ]));
      }
    }
  }

  function renderDiff() {
    const tbody = $('diff-tbody');
    const empty = $('diff-empty');
    const count = $('diff-count');
    if (!tbody) return;
    clear(tbody);
    if (!state.session) {
      if (count) count.textContent = '0건';
      if (empty) empty.classList.remove('hidden');
      return;
    }
    let diff = [];
    try { diff = CORE.computeDiff(state.session) || []; } catch (_) {}
    if (count) count.textContent = diff.length + '건';
    if (empty) empty.classList.toggle('hidden', diff.length > 0);
    const fmt = (v) => v === undefined ? '-' : (typeof v === 'string' ? v : JSON.stringify(v));
    for (const row of diff.slice(0, 300)) {
      tbody.appendChild(el('tr', {}, [
        el('td', { className: 'mono', text: String(row.path) }),
        el('td', { className: 'mono diff-old', text: fmt(row.before) }),
        el('td', { className: 'mono diff-new', text: fmt(row.after) }),
      ]));
    }
  }

  function renderJsonView() {
    const view = $('json-view');
    const mode = $('json-mode');
    if (!view) return;
    if (!state.session) {
      view.textContent = '불러온 세이브가 없습니다.';
      return;
    }
    state.jsonMode = (mode && mode.value) || state.jsonMode || 'current';
    try {
      if (state.jsonMode === 'header') {
        const bytes = (state.session.companionMeta && typeof CODEC.encodeCompanionHeader === 'function')
          ? toBytes(CODEC.encodeCompanionHeader(state.session.companionMeta))
          : state.companionHeader;
        view.textContent = bytes ? bytesToBase64(bytes) : '(동반 헤더가 없습니다)';
      } else if (state.jsonMode === 'original') {
        const text = JSON.stringify(state.session.originalRoot, null, 2);
        view.textContent = text.length > 400000 ? text.slice(0, 400000) + '\n... (일부 생략)' : text;
      } else {
        const exported = CORE.exportSave(state.session, { validate: false });
        const text = new TextDecoder().decode(toBytes(exported.jsonBytes));
        view.textContent = text.length > 400000 ? text.slice(0, 400000) + '\n... (일부 생략)' : text;
      }
    } catch (err) {
      view.textContent = '미리보기 실패: ' + (err && err.message ? err.message : String(err));
    }
  }

  function bindDiff() {
    const rev = $('btn-revalidate');
    if (rev) rev.addEventListener('click', () => { renderValidation(); showToast('검증을 다시 실행했습니다.', 'ok'); });
    const rf = $('btn-refresh-diff');
    if (rf) rf.addEventListener('click', renderDiff);
    const rj = $('btn-refresh-json');
    if (rj) rj.addEventListener('click', renderJsonView);
    const mode = $('json-mode');
    if (mode) mode.addEventListener('change', renderJsonView);
  }

  // ---------------------------------------------------------------- 상단바 / 탭

  function bindTopbar() {
    const fileInput = $('file-input');
    const openBtn = $('btn-open-file');
    if (openBtn && fileInput) openBtn.addEventListener('click', () => fileInput.click());
    if (fileInput) fileInput.addEventListener('change', (e) => { handleFiles(e.target.files); fileInput.value = ''; });

    const demo = $('btn-load-demo');
    if (demo) demo.addEventListener('click', () => { try { loadDemo(); } catch (_) {} });

    const saveFile = $('btn-save-file');
    if (saveFile) saveFile.addEventListener('click', () => { saveToServer(); });

    const dl = $('btn-download-save');
    if (dl) dl.addEventListener('click', () => {
      if (!state.session) { showToast('내보낼 세이브가 없습니다.', 'warn'); return; }
      try {
        const payload = exportAsBase64Payload();
        const fname = state.currentFileName || 'savefile0.json';
        downloadBytes(fname, payload.jsonBytes, 'application/json');
        if (payload.headerBytes) downloadBytes(fname.replace(/\.json$/i, ''), payload.headerBytes, 'application/octet-stream');
        showToast('JSON 세이브를 다운로드했습니다.', 'ok');
      } catch (err) {
        showToast('내보내기 실패: ' + (err && err.message ? err.message : String(err)), 'error');
      }
    });

    const exp = $('btn-export-html');
    if (exp) exp.addEventListener('click', () => {
      try {
        const html = '<!DOCTYPE html>\n' + document.documentElement.outerHTML;
        downloadBytes('NextJianghu2SaveEditor-v1.0.3.html', new TextEncoder().encode(html), 'text/html;charset=utf-8');
        showToast('현재 에디터 HTML을 내보냈습니다.', 'ok');
      } catch (err) {
        showToast('HTML 내보내기 실패: ' + (err && err.message ? err.message : String(err)), 'error');
      }
    });

    const theme = $('btn-theme');
    if (theme) theme.addEventListener('click', () => {
      const cur = document.documentElement.getAttribute('data-theme') || 'light';
      const next = cur === 'dark' ? 'light' : 'dark';
      document.documentElement.setAttribute('data-theme', next);
      try { localStorage.setItem('nj2-theme', next); } catch (_) {}
    });
    try {
      const saved = localStorage.getItem('nj2-theme');
      if (saved) document.documentElement.setAttribute('data-theme', saved);
    } catch (_) {}

    const sel = $('slot-select');
    if (sel) sel.addEventListener('change', (e) => {
      const v = e.target.value;
      if (v) loadServerSlot(v);
    });
  }

  function bindTabs() {
    const tabs = document.querySelectorAll('.tab[data-tab]');
    tabs.forEach((tab) => {
      const id = tab.getAttribute('data-tab');
      tab.addEventListener('click', () => activateTab(id));
    });
    const initial = Array.from(tabs).find((t) => t.getAttribute('aria-selected') === 'true');
    activateTab(initial ? initial.getAttribute('data-tab') : 'summary');
  }

  function activateTab(id) {
    if (!id) id = 'summary';
    state.activeTab = id;
    document.querySelectorAll('.tab[data-tab]').forEach((t) => {
      const selected = t.getAttribute('data-tab') === id;
      t.setAttribute('aria-selected', selected ? 'true' : 'false');
      t.setAttribute('tabindex', selected ? '0' : '-1');
    });
    document.querySelectorAll('.panel[id^="panel-"]').forEach((p) => {
      p.classList.toggle('is-active', p.id === 'panel-' + id);
    });
    refreshPanel(id);
  }

  function refreshPanel(id) {
    switch (id) {
      case 'summary': renderSummary(); break;
      case 'stats': renderStats(); break;
      case 'skills': renderSkills(); break;
      case 'inventory': renderInventory(); break;
      case 'graphs': renderGraphs(); break;
      case 'companions': renderCompanions(); break;
      case 'diff': renderValidation(); renderDiff(); renderJsonView(); break;
    }
  }

  function refreshAll() {
    refreshDirtyBadge();
    refreshPanel(state.activeTab);
    if (state.session && state.activeTab !== 'diff') {
      renderValidation();
    }
  }

  // ---------------------------------------------------------------- 드래그 앤 드롭

  function bindDragDrop() {
    const veil = $('drop-veil');
    let depth = 0;
    const show = () => { if (veil) { veil.classList.add('is-on'); veil.setAttribute('aria-hidden', 'false'); } };
    const hide = () => { if (veil) { veil.classList.remove('is-on'); veil.setAttribute('aria-hidden', 'true'); } };
    window.addEventListener('dragenter', (e) => { e.preventDefault(); depth++; show(); });
    window.addEventListener('dragover', (e) => { e.preventDefault(); });
    window.addEventListener('dragleave', (e) => { e.preventDefault(); depth = Math.max(0, depth - 1); if (!depth) hide(); });
    window.addEventListener('drop', (e) => {
      e.preventDefault();
      depth = 0;
      hide();
      if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length) {
        handleFiles(e.dataTransfer.files);
      }
    });
  }

  // ---------------------------------------------------------------- 초기화

  function init() {
    if (!CORE) {
      setStatus('코어 모듈 누락', 'error');
      return;
    }
    bindTopbar();
    bindTabs();
    bindDragDrop();
    bindSummary();
    bindStats();
    bindSkills();
    bindInventory();
    bindGraphs();
    bindCompanions();
    bindDiff();
    setStatus('대기 중', 'idle');
    refreshDirtyBadge();
    discoverSlots();

    if (state.isWebView2) {
      try { window.chrome.webview.addEventListener('message', onWebView2Message); } catch (_) {}
      try { window.chrome.webview.postMessage({ type: 'discover' }); } catch (_) {}
    }
  }

  window.Nj2Ui = {
    getSession: () => state.session,
    loadFromBytes: (jsonBytes, headerBytes, opts) => loadFromBytes(jsonBytes, headerBytes, opts),
    loadDemo: () => loadDemo(),
    exportBase64: () => JSON.stringify(exportAsBase64Payload()),
    save: () => saveToServer(),
    refresh: () => refreshAll(),
    activateTab: (id) => activateTab(id),
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
