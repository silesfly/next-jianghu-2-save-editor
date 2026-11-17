/*!
 * Next Jianghu II Save Editor - Core
 * UMD module: Nj2EditorCore
 * Depends on: ./nj2-codec (Nj2Codec), ./catalog-data (Nj2Catalog)
 *
 * All user-facing strings are pure Korean (Hangul). No Hanzi, no Kana.
 */
(function (globalRoot, factory) {
  'use strict';
  if (typeof define === 'function' && define.amd) {
    define(['./nj2-codec', './catalog-data'], factory);
  } else if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./nj2-codec'), require('./catalog-data'));
  } else {
    globalRoot.Nj2EditorCore = factory(globalRoot.Nj2Codec, globalRoot.Nj2Catalog);
  }
}(typeof self !== 'undefined' ? self : this, function (Nj2Codec, Nj2Catalog) {
  'use strict';

  var ATTR_COUNT = 95;
  var INT_MIN = 0;
  var INT_MAX = 2147483647;
  var ZHENGXIE_INDEX = 71;
  var ZHENGXIE_MIN = -999999;
  var ZHENGXIE_MAX = 999999;
  var JINGJIE_MIN = 0;
  var JINGJIE_MAX = 13;
  var GAME_DIFF_MIN = 1;
  var GAME_DIFF_MAX = 5;

  var UID_KEY = '0';
  var PROTO_KEY = '1';
  var COUNT_KEY = '2';
  var WEILI_KEY = '3';
  var SHARP_KEY = '5';
  var TENACITY_KEY = '6';
  var INTENSIFY_KEY = '7';
  var DURABILITY_KEY = '8';
  var GRADE_KEY = '9';
  var LEVEL_KEY = '10';

  var ATTR_LABELS = {
    0: '기혈', 1: '진기', 2: '현재 체력', 3: '현재 진기',
    4: '원기', 5: '자질', 6: '힘', 7: '내공', 8: '체격',
    9: '정신', 10: '신법', 11: '집중', 12: '행운',
    13: '용모', 14: '말솜씨', 15: '상도', 16: '담력',
    17: '수양', 18: '끈기', 19: '호방',
    20: '외공', 21: '내공 공격', 22: '외방', 23: '내방',
    24: '고정 피해', 25: '고정 방어', 26: '관통', 27: '흘리기',
    28: '음', 29: '양', 30: '강', 31: '유', 32: '독', 33: '경공치',
    34: '도법', 35: '검술', 36: '격투', 37: '창곤',
    38: '암기', 39: '기술', 40: '의술', 41: '독기술',
    42: '도학', 43: '불학', 44: '유학', 45: '병도',
    46: '묵학', 47: '궤사', 48: '마학', 49: '농학',
    50: '연단', 51: '연기', 52: '교수', 53: '재봉',
    54: '양조', 55: '요리', 56: '채광', 57: '채약',
    58: '금예', 59: '기예', 60: '서법', 61: '화도',
    62: '주량', 63: '낚시', 64: '사냥', 65: '재배',
    66: '위망', 67: '도덕', 68: '동전', 69: '수위',
    70: '감오', 71: '정사', 72: '등급', 73: '오성',
    74: '명중', 75: '회피', 76: '회심', 77: '반격',
    78: '연격', 79: '추격', 80: '연참', 81: '체력 회복률',
    82: '진기 회복률', 83: '정력', 84: '최대 정력', 85: '기술 위력',
    86: '외공 기술 위력', 87: '내공 기술 위력', 88: '경공',
    89: '경공치 최대치', 90: '가속', 91: '불야경 공헌도',
    92: '경공 회복량', 93: '정력 회복량', 94: '포쾌'
  };

  var JINGJIE_LABELS = [
    '평범', '약통권각', '초규문경', '융회관통', '등봉조극', '일대종사', '대성지경',
    '화경초입', '심신합일', '천인감응', '육지신선', '태허지경', '무극귀일', '대도지경'
  ];

  var GAME_DIFF_LABELS = ['', '초심(쉬움)', '강호(보통)', '험난(어려움)', '극악(매우 어려움)', '종사(최고 난이도)'];

  var LIST_FIELDS = [
    'm_learntSpell', 'mijiIdList', 'm_StuntIds', 'm_EquipedStuntIds',
    'talents', 'learnedpeifang', 'm8', 'qgactive', 'm_AchievementList'
  ];

  var LIST_FIELD_LABELS = {
    m_learntSpell: '습득 무학',
    mijiIdList: '비급 목록',
    m_StuntIds: '보유 특기',
    m_EquipedStuntIds: '장착 특기',
    talents: '선천 천부',
    learnedpeifang: '습득 제조법',
    m8: '활성 경맥 노드',
    qgactive: '활성 경공 노드',
    m_AchievementList: '달성 업적'
  };

  function isObj(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }
  function isArr(v) { return Array.isArray(v); }
  function ensureObj(o, key) { if (!isObj(o[key])) { o[key] = {}; } return o[key]; }
  function ensureArr(o, key) { if (!isArr(o[key])) { o[key] = []; } return o[key]; }

  function toInt(v, fallback) {
    var n = typeof v === 'number' ? v : parseInt(v, 10);
    return isFinite(n) && !isNaN(n) ? Math.trunc(n) : fallback;
  }

  function toNum(v, fallback) {
    var n = typeof v === 'number' ? v : Number(v);
    return isFinite(n) && !isNaN(n) ? n : fallback;
  }

  function clone(v) {
    if (v === null || typeof v !== 'object') { return v; }
    if (Array.isArray(v)) {
      var a = new Array(v.length);
      for (var i = 0; i < v.length; i++) { a[i] = clone(v[i]); }
      return a;
    }
    var o = {};
    var keys = Object.keys(v);
    for (var k = 0; k < keys.length; k++) { o[keys[k]] = clone(v[keys[k]]); }
    return o;
  }

  function deepEqual(a, b) {
    if (a === b) { return true; }
    if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') {
      return (typeof a === 'number' && typeof b === 'number' && isNaN(a) && isNaN(b));
    }
    var aArr = Array.isArray(a);
    var bArr = Array.isArray(b);
    if (aArr !== bArr) { return false; }
    if (aArr) {
      if (a.length !== b.length) { return false; }
      for (var i = 0; i < a.length; i++) { if (!deepEqual(a[i], b[i])) { return false; } }
      return true;
    }
    var ak = Object.keys(a), bk = Object.keys(b);
    if (ak.length !== bk.length) { return false; }
    for (var j = 0; j < ak.length; j++) {
      var key = ak[j];
      if (!Object.prototype.hasOwnProperty.call(b, key) || !deepEqual(a[key], b[key])) { return false; }
    }
    return true;
  }

  function okMsg(extra) {
    var res = { ok: true, error: null };
    if (isObj(extra)) {
      var ks = Object.keys(extra);
      for (var i = 0; i < ks.length; i++) { res[ks[i]] = extra[ks[i]]; }
    }
    return res;
  }
  function failMsg(msg) { return { ok: false, error: msg }; }

  function toUint8Array(v) {
    if (v instanceof Uint8Array) { return v; }
    if (v instanceof ArrayBuffer) { return new Uint8Array(v); }
    if (typeof v === 'string') { return Nj2Codec.utf8Encode(v); }
    if (isArr(v)) { return new Uint8Array(v); }
    return new Uint8Array(0);
  }

  var _catalogIndexCache = null;
  function getCatalogIndex() {
    if (_catalogIndexCache) { return _catalogIndexCache; }
    var idx = {
      attri: {}, item: {}, spell: {}, talent: {}, stunt: {},
      jingmai: {}, jingjie: {}, qinggong: {}, sect: {}, achievement: {},
      quest: {}, word: {}, companion: {}
    };
    var cat = Nj2Catalog || {};
    function indexArr(arr, map, keyField) {
      if (!isArr(arr)) { return; }
      for (var i = 0; i < arr.length; i++) {
        var row = arr[i];
        if (!isObj(row)) { continue; }
        var k = row[keyField || 'id'];
        if (k !== undefined && k !== null) { map[String(k)] = row; }
      }
    }
    indexArr(cat.attriTypes, idx.attri, 'index');
    indexArr(cat.items, idx.item, 'id');
    indexArr(cat.spells, idx.spell, 'id');
    indexArr(cat.talents, idx.talent, 'id');
    indexArr(cat.stunts, idx.stunt, 'id');
    indexArr(cat.jingmaiNodes, idx.jingmai, 'id');
    indexArr(cat.jingmaiNodes, idx.jingmai, 'nodeId');
    indexArr(cat.jingjieNodes, idx.jingjie, 'id');
    indexArr(cat.jingjieNodes, idx.jingjie, 'nodeId');
    indexArr(cat.qinggongNodes, idx.qinggong, 'id');
    indexArr(cat.sects, idx.sect, 'id');
    indexArr(cat.achievements, idx.achievement, 'id');
    indexArr(cat.quests, idx.quest, 'id');
    indexArr(cat.words, idx.word, 'id');
    indexArr(cat.companions, idx.companion, 'id');
    _catalogIndexCache = idx;
    return idx;
  }

  function attrLabel(index) {
    var i = toInt(index, -1);
    var idx = getCatalogIndex();
    var entry = idx.attri[String(i)];
    if (entry && entry.name) { return entry.name; }
    return ATTR_LABELS[i] || ('속성 ' + i);
  }

  function lookupName(kind, id) {
    var k = String(kind || '').toLowerCase();
    var idx = getCatalogIndex();
    var sid = String(id);
    if (k === 'attribute' || k === 'attr' || k === 'stat') { return attrLabel(id); }
    if (k === 'gamediff' || k === 'diff') { return GAME_DIFF_LABELS[toInt(id, 0)] || ('난이도 ' + id); }
    if (k === 'list' || k === 'listfield') { return LIST_FIELD_LABELS[sid] || sid; }
    if (k === 'jingjie' || k === 'gang') {
      var ji = toInt(id, -1);
      if (JINGJIE_LABELS[ji]) { return JINGJIE_LABELS[ji]; }
      var jrow = idx.jingjie[sid];
      return (jrow && jrow.name) || ('경계 ' + id);
    }
    var mapAlias = {
      item: idx.item, proto: idx.item, recipe: idx.item, peifang: idx.item,
      spell: idx.spell, miji: idx.spell,
      talent: idx.talent, stunt: idx.stunt,
      jingmai: idx.jingmai, qinggong: idx.qinggong,
      sect: idx.sect, achievement: idx.achievement,
      quest: idx.quest, word: idx.word,
      companion: idx.companion, npc: idx.companion
    };
    var bucket = mapAlias[k];
    if (bucket && bucket[sid]) {
      return bucket[sid].name || bucket[sid].desc || sid;
    }
    return sid;
  }

  function getPlayerKey(rootObj) {
    var pe = rootObj && rootObj.playerentity;
    if (!isObj(pe)) { return null; }
    var keys = Object.keys(pe);
    return keys.length ? keys[0] : null;
  }

  function getEntity(session, entityId) {
    if (!entityId || String(entityId) === String(session.playerKey)) { return session.player; }
    var ents = session.root && session.root.Entitys;
    if (isObj(ents) && isObj(ents[String(entityId)])) { return ents[String(entityId)]; }
    return null;
  }

  function listEntities(session) {
    var out = [];
    if (session.player) { out.push(session.player); }
    var ents = session.root && session.root.Entitys;
    if (isObj(ents)) {
      var keys = Object.keys(ents);
      for (var i = 0; i < keys.length; i++) {
        if (isObj(ents[keys[i]])) { out.push(ents[keys[i]]); }
      }
    }
    return out;
  }

  function itemContentOf(entity) {
    if (!isObj(entity)) { return null; }
    var st = ensureObj(entity, 'itemStorage');
    return ensureObj(st, 'content');
  }

  function attrBaseOf(entity) {
    if (!isObj(entity)) { return null; }
    return ensureObj(entity, 'm_valueBase');
  }

  function collectMaxUid(session) {
    var maxUid = 0;
    var entities = listEntities(session);
    for (var i = 0; i < entities.length; i++) {
      var content = itemContentOf(entities[i]);
      if (!content) { continue; }
      var uids = Object.keys(content);
      for (var j = 0; j < uids.length; j++) {
        var row = content[uids[j]];
        var c = toInt(uids[j], NaN);
        if (isNaN(c) && isObj(row)) { c = toInt(row[UID_KEY], NaN); }
        if (!isNaN(c) && c > maxUid) { maxUid = c; }
      }
    }
    return maxUid;
  }

  function syncEntityStorage(entity) {
    var content = itemContentOf(entity);
    if (!content) { return; }
    entity.itemStorage.count = Object.keys(content).length;
  }

  function syncDerived(session) {
    if (!session || !session.root) { throw new Error('세션이 없습니다.'); }
    var rootObj = session.root;
    var player = session.player;

    if (player) {
      if (typeof player.name === 'string' && player.name.length > 0) {
        rootObj.playername = player.name;
      } else if (typeof rootObj.playername === 'string' && rootObj.playername.length > 0) {
        player.name = rootObj.playername;
      }
      if (rootObj.posX !== undefined) { player.savePosx = String(rootObj.posX); }
      if (rootObj.posZ !== undefined) { player.savePosz = String(rootObj.posZ); }
    }

    var entities = listEntities(session);
    for (var i = 0; i < entities.length; i++) {
      syncEntityStorage(entities[i]);
    }

    var maxUid = collectMaxUid(session);
    var gen = toInt(rootObj.m_ItemIdGenerator, 0);
    if (gen < maxUid || rootObj.m_ItemIdGenerator === undefined) {
      rootObj.m_ItemIdGenerator = maxUid;
    }

    var meta = session.companionMeta;
    if (isObj(meta)) {
      if (typeof rootObj.playername === 'string' && rootObj.playername.length > 0) {
        meta.name = rootObj.playername;
      }
      if (rootObj.m_GameDiff !== undefined) { meta.gameDiff = String(rootObj.m_GameDiff); }
      if (rootObj.posX !== undefined) { meta.posX = String(rootObj.posX); }
      if (rootObj.posZ !== undefined) { meta.posZ = String(rootObj.posZ); }
      if (rootObj.gameTime !== undefined) { meta.gameTime = String(rootObj.gameTime); }
      if (rootObj.saveTime !== undefined) { meta.saveTime = String(rootObj.saveTime); }
      if (rootObj.filename !== undefined) { meta.filename = String(rootObj.filename); }
      if (player && player.modelClothesId !== undefined) { meta.modelId = String(player.modelClothesId); }
    }

    return session;
  }

  function createSession(saveInput, companionMeta) {
    if (!Nj2Codec || typeof Nj2Codec.parseSaveJson !== 'function') {
      throw new Error('코덱 모듈을 찾을 수 없습니다.');
    }
    var parsed = Nj2Codec.parseSaveJson(saveInput);
    var rootObj = parsed.root;
    var playerKey = getPlayerKey(rootObj);
    if (!playerKey) {
      throw new Error('주인공 엔티티(playerentity)를 찾지 못했습니다.');
    }
    var player = rootObj.playerentity[playerKey];
    if (!isObj(player)) {
      throw new Error('주인공 데이터가 올바르지 않습니다.');
    }

    ensureObj(player, 'm_valueBase');
    var storage = ensureObj(player, 'itemStorage');
    ensureObj(storage, 'content');
    if (!isObj(rootObj.Entitys)) { rootObj.Entitys = {}; }

    var metaCopy = null;
    if (companionMeta instanceof Uint8Array || (typeof ArrayBuffer !== 'undefined' && companionMeta instanceof ArrayBuffer)) {
      metaCopy = Nj2Codec.parseCompanionHeader(companionMeta);
    } else if (isObj(companionMeta)) {
      metaCopy = clone(companionMeta);
    }

    var session = {
      doc: parsed,
      root: rootObj,
      playerKey: playerKey,
      player: player,
      companionMeta: metaCopy,
      dirty: false,
      originalRoot: clone(rootObj)
    };
    syncDerived(session);
    return session;
  }

  function readJingjieLevel(session) {
    var p = session.player;
    if (p && p.jingjieGangLevel !== undefined) { return toInt(p.jingjieGangLevel, 0); }
    if (session.root && session.root.jingjieGangLevel !== undefined) { return toInt(session.root.jingjieGangLevel, 0); }
    return 0;
  }

  function validate(session) {
    var errors = [];
    var warnings = [];
    if (!session || !session.root) {
      return { ok: false, errors: ['세션이 없습니다.'], warnings: [] };
    }
    var rootObj = session.root;
    var player = session.player;
    var base = attrBaseOf(player);
    if (!base) {
      errors.push('주인공 속성 표(m_valueBase)가 없습니다.');
    } else {
      var bkeys = Object.keys(base);
      for (var bi = 0; bi < bkeys.length; bi++) {
        var k = bkeys[bi];
        var idx = toInt(k, -1);
        var raw = base[k];
        if (typeof raw !== 'number' || raw !== Math.trunc(raw)) {
          errors.push('속성 ' + k + ' (' + attrLabel(idx) + ') 는 정수여야 합니다.');
          continue;
        }
        if (idx === ZHENGXIE_INDEX) {
          if (raw < ZHENGXIE_MIN || raw > ZHENGXIE_MAX) {
            errors.push('정사 값은 ' + ZHENGXIE_MIN + ' ~ ' + ZHENGXIE_MAX + ' 범위여야 합니다.');
          }
        } else if (raw < INT_MIN || raw > INT_MAX) {
          errors.push('속성 ' + k + ' (' + attrLabel(idx) + ') 값이 정수 범위를 벗어났습니다.');
        }
      }
    }

    var jl = readJingjieLevel(session);
    if (jl < JINGJIE_MIN || jl > JINGJIE_MAX) {
      errors.push('경계 단계는 ' + JINGJIE_MIN + ' ~ ' + JINGJIE_MAX + ' 범위여야 합니다.');
    }

    if (rootObj.m_GameDiff !== undefined) {
      var gd = toInt(rootObj.m_GameDiff, NaN);
      if (isNaN(gd) || gd < GAME_DIFF_MIN || gd > GAME_DIFF_MAX) {
        errors.push('게임 난이도는 ' + GAME_DIFF_MIN + ' ~ ' + GAME_DIFF_MAX + ' 범위여야 합니다.');
      }
    }

    var entities = listEntities(session);
    for (var e = 0; e < entities.length; e++) {
      var entity = entities[e];
      var content = itemContentOf(entity);
      if (!content) { continue; }
      var uids = Object.keys(content);
      for (var u = 0; u < uids.length; u++) {
        var uid = uids[u];
        var row = content[uid];
        if (!isObj(row)) {
          errors.push('아이템 ' + uid + ' 구조가 올바르지 않습니다.');
          continue;
        }
        var n = toInt(row[COUNT_KEY], NaN);
        if (isNaN(n) || n < 1) {
          errors.push('아이템 ' + uid + ' 수량은 1 이상이어야 합니다.');
        }
        var proto = toInt(row[PROTO_KEY], NaN);
        if (isNaN(proto) || proto < 0) {
          errors.push('아이템 ' + uid + ' 원형 번호가 올바르지 않습니다.');
        }
      }
      var declared = toInt(entity.itemStorage && entity.itemStorage.count, NaN);
      if (!isNaN(declared) && declared !== uids.length) {
        warnings.push('아이템 개수(' + declared + ')가 실제 항목 수(' + uids.length + ')와 다릅니다.');
      }
    }

    var maxUid = collectMaxUid(session);
    var gen = toInt(rootObj.m_ItemIdGenerator, 0);
    if (gen < maxUid) {
      warnings.push('아이템 번호 생성기(' + gen + ')가 최대 번호(' + maxUid + ')보다 작습니다.');
    }

    return { ok: errors.length === 0, errors: errors, warnings: warnings };
  }

  var SUMMARY_FIELDS = [
    'playername', 'm_GameDiff', 'jingjieGangLevel',
    'posX', 'posZ', 'm_GameTimeYear', 'm_GameTimeMonth', 'm_GameTimeDay',
    'gongliRate', 'titleId'
  ];

  function setSummary(session, patch) {
    if (!session || !session.root) { return failMsg('세션이 없습니다.'); }
    if (!isObj(patch)) { return failMsg('변경할 값을 지정하세요.'); }
    var keys = Object.keys(patch);
    for (var i = 0; i < keys.length; i++) {
      var k = keys[i];
      if (SUMMARY_FIELDS.indexOf(k) === -1) {
        return failMsg('알 수 없는 요약 항목입니다: ' + k);
      }
      var v = patch[k];
      if (k === 'playername') {
        var s = String(v || '').trim();
        if (!s) { return failMsg('이름은 비어 있을 수 없습니다.'); }
        session.player.name = s;
        session.root.playername = s;
        continue;
      }
      if (k === 'posX' || k === 'posZ') {
        var f = toNum(v, NaN);
        if (isNaN(f)) { return failMsg(k + ' 값은 숫자여야 합니다.'); }
        session.root[k] = f;
        continue;
      }
      var n = toInt(v, null);
      if (n === null) { return failMsg(k + ' 값은 정수여야 합니다.'); }
      if (k === 'm_GameDiff') {
        if (n < GAME_DIFF_MIN || n > GAME_DIFF_MAX) {
          return failMsg('난이도는 ' + GAME_DIFF_MIN + ' ~ ' + GAME_DIFF_MAX + ' 범위여야 합니다.');
        }
        session.root.m_GameDiff = n;
      } else if (k === 'jingjieGangLevel') {
        if (n < JINGJIE_MIN || n > JINGJIE_MAX) {
          return failMsg('경계 단계는 ' + JINGJIE_MIN + ' ~ ' + JINGJIE_MAX + ' 범위여야 합니다.');
        }
        session.player.jingjieGangLevel = n;
      } else {
        session.player[k] = n;
      }
    }
    session.dirty = true;
    syncDerived(session);
    return okMsg();
  }

  function setAttribute(session, attrIndex, value, entityId) {
    if (!session || !session.root) { return failMsg('세션이 없습니다.'); }
    var idx = toInt(attrIndex, -1);
    if (idx < 0 || idx >= ATTR_COUNT) {
      return failMsg('속성 번호는 0 ~ ' + (ATTR_COUNT - 1) + ' 범위여야 합니다.');
    }
    var n = toInt(value, null);
    if (n === null) { return failMsg('속성 값은 정수여야 합니다.'); }
    if (idx === ZHENGXIE_INDEX) {
      if (n < ZHENGXIE_MIN || n > ZHENGXIE_MAX) {
        return failMsg('정사 값은 ' + ZHENGXIE_MIN + ' ~ ' + ZHENGXIE_MAX + ' 범위여야 합니다.');
      }
    } else if (n < INT_MIN || n > INT_MAX) {
      return failMsg('속성 값은 ' + INT_MIN + ' ~ ' + INT_MAX + ' 범위여야 합니다.');
    }
    var target = getEntity(session, entityId);
    if (!target) { return failMsg('대상 엔티티를 찾지 못했습니다: ' + entityId); }
    var base = attrBaseOf(target);
    base[String(idx)] = n;
    session.dirty = true;
    syncDerived(session);
    return okMsg();
  }

  function nextItemUid(session) {
    var gen = toInt(session.root.m_ItemIdGenerator, 0);
    var maxUid = collectMaxUid(session);
    var next = Math.max(gen, maxUid) + 1;
    session.root.m_ItemIdGenerator = next;
    return next;
  }

  function addItem(session, protoId, count, opts) {
    if (!session || !session.root) { return failMsg('세션이 없습니다.'); }
    var proto = toInt(protoId, -1);
    if (proto < 0) { return failMsg('아이템 원형 번호가 올바르지 않습니다.'); }
    var qty = toInt(count, 1);
    if (qty < 1) { return failMsg('수량은 1 이상이어야 합니다.'); }
    var o = isObj(opts) ? opts : {};
    var catRow = getCatalogIndex().item[String(proto)];
    var grade = toInt(o.grade, catRow ? toInt(catRow.grade, 10) : 10);
    var level = toInt(o.level, 1);
    var intensify = toInt(o.intensify, 0);
    if (grade < 1) { grade = 10; }
    if (level < 1) { level = 1; }
    if (intensify < 0) { intensify = 0; }

    var target = o.entityId ? getEntity(session, o.entityId) : session.player;
    if (!target) { return failMsg('대상 엔티티를 찾지 못했습니다: ' + o.entityId); }

    var content = itemContentOf(target);
    var uid = nextItemUid(session);
    var row = {};
    row[UID_KEY] = uid;
    row[PROTO_KEY] = proto;
    row[COUNT_KEY] = qty;
    row[INTENSIFY_KEY] = intensify;
    row[GRADE_KEY] = grade;
    row[LEVEL_KEY] = level;
    content[String(uid)] = row;

    session.dirty = true;
    syncDerived(session);
    return okMsg({ uid: uid });
  }

  var ITEM_PATCH_KEYS = {
    count: COUNT_KEY, nOverlap: COUNT_KEY,
    proto: PROTO_KEY, protoId: PROTO_KEY,
    weili: WEILI_KEY, sharp: SHARP_KEY, tenacity: TENACITY_KEY,
    intensify: INTENSIFY_KEY, durability: DURABILITY_KEY,
    grade: GRADE_KEY, quality: GRADE_KEY, level: LEVEL_KEY
  };

  function updateItem(session, uid, patch) {
    if (!session || !session.root) { return failMsg('세션이 없습니다.'); }
    if (!isObj(patch)) { return failMsg('변경할 값을 지정하세요.'); }
    var key = String(uid);
    var entities = listEntities(session);
    var row = null;
    for (var i = 0; i < entities.length; i++) {
      var content = itemContentOf(entities[i]);
      if (content && isObj(content[key])) { row = content[key]; break; }
    }
    if (!row) { return failMsg('아이템을 찾지 못했습니다: ' + key); }

    var keys = Object.keys(patch);
    for (var k = 0; k < keys.length; k++) {
      var field = keys[k];
      var slot = ITEM_PATCH_KEYS[field] || (/^\d+$/.test(field) ? field : null);
      if (!slot) { return failMsg('알 수 없는 아이템 항목입니다: ' + field); }
      if (slot === UID_KEY) { return failMsg('고유 번호는 변경할 수 없습니다.'); }
      var n = toInt(patch[field], null);
      if (n === null) { return failMsg(field + ' 값은 정수여야 합니다.'); }
      if (slot === COUNT_KEY && n < 1) { return failMsg('수량은 1 이상이어야 합니다.'); }
      row[slot] = n;
    }
    session.dirty = true;
    syncDerived(session);
    return okMsg();
  }

  function removeItem(session, uid) {
    if (!session || !session.root) { return failMsg('세션이 없습니다.'); }
    var key = String(uid);
    var entities = listEntities(session);
    var removed = false;
    for (var i = 0; i < entities.length; i++) {
      var content = itemContentOf(entities[i]);
      if (content && Object.prototype.hasOwnProperty.call(content, key)) {
        delete content[key];
        removed = true;
        break;
      }
    }
    if (!removed) { return failMsg('아이템을 찾지 못했습니다: ' + key); }
    session.dirty = true;
    syncDerived(session);
    return okMsg();
  }

  function toggleIdInList(session, fieldName, id, add) {
    if (!session || !session.root) { return failMsg('세션이 없습니다.'); }
    if (LIST_FIELDS.indexOf(fieldName) === -1) {
      return failMsg('알 수 없는 목록 항목입니다: ' + fieldName);
    }
    var n = toInt(id, null);
    if (n === null) { return failMsg('번호는 정수여야 합니다.'); }
    var list = ensureArr(session.player, fieldName);
    var pos = -1;
    for (var i = 0; i < list.length; i++) {
      if (toInt(list[i], NaN) === n) { pos = i; break; }
    }
    var want = typeof add === 'boolean' ? add : (pos === -1);
    if (want && pos === -1) { list.push(n); }
    else if (!want && pos !== -1) { list.splice(pos, 1); }
    session.dirty = true;
    syncDerived(session);
    return okMsg({ active: want });
  }

  function setJingjieLevel(session, level) {
    return setSummary(session, { jingjieGangLevel: level });
  }

  var PRESETS = [
    {
      id: 'rich_start',
      title: '부유한 시작',
      description: '동전 10,000,000 · 수위 1,000,000 · 감오 500,000 · 위망 5,000을 지급합니다.',
      apply: function (session) {
        var pairs = [[68, 10000000], [69, 1000000], [70, 500000], [66, 5000]];
        for (var i = 0; i < pairs.length; i++) {
          var r = setAttribute(session, pairs[i][0], pairs[i][1]);
          if (!r.ok) { return r; }
        }
        return okMsg();
      }
    },
    {
      id: 'core_stats_500',
      title: '핵심 능력치 500',
      description: '원기·자질·힘·내공·체격·정신·신법·집중·행운(4~12)과 오성(73)을 500, 기혈·진기(0~3)를 50,000으로 설정합니다.',
      apply: function (session) {
        for (var i = 4; i <= 12; i++) {
          var r = setAttribute(session, i, 500);
          if (!r.ok) { return r; }
        }
        var star = setAttribute(session, 73, 500);
        if (!star.ok) { return star; }
        for (var j = 0; j <= 3; j++) {
          var vr = setAttribute(session, j, 50000);
          if (!vr.ok) { return vr; }
        }
        return okMsg();
      }
    },
    {
      id: 'weapons_1000',
      title: '병기 · 학식 1,000',
      description: '8대 병기 숙련(34~41)과 8대 학식 소양(42~49)을 모두 1,000으로 올립니다.',
      apply: function (session) {
        for (var i = 34; i <= 49; i++) {
          var r = setAttribute(session, i, 1000);
          if (!r.ok) { return r; }
        }
        return okMsg();
      }
    },
    {
      id: 'life_master_1000',
      title: '생활 기예 달인',
      description: '16대 생활 기예(50~65)를 모두 1,000으로 맞춥니다.',
      apply: function (session) {
        for (var i = 50; i <= 65; i++) {
          var r = setAttribute(session, i, 1000);
          if (!r.ok) { return r; }
        }
        return okMsg();
      }
    },
    {
      id: 'jingjie_13',
      title: '경계 13단계 돌파',
      description: '경계를 최고 단계(13)로 올리고 기혈·진기 200,000 및 외공·내공·방어를 대폭 강화합니다.',
      apply: function (session) {
        var r = setJingjieLevel(session, 13);
        if (!r.ok) { return r; }
        var boosts = [[0, 200000], [1, 200000], [2, 200000], [3, 200000], [20, 2500], [21, 2500], [22, 1800], [23, 1800]];
        for (var i = 0; i < boosts.length; i++) {
          var b = setAttribute(session, boosts[i][0], boosts[i][1]);
          if (!b.ok) { return b; }
        }
        return okMsg();
      }
    },
    {
      id: 'starter_kit',
      title: '초보자 지원 꾸러미',
      description: '카탈로그 기반 초반 회복 단약 및 제조법 5종을 가방에 추가합니다.',
      apply: function (session) {
        var catItems = (Nj2Catalog && isArr(Nj2Catalog.items) && Nj2Catalog.items.length >= 5)
          ? Nj2Catalog.items.slice(0, 5)
          : [{ id: 1001, grade: 10 }, { id: 1002, grade: 10 }, { id: 1003, grade: 11 }, { id: 1004, grade: 12 }, { id: 1005, grade: 13 }];
        for (var i = 0; i < catItems.length; i++) {
          var it = catItems[i];
          var r = addItem(session, it.id, 10, { grade: it.grade || 10, level: 1 });
          if (!r.ok) { return r; }
        }
        return okMsg();
      }
    }
  ];

  function applyPreset(session, presetId) {
    if (!session || !session.root) { return failMsg('세션이 없습니다.'); }
    var pid = String(presetId);
    var preset = null;
    for (var i = 0; i < PRESETS.length; i++) {
      if (PRESETS[i].id === pid) { preset = PRESETS[i]; break; }
    }
    if (!preset) { return failMsg('알 수 없는 프리셋입니다: ' + pid); }
    var r = preset.apply(session);
    if (!r || !r.ok) { return r || failMsg('프리셋 적용 중 오류가 발생했습니다.'); }
    session.dirty = true;
    syncDerived(session);
    return okMsg();
  }

  function listPresets() {
    return PRESETS.map(function (p) {
      return { id: p.id, title: p.title, description: p.description };
    });
  }

  function flatten(node, prefix, out) {
    if (isObj(node)) {
      var keys = Object.keys(node);
      if (keys.length === 0 && prefix) { out[prefix] = {}; return; }
      for (var i = 0; i < keys.length; i++) {
        flatten(node[keys[i]], prefix ? (prefix + '/' + keys[i]) : keys[i], out);
      }
      return;
    }
    if (isArr(node)) {
      if (node.length === 0 && prefix) { out[prefix] = []; return; }
      for (var j = 0; j < node.length; j++) {
        flatten(node[j], prefix + '/' + j, out);
      }
      return;
    }
    if (prefix) { out[prefix] = node; }
  }

  function computeDiff(session) {
    if (!session || !session.originalRoot) { return []; }
    var before = {}, after = {};
    flatten(session.originalRoot, '', before);
    flatten(session.root, '', after);
    var changes = [], seen = {};
    var bkeys = Object.keys(before);
    for (var i = 0; i < bkeys.length; i++) {
      var p = bkeys[i];
      seen[p] = true;
      if (!Object.prototype.hasOwnProperty.call(after, p)) {
        changes.push({ path: p, before: before[p], after: null });
      } else if (!deepEqual(before[p], after[p])) {
        changes.push({ path: p, before: before[p], after: after[p] });
      }
    }
    var akeys = Object.keys(after);
    for (var j = 0; j < akeys.length; j++) {
      var ap = akeys[j];
      if (!seen[ap]) { changes.push({ path: ap, before: null, after: after[ap] }); }
    }
    changes.sort(function (x, y) { return x.path < y.path ? -1 : (x.path > y.path ? 1 : 0); });
    return changes;
  }

  function exportSave(session, opts) {
    if (!session || !session.root) { throw new Error('세션이 없습니다.'); }
    syncDerived(session);
    var o = isObj(opts) ? opts : {};
    if (o.validate !== false) {
      var report = validate(session);
      if (!report.ok) {
        var err = new Error('세이브 검증 실패: ' + report.errors.join(' / '));
        err.validation = report;
        throw err;
      }
    }
    var jsonBytes = toUint8Array(Nj2Codec.serializeSaveJson(session.doc || session.root));
    var headerBytes = null;
    if (o.includeHeader !== false && isObj(session.companionMeta)) {
      headerBytes = Nj2Codec.encodeCompanionHeader(session.companionMeta);
    }
    return { jsonBytes: jsonBytes, headerBytes: headerBytes };
  }

  function getSummary(session) {
    if (!session || !session.root) { return null; }
    var rootObj = session.root;
    var player = session.player;
    var count = 0;
    var entities = listEntities(session);
    for (var i = 0; i < entities.length; i++) {
      var content = itemContentOf(entities[i]);
      if (content) { count += Object.keys(content).length; }
    }
    var vbase = attrBaseOf(player) || {};
    var v = validate(session);
    var jingjie = readJingjieLevel(session);
    var diff = toInt(rootObj.m_GameDiff, 1);

    return {
      playerKey: session.playerKey,
      playername: String(rootObj.playername || player.name || ''),
      name: String(player.name || rootObj.playername || ''),
      filename: String(rootObj.filename || ''),
      saveTime: String(rootObj.saveTime || ''),
      gameDiff: diff,
      gameDiffLabel: lookupName('gameDiff', diff),
      jingjieGangLevel: jingjie,
      jingjieLabel: lookupName('jingjie', jingjie),
      posX: toNum(rootObj.posX, 0),
      posZ: toNum(rootObj.posZ, 0),
      gongliRate: toInt(player.gongliRate, 100),
      gameTime: {
        year: toInt(player.m_GameTimeYear, 1),
        month: toInt(player.m_GameTimeMonth, 1),
        day: toInt(player.m_GameTimeDay, 1)
      },
      itemCount: count,
      itemIdGenerator: toInt(rootObj.m_ItemIdGenerator, 0),
      companionCount: isObj(rootObj.Entitys) ? Object.keys(rootObj.Entitys).length : 0,
      core: {
        hp: toInt(vbase['0'], 0),
        mp: toInt(vbase['1'], 0),
        money: toInt(vbase['68'], 0),
        xiuwei: toInt(vbase['69'], 0),
        ganwu: toInt(vbase['70'], 0),
        weiwang: toInt(vbase['66'], 0)
      },
      dirty: !!session.dirty,
      validation: { ok: v.ok, errorCount: v.errors.length, warningCount: v.warnings.length }
    };
  }

  function commitSnapshot(session) {
    if (!session || !session.root) { return failMsg('세션이 없습니다.'); }
    session.originalRoot = clone(session.root);
    session.dirty = false;
    return okMsg();
  }

  return {
    VERSION: '1.0.0',
    ATTR_COUNT: ATTR_COUNT,
    INT_MIN: INT_MIN,
    INT_MAX: INT_MAX,
    ZHENGXIE_INDEX: ZHENGXIE_INDEX,
    ZHENGXIE_MIN: ZHENGXIE_MIN,
    ZHENGXIE_MAX: ZHENGXIE_MAX,
    JINGJIE_MIN: JINGJIE_MIN,
    JINGJIE_MAX: JINGJIE_MAX,
    GAME_DIFF_MIN: GAME_DIFF_MIN,
    GAME_DIFF_MAX: GAME_DIFF_MAX,
    ATTR_LABELS: ATTR_LABELS,
    JINGJIE_LABELS: JINGJIE_LABELS,
    GAME_DIFF_LABELS: GAME_DIFF_LABELS,
    LIST_FIELDS: LIST_FIELDS,
    LIST_FIELD_LABELS: LIST_FIELD_LABELS,
    PRESETS: PRESETS,
    createSession: createSession,
    syncDerived: syncDerived,
    validate: validate,
    setSummary: setSummary,
    setAttribute: setAttribute,
    addItem: addItem,
    updateItem: updateItem,
    removeItem: removeItem,
    toggleIdInList: toggleIdInList,
    setJingjieLevel: setJingjieLevel,
    applyPreset: applyPreset,
    listPresets: listPresets,
    computeDiff: computeDiff,
    exportSave: exportSave,
    getSummary: getSummary,
    lookupName: lookupName,
    attrLabel: attrLabel,
    commitSnapshot: commitSnapshot
  };
}));
