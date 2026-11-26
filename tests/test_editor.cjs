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
  assert.strictEqual(typeof session.player.m_valueBase, 'string');
  assert.strictEqual(core.getAttributes(session)['68'], 555555);
  assert.strictEqual(core.setAttribute(session, 68, -1).ok, false);
  assert.strictEqual(core.setAttribute(session, 71, -50000).ok, true);
  assert.strictEqual(core.getAttributes(session)['71'], -50000);
  assert.strictEqual(core.setAttribute(session, 71, -1000000).ok, false);
});

// 5. addItem / updateItem / removeItem
test('addItem / updateItem / removeItem allocate bag slot >= 12 and keep storage capacity', () => {
  const session = core.createSession(demoJsonStr, demo.headerBytes);
  const beforeGen = session.root.m_ItemIdGenerator;
  const beforeCapacity = session.player.itemStorage.count;
  const beforeLen = Object.keys(session.player.itemStorage.content).length;

  const added = core.addItem(session, 1001, 5, { grade: 12, intensify: 2 });
  assert.strictEqual(added.ok, true);
  assert.ok(added.uid > beforeGen);
  assert.ok(added.slot >= core.SUB_SLOT_BAG_BEGIN);
  assert.strictEqual(session.root.m_ItemIdGenerator, added.uid);
  assert.strictEqual(session.player.itemStorage.count, Math.max(beforeCapacity, added.slot + 1));
  assert.strictEqual(Object.keys(session.player.itemStorage.content).length, beforeLen + 1);
  assert.strictEqual(session.player.itemStorage.content[String(added.slot)]['0'], added.uid);

  const upd = core.updateItem(session, added.uid, { count: 9, intensify: 7 });
  assert.strictEqual(upd.ok, true);
  assert.strictEqual(session.player.itemStorage.content[String(added.slot)]['2'], 9);
  assert.strictEqual(session.player.itemStorage.content[String(added.slot)]['7'], 7);

  const updBySlot = core.updateItem(session, added.uid, { count: 1, intensify: 0 }, { slot: String(added.slot) });
  assert.strictEqual(updBySlot.ok, true);
  assert.strictEqual('2' in session.player.itemStorage.content[String(added.slot)], false);
  assert.strictEqual('7' in session.player.itemStorage.content[String(added.slot)], false);

  const rem = core.removeItem(session, added.uid);
  assert.strictEqual(rem.ok, true);
  assert.strictEqual(session.player.itemStorage.count, Math.max(beforeCapacity, added.slot + 1));
  assert.strictEqual(session.player.itemStorage.content[String(added.slot)], undefined);
  assert.strictEqual(Object.keys(session.player.itemStorage.content).length, beforeLen);
});

// 5b. Real-save regression: omitted key '2' (qty 1), slot capacity preservation, NPC without itemStorage, signed/extended attrs
test('real-save shape with omitted qty key 2, capacity 200, missing NPC storage, and signed attrs exports cleanly unmodified', () => {
  const realLike = JSON.parse(demoJsonStr);
  realLike.playerentity['1'].itemStorage = {
    count: 200,
    content: {
      '0': { '0': 500001, '1': 1001, '9': 10, '10': 1 },
      '12': { '0': 500002, '1': 1002, '9': 11, '10': 1 },
      '14': { '0': 500003, '1': 1003, '9': 12, '10': 1 },
    },
  };
  const vb = JSON.parse(realLike.playerentity['1'].m_valueBase);
  vb['67'] = -15;
  vb['1020'] = -30;
  realLike.playerentity['1'].m_valueBase = JSON.stringify(vb);
  realLike.Entitys['2'].itemStorage = {
    count: 48,
    content: {
      '0': { '0': 600001, '1': 1001 },
      '1': { '0': 600002, '1': 1002 },
    },
  };
  realLike.Entitys['3'] = { guid: 3, type: 2, isActive: false, m_valueBase: JSON.stringify({ '0': 500 }) };

  const session = core.createSession(JSON.stringify(realLike), demo.headerBytes);
  const rep = core.validate(session);
  assert.strictEqual(rep.ok, true, 'validate errors: ' + rep.errors.join('; '));
  assert.strictEqual(rep.errors.length, 0);
  assert.strictEqual(session.player.itemStorage.count, 200);
  assert.strictEqual(session.root.Entitys['2'].itemStorage.count, 48);
  assert.strictEqual('itemStorage' in session.root.Entitys['3'], false);

  const exp = core.exportSave(session);
  const roundTripped = JSON.parse(Buffer.from(exp.jsonBytes).toString('utf8'));
  assert.strictEqual(roundTripped.playerentity['1'].itemStorage.count, 200);
  assert.strictEqual(typeof roundTripped.playerentity['1'].m_valueBase, 'string');
  const rtVb = JSON.parse(roundTripped.playerentity['1'].m_valueBase);
  assert.strictEqual(rtVb['67'], -15);
  assert.strictEqual(rtVb['1020'], -30);
  assert.strictEqual('2' in roundTripped.playerentity['1'].itemStorage.content['12'], false);
  assert.strictEqual('itemStorage' in roundTripped.Entitys['3'], false);
});

// 6. toggleIdInList across tracked lists
test('toggleIdInList adds and removes IDs cleanly across all tracked WritePropertyJson fields', () => {
  const session = core.createSession(demoJsonStr, demo.headerBytes);
  for (const field of core.LIST_FIELDS) {
    const id = 424242;
    const on = core.toggleIdInList(session, field, id, true);
    assert.strictEqual(on.ok, true);
    assert.strictEqual(typeof session.player[field], 'string', field + ' must be JSON string');
    assert.ok(core.getFieldIds(session, field).includes(id), field + ' should include ' + id);
    const off = core.toggleIdInList(session, field, id, false);
    assert.strictEqual(off.ok, true);
    assert.strictEqual(typeof session.player[field], 'string', field + ' must stay JSON string');
    assert.ok(!core.getFieldIds(session, field).includes(id), field + ' should not include ' + id);
  }
});

// 6b. Real LitJson WritePropertyJson + float .0 + 64-bit integer + BOM round-trip regression
test('real LitJson save preserves UTF-8 BOM, WritePropertyJson strings, float .0, 64-bit ints, and zero open diff', () => {
  const saveText = '\uFEFF' + [
    '{',
    '    "posX": 100.0,',
    '    "posZ": 0.0,',
    '    "gameTime": 120.0,',
    '    "m_ItemIdGenerator": 9007199254740993123,',
    '    "playerentity": {',
    '        "1": {',
    '            "guid": 1,',
    '            "name": "테스트협객",',
    '            "m_valueBase": "{\\"0\\":4500,\\"68\\":50000,\\"999\\":42}",',
    '            "m_learntSpell": "{\\"0\\":[3,4],\\"1\\":[500]}",',
    '            "m_EquipedStuntIds": "{\\"34\\":3400}",',
    '            "qgactive": "{\\"101\\":1010}",',
    '            "m0": "[10000,10010]",',
    '            "itemStorage": {',
    '                "count": 120,',
    '                "content": {',
    '                    "12": { "0": 9007199254740993123, "1": 1001, "4": 1.0, "9": 10, "10": 1 }',
    '                }',
    '            }',
    '        }',
    '    },',
    '    "Entitys": {',
    '        "2": {',
    '            "guid": 2,',
    '            "m_DaTiTime": 0.0,',
    '            "m_valueBase": "{\\"0\\":3000,\\"68\\":100}"',
    '        }',
    '    }',
    '}'
  ].join('\n');

  const session = core.createSession(Buffer.from(saveText, 'utf8'));
  assert.strictEqual(core.computeDiff(session).length, 0);
  assert.strictEqual(core.getSummary(session).core.money, 50000);
  assert.strictEqual(core.getAttributes(session)['999'], 42);

  assert.strictEqual(core.setAttribute(session, 68, 999999).ok, true);
  assert.strictEqual(core.toggleIdInList(session, 'm_learntSpell', 5, true).ok, true);
  assert.strictEqual(core.toggleIdInList(session, 'm_EquipedStuntIds', 3401, true).ok, true);
  assert.strictEqual(core.toggleIdInList(session, 'qgactive', 1020, true).ok, true);
  assert.strictEqual(core.toggleIdInList(session, 'm0', 10020, true).ok, true);
  const addRes = core.addItem(session, 1002, 1, { intensify: 0 });
  assert.strictEqual(addRes.ok, true);

  const exp = core.exportSave(session);
  const bytes = Buffer.from(exp.jsonBytes);
  assert.strictEqual(bytes[0], 0xef);
  assert.strictEqual(bytes[1], 0xbb);
  assert.strictEqual(bytes[2], 0xbf);

  const text = bytes.toString('utf8');
  const parsed = JSON.parse(text.replace(/^\uFEFF/, ''));
  const player = parsed.playerentity['1'];

  assert.strictEqual(typeof player.m_valueBase, 'string');
  const vb = JSON.parse(player.m_valueBase);
  assert.strictEqual(vb['68'], 999999);
  assert.strictEqual(vb['999'], 42);

  assert.strictEqual(typeof player.m_learntSpell, 'string');
  const learnt = JSON.parse(player.m_learntSpell);
  assert.strictEqual(Array.isArray(learnt), false);
  assert.ok(Array.isArray(learnt['0']) && learnt['0'].includes(5));
  assert.ok(Array.isArray(learnt['1']) && learnt['1'].includes(500));

  assert.strictEqual(typeof player.m_EquipedStuntIds, 'string');
  const eqStunts = JSON.parse(player.m_EquipedStuntIds);
  assert.strictEqual(Array.isArray(eqStunts), false);
  assert.strictEqual(eqStunts['34'], 3401);

  assert.strictEqual(typeof player.qgactive, 'string');
  const qg = JSON.parse(player.qgactive);
  assert.strictEqual(Array.isArray(qg), false);
  assert.strictEqual(qg['101'], 1010);
  assert.strictEqual(qg['102'], 1020);

  assert.strictEqual(typeof player.m0, 'string');
  assert.ok(JSON.parse(player.m0).includes(10020));

  assert.match(text, /"4": 1\.0/);
  assert.match(text, /"m_DaTiTime": 0\.0/);
  assert.match(text, /"posX": 100\.0/);
  assert.match(text, /9007199254740993123/);
  // P0-1 regression: >2^53 UID addItem must emit UNQUOTED exact 64-bit integer and advance m_ItemIdGenerator
  assert.strictEqual(addRes.uid, '9007199254740993124');
  assert.match(text, /"0": 9007199254740993124\b/);
  assert.match(text, /"m_ItemIdGenerator": 9007199254740993124\b/);
  assert.doesNotMatch(text, /"9007199254740993124"/);

  const addedRow = player.itemStorage.content[String(addRes.slot)];
  assert.ok(addedRow);
  assert.strictEqual('2' in addedRow, false);
  assert.strictEqual('7' in addedRow, false);
});

// 6c. Auto-repair legacy v1.0.2 raw object/array fields into WritePropertyJson strings on export
test('legacy v1.0.2 raw object/array WritePropertyJson fields warn, set needsRepair, and auto-repair on export', () => {
  const legacyText = JSON.stringify({
    playerentity: {
      '1': {
        m_valueBase: { '68': 100 },
        mijiIdList: [10000],
        m_learntSpell: [3, 4],
        qgactive: [1010],
        m9: []
      }
    }
  }, null, 2);
  const session = core.createSession(Buffer.from(legacyText, 'utf8'));
  assert.strictEqual(session.needsRepair, true);
  assert.strictEqual(session.dirty, true);
  const preVal = core.validate(session);
  assert.ok(preVal.warnings.some((w) => /backup/i.test(w)));
  const exp = core.exportSave(session);
  const parsed = JSON.parse(Buffer.from(exp.jsonBytes).toString('utf8'));
  const p = parsed.playerentity['1'];
  assert.strictEqual(typeof p.m_valueBase, 'string');
  assert.deepStrictEqual(JSON.parse(p.m_valueBase), { '68': 100 });
  assert.strictEqual(typeof p.mijiIdList, 'string');
  assert.deepStrictEqual(JSON.parse(p.mijiIdList), [10000]);
  assert.strictEqual(typeof p.m_learntSpell, 'string');
  assert.strictEqual(Array.isArray(JSON.parse(p.m_learntSpell)), false);
  assert.strictEqual(typeof p.qgactive, 'string');
  assert.deepStrictEqual(JSON.parse(p.qgactive), { '101': 1010 });
  assert.strictEqual(typeof p.m9, 'string');
  assert.deepStrictEqual(JSON.parse(p.m9), []);
});

// 6e. Exact >2^53 UID lookup distinguishes adjacent rounded numbers & guards UInt64 max overflow
test('exact >2^53 UID update/remove targets exact slot only and rejects UInt64 max overflow', () => {
  const adjText = [
    '{',
    '  "m_ItemIdGenerator": 9007199254740993,',
    '  "playerentity": {',
    '    "1": {',
    '      "m_valueBase": "{\\"68\\":100}",',
    '      "itemStorage": {',
    '        "count": 20,',
    '        "content": {',
    '          "12": { "0": 9007199254740993, "1": 1001, "9": 10, "10": 1 },',
    '          "13": { "0": 9007199254740992, "1": 1002, "9": 10, "10": 1 }',
    '        }',
    '      }',
    '    }',
    '  }',
    '}'
  ].join('\n');
  const s = core.createSession(Buffer.from(adjText, 'utf8'));
  assert.strictEqual(core.updateItem(s, '9007199254740992', { count: 7 }).ok, true);
  assert.strictEqual(s.player.itemStorage.content['12']['2'], undefined);
  assert.strictEqual(s.player.itemStorage.content['13']['2'], 7);
  assert.strictEqual(core.removeItem(s, '9007199254740992').ok, true);
  assert.ok(s.player.itemStorage.content['12']);
  assert.strictEqual(s.player.itemStorage.content['13'], undefined);
  const out = Buffer.from(core.exportSave(s).jsonBytes).toString('utf8');
  assert.match(out, /"0": 9007199254740993\b/);

  // UInt64 max overflow rejected cleanly without mutating generator or inventory
  const maxText = [
    '{',
    '  "m_ItemIdGenerator": 18446744073709551615,',
    '  "playerentity": {',
    '    "1": {',
    '      "m_valueBase": "{\\"68\\":100}",',
    '      "itemStorage": { "count": 20, "content": {} }',
    '    }',
    '  }',
    '}'
  ].join('\n');
  const smax = core.createSession(Buffer.from(maxText, 'utf8'));
  const overRes = core.addItem(smax, 1001, 1);
  assert.strictEqual(overRes.ok, false);
  assert.strictEqual(Object.keys(smax.player.itemStorage.content).length, 0);
  const maxOut = Buffer.from(core.exportSave(smax).jsonBytes).toString('utf8');
  assert.match(maxOut, /"m_ItemIdGenerator": 18446744073709551615\b/);
  assert.doesNotMatch(maxOut, /18446744073709551616/);
});

// 6d. Validate rejects duplicate item UIDs and container-type mismatches; non-double integers stay integers
test('validate catches duplicate item UIDs & container mismatches and preserves non-double integers', () => {
  const dupText = JSON.stringify({
    gameTime: 42,
    playerentity: {
      '1': {
        m_valueBase: '{"68":100}',
        m_learntSpell: '[1,2]',
        itemStorage: {
          count: 20,
          content: {
            '12': { '0': 555, '1': 1001, '9': 10, '10': 1 },
            '13': { '0': 555, '1': 1002, '9': 10, '10': 1 }
          }
        }
      }
    }
  }, null, 2);
  const s = core.createSession(Buffer.from(dupText, 'utf8'));
  const rep = core.validate(s);
  assert.strictEqual(rep.ok, false);
  assert.ok(rep.errors.some((e) => /중복된 아이템 고유 번호/.test(e)));
  assert.ok(rep.errors.some((e) => /m_learntSpell.*Dictionary/.test(e)));

  // Non-double integer gameTime must NOT be coerced to 42.0 (P2-1)
  const cleanText = JSON.stringify({
    gameTime: 42,
    playerentity: { '1': { m_valueBase: '{"68":100}' } }
  }, null, 2);
  const s2 = core.createSession(Buffer.from(cleanText, 'utf8'));
  const out2 = Buffer.from(core.exportSave(s2).jsonBytes).toString('utf8');
  assert.match(out2, /"gameTime": 42\b/);
  assert.doesNotMatch(out2, /"gameTime": 42\.0/);
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
