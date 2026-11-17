'use strict';

const assert = require('node:assert/strict');
const codec = require('../src/nj2-codec.js');
const catalog = require('../src/catalog-data.js');
const core = require('../src/editor-core.js');

let passed = 0;
const failures = [];

function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log('PASS  ' + name);
  } catch (err) {
    failures.push({ name, err });
    console.error('FAIL  ' + name);
    console.error('      ' + (err && err.message ? err.message : err));
  }
}

const HANZI_RE = /[\u4e00-\u9fff\u3400-\u4dbf]/;
const KANA_RE = /[\u3040-\u309f\u30a0-\u30ff\u31f0-\u31ff\uff66-\uff9f]/;

function collectStrings(node, out) {
  if (node == null) return;
  if (typeof node === 'string') { out.push(node); return; }
  if (Array.isArray(node)) { for (const v of node) collectStrings(v, out); return; }
  if (typeof node === 'object') {
    for (const k of Object.keys(node)) {
      collectStrings(node[k], out);
    }
  }
}

// 1. Companion header codec (10-str v76, 11-str v77, Korean UTF-8)
test('companion header v76 (10 strings) round-trip', () => {
  const hero = '\ud55c\uae00\uc601\uc6c5';
  const meta = {
    name: hero,
    saveTime: '2026/11/17 10:00:00',
    gameTime: '120.5',
    posX: '10.1',
    posZ: '20.2',
    filename: 'savefile1',
    saveFileVersion: '76',
    gameDiff: '2',
    modelId: '100',
    maintaskName: '\ucc9c\ud558\ubb34\uc801',
  };
  const encoded = codec.encodeCompanionHeader(meta);
  assert.ok(encoded instanceof Uint8Array);
  const parsed = codec.parseCompanionHeader(encoded);
  assert.strictEqual(parsed.fieldCount, 10);
  assert.strictEqual(parsed.saveFileVersion, '76');
  assert.strictEqual(parsed.name, hero);
  assert.strictEqual(parsed.maintaskName, '\ucc9c\ud558\ubb34\uc801');
});

test('companion header v77 (11 strings) round-trip', () => {
  const encoded = codec.encodeCompanionHeader({
    name: '\uc591\uc18c',
    saveTime: '2026/11/17 11:00:00',
    gameTime: '3600',
    posX: '111.5',
    posZ: '222.5',
    filename: 'savefile0',
    saveFileVersion: '77',
    gameDiff: '3',
    modelId: '1',
    maintaskName: '\uac15\ud638\ucd08\uc785',
    gameType: '1',
  });
  const parsed = codec.parseCompanionHeader(encoded);
  assert.strictEqual(parsed.fieldCount, 11);
  assert.strictEqual(parsed.gameType, '1');
  assert.strictEqual(parsed.name, '\uc591\uc18c');
});

// 2. Demo save -> session -> validate
let demo;
let demoJsonStr;
test('createDemoSave + createSession + validate passes cleanly', () => {
  demo = codec.createDemoSave();
  assert.ok(demo && demo.saveJson && demo.headerBytes instanceof Uint8Array);
  demoJsonStr = JSON.stringify(demo.saveJson, null, 2);
  const session = core.createSession(demoJsonStr, demo.headerBytes);
  const rep = core.validate(session);
  assert.strictEqual(rep.ok, true);
  assert.strictEqual(rep.errors.length, 0);
});

// 3. setSummary + syncDerived
test('setSummary mutates fields and syncDerived updates player & companionMeta', () => {
  const session = core.createSession(demoJsonStr, demo.headerBytes);
  const res = core.setSummary(session, {
    playername: '\uccad\uba85\uac80\uac1d',
    m_GameDiff: 4,
    posX: 777.5,
    posZ: -222.25,
    m_GameTimeYear: 5,
  });
  assert.strictEqual(res.ok, true);
  const sum = core.getSummary(session);
  assert.strictEqual(sum.playername, '\uccad\uba85\uac80\uac1d');
  assert.strictEqual(sum.gameDiff, 4);
  assert.strictEqual(sum.posX, 777.5);
  assert.strictEqual(sum.posZ, -222.25);
  assert.strictEqual(sum.gameTime.year, 5);
  assert.strictEqual(session.companionMeta.name, '\uccad\uba85\uac80\uac1d');
  assert.strictEqual(session.companionMeta.gameDiff, '4');
});

// 4. setAttribute bounds including attr 71 (zhengxie)
test('setAttribute enforces bounds and permits negative values only for attr 71', () => {
  const session = core.createSession(demoJsonStr, demo.headerBytes);
  assert.strictEqual(core.setAttribute(session, 68, 555555).ok, true);
  assert.strictEqual(session.player.m_valueBase['68'], 555555);
  assert.strictEqual(core.setAttribute(session, 68, -1).ok, false);
  assert.strictEqual(core.setAttribute(session, 71, -50000).ok, true);
  assert.strictEqual(session.player.m_valueBase['71'], -50000);
  assert.strictEqual(core.setAttribute(session, 71, -1000000).ok, false);
});

// 5. addItem / updateItem / removeItem
test('addItem / updateItem / removeItem maintain UID generator and storage count', () => {
  const session = core.createSession(demoJsonStr, demo.headerBytes);
  const beforeGen = session.root.m_ItemIdGenerator;
  const beforeCount = Object.keys(session.player.itemStorage.content).length;

  const added = core.addItem(session, 1001, 5, { grade: 12, intensify: 2 });
  assert.strictEqual(added.ok, true);
  assert.ok(added.uid > beforeGen);
  assert.strictEqual(session.root.m_ItemIdGenerator, added.uid);
  assert.strictEqual(session.player.itemStorage.count, beforeCount + 1);

  const upd = core.updateItem(session, added.uid, { count: 9, intensify: 7 });
  assert.strictEqual(upd.ok, true);
  assert.strictEqual(session.player.itemStorage.content[String(added.uid)]['2'], 9);
  assert.strictEqual(session.player.itemStorage.content[String(added.uid)]['7'], 7);

  const rem = core.removeItem(session, added.uid);
  assert.strictEqual(rem.ok, true);
  assert.strictEqual(session.player.itemStorage.count, beforeCount);
  assert.strictEqual(session.player.itemStorage.content[String(added.uid)], undefined);
});

// 6. toggleIdInList across tracked lists
test('toggleIdInList adds and removes IDs cleanly across all tracked lists', () => {
  const session = core.createSession(demoJsonStr, demo.headerBytes);
  for (const field of core.LIST_FIELDS) {
    const id = 424242;
    const on = core.toggleIdInList(session, field, id, true);
    assert.strictEqual(on.ok, true);
    assert.ok(session.player[field].includes(id), field + ' should include ' + id);
    const off = core.toggleIdInList(session, field, id, false);
    assert.strictEqual(off.ok, true);
    assert.ok(!session.player[field].includes(id), field + ' should not include ' + id);
  }
});

// 7. All 6 presets pass validate & produce computeDiff
test('all 6 presets apply cleanly, validate ok, and report diffs', () => {
  const expectedIds = ['rich_start', 'core_stats_500', 'weapons_1000', 'life_master_1000', 'jingjie_13', 'starter_kit'];
  const actualIds = core.listPresets().map((p) => p.id);
  assert.deepStrictEqual(actualIds, expectedIds);

  for (const id of expectedIds) {
    const session = core.createSession(demoJsonStr, demo.headerBytes);
    const res = core.applyPreset(session, id);
    assert.strictEqual(res.ok, true, 'preset ' + id);
    const rep = core.validate(session);
    assert.strictEqual(rep.ok, true, 'validate after ' + id);
    const diff = core.computeDiff(session);
    assert.ok(Array.isArray(diff) && diff.length > 0, 'diff non-empty after ' + id);
  }
});

// 8. exportSave round-trip preserves values + header
test('exportSave round-trips JSON and companion header cleanly', () => {
  const session = core.createSession(demoJsonStr, demo.headerBytes);
  core.applyPreset(session, 'rich_start');
  core.setSummary(session, { playername: '\uc77c\uc120\ub3c4\uc778', m_GameDiff: 2 });
  const exp = core.exportSave(session);
  assert.ok(exp.jsonBytes instanceof Uint8Array && exp.jsonBytes.length > 100);
  assert.ok(exp.headerBytes instanceof Uint8Array && exp.headerBytes.length > 10);

  const meta2 = codec.parseCompanionHeader(exp.headerBytes);
  const s2 = core.createSession(exp.jsonBytes, meta2);
  const sum2 = core.getSummary(s2);
  assert.strictEqual(sum2.playername, '\uc77c\uc120\ub3c4\uc778');
  assert.strictEqual(sum2.core.money, 10000000);
  assert.strictEqual(meta2.name, '\uc77c\uc120\ub3c4\uc778');
});

// 9. Zero Hanzi/Kana across catalog and core labels
test('Nj2Catalog and Nj2EditorCore contain zero Hanzi and zero Kana', () => {
  const strings = [];
  collectStrings(catalog, strings);
  collectStrings([core.ATTR_LABELS, core.JINGJIE_LABELS, core.GAME_DIFF_LABELS, core.LIST_FIELD_LABELS, core.listPresets()], strings);
  let bad = 0;
  for (const s of strings) {
    if (HANZI_RE.test(s) || KANA_RE.test(s)) {
      bad += 1;
      if (bad <= 5) console.error('Found non-Korean token:', JSON.stringify(s.slice(0, 80)));
    }
  }
  assert.strictEqual(bad, 0);
});

const total = passed + failures.length;
console.log(`\n===== test_editor.cjs: ${passed}/${total} passed =====`);
if (failures.length > 0) process.exit(1);
