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
  var INT32_MIN = -2147483648;
  var INT_MAX = 2147483647;
  var SUB_SLOT_BAG_BEGIN = 12;
  var ZHENGXIE_INDEX = 71;
  var DAODE_INDEX = 67;
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
    'talents', 'learnedpeifang', 'm0', 'm1', 'm8', 'qgactive', 'm_AchievementList'
  ];

  var LIST_FIELD_LABELS = {
    m_learntSpell: '습득 무학',
    mijiIdList: '비급 목록',
    m_StuntIds: '보유 특기',
    m_EquipedStuntIds: '장착 특기',
    talents: '선천 천부',
    learnedpeifang: '습득 제조법',
    m0: '활성 경맥 노드',
    m1: '활성 오장 노드',
    m8: '완료 경맥 목록',
    m9: '완료 오장 목록',
    qgactive: '활성 경공 노드',
    m_AchievementList: '달성 업적'
  };

  var FIELD_SCHEMAS = {
    m_learntSpell: { type: 'dict_list' },
    m_EquipedStuntIds: { type: 'dict_val' },
    qgactive: { type: 'dict_val' },
    mijiIdList: { type: 'list' },
    m_StuntIds: { type: 'list' },
    talents: { type: 'list' },
    learnedpeifang: { type: 'list' },
    m0: { type: 'list' },
    m1: { type: 'list' },
    m8: { type: 'list' },
    m9: { type: 'list' },
    m_AchievementList: { type: 'list' }
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

  function listEntitiesWithPaths(session) {
    var out = [];
    if (session.player) {
      out.push({ entity: session.player, basePath: 'playerentity\x1f' + session.playerKey, isPlayer: true });
    }
    var ents = session.root && session.root.Entitys;
    if (isObj(ents)) {
      var keys = Object.keys(ents);
      for (var i = 0; i < keys.length; i++) {
        if (isObj(ents[keys[i]])) {
          out.push({ entity: ents[keys[i]], basePath: 'Entitys\x1f' + keys[i], isPlayer: false });
        }
      }
    }
    return out;
  }

  function entityBasePath(session, entityId) {
    if (!entityId || String(entityId) === String(session.playerKey)) {
      return 'playerentity\x1f' + session.playerKey;
    }
    return 'Entitys\x1f' + String(entityId);
  }

  function itemUidPath(basePath, slotKey) {
    return basePath + '\x1fitemStorage\x1fcontent\x1f' + String(slotKey) + '\x1f' + UID_KEY;
  }

  function readItemContent(entity) {
    if (!isObj(entity) || !isObj(entity.itemStorage)) { return null; }
    return isObj(entity.itemStorage.content) ? entity.itemStorage.content : null;
  }

  function ensureItemContent(entity) {
    if (!isObj(entity)) { return null; }
    var st = ensureObj(entity, 'itemStorage');
    return ensureObj(st, 'content');
  }

  function itemContentOf(entity) {
    return ensureItemContent(entity);
  }

  function hasOwn(obj, key) {
    return Object.prototype.hasOwnProperty.call(obj, key);
  }

  function decodeField(val) {
    if (val === undefined || val === null || val === '') { return null; }
    if (typeof val === 'string') {
      return Nj2Codec && typeof Nj2Codec.decodeJsonField === 'function'
        ? Nj2Codec.decodeJsonField(val)
        : null;
    }
    return typeof val === 'object' ? val : null;
  }

  function encodeField(val) {
    if (Nj2Codec && typeof Nj2Codec.encodeJsonField === 'function') {
      return Nj2Codec.encodeJsonField(val);
    }
    return JSON.stringify(val);
  }

  function readValueBase(entity) {
    var out = {};
    if (!isObj(entity)) { return out; }
    var decoded = decodeField(entity.m_valueBase);
    if (isObj(decoded)) {
      var ks = Object.keys(decoded);
      for (var i = 0; i < ks.length; i++) {
        out[ks[i]] = decoded[ks[i]];
      }
    }
    return out;
  }

  function writeValueBase(entity, map) {
    if (!isObj(entity)) { return; }
    var src = isObj(map) ? map : {};
    var out = {};
    var ks = Object.keys(src);
    for (var i = 0; i < ks.length; i++) {
      var k = ks[i];
      var n = toInt(src[k], null);
      if (n !== null) {
        out[k] = n;
      }
    }
    entity.m_valueBase = encodeField(out);
  }

  function getAttributes(session, entityId) {
    if (!session || !session.root) { return {}; }
    var target = getEntity(session, entityId);
    return target ? readValueBase(target) : {};
  }

  function normalizeIdArray(val) {
    var arr = [];
    if (!isArr(val)) { return arr; }
    for (var i = 0; i < val.length; i++) {
      var n = toInt(val[i], null);
      if (n !== null) { arr.push(n); }
    }
    return arr;
  }

  function spellBucketKey(id) {
    var entry = getCatalogIndex().spell[String(id)];
    var st = (entry && entry.spellType !== undefined && entry.spellType !== null) ? toInt(entry.spellType, 0) : 0;
    return String(st);
  }

  function stuntSlotKey(id) {
    var entry = getCatalogIndex().stunt[String(id)];
    var st = (entry && entry.stuntType !== undefined && entry.stuntType !== null) ? toInt(entry.stuntType, 0) : 0;
    return String(st);
  }

  function qinggongGroupKey(id) {
    var entry = getCatalogIndex().qinggong[String(id)];
    var gid = (entry && entry.groupId !== undefined && entry.groupId !== null) ? toInt(entry.groupId, Math.floor(id / 10)) : Math.floor(id / 10);
    return String(gid);
  }

  function decodeDictList(val) {
    var decoded = decodeField(val);
    var dict = {};
    if (!decoded || typeof decoded !== 'object') { return dict; }
    if (isArr(decoded)) {
      var ids = normalizeIdArray(decoded);
      for (var i = 0; i < ids.length; i++) {
        var bk = spellBucketKey(ids[i]);
        if (!dict[bk]) { dict[bk] = []; }
        if (dict[bk].indexOf(ids[i]) === -1) { dict[bk].push(ids[i]); }
      }
      return dict;
    }
    var ks = Object.keys(decoded);
    for (var k = 0; k < ks.length; k++) {
      var key = ks[k];
      dict[key] = normalizeIdArray(decoded[key]);
    }
    return dict;
  }

  function decodeDictVal(val, fieldName) {
    var decoded = decodeField(val);
    var dict = {};
    if (!decoded || typeof decoded !== 'object') { return dict; }
    if (isArr(decoded)) {
      var ids = normalizeIdArray(decoded);
      for (var i = 0; i < ids.length; i++) {
        var dk = fieldName === 'qgactive' ? qinggongGroupKey(ids[i]) : stuntSlotKey(ids[i]);
        dict[dk] = ids[i];
      }
      return dict;
    }
    var ks = Object.keys(decoded);
    for (var k = 0; k < ks.length; k++) {
      var key = ks[k];
      var n = toInt(decoded[key], null);
      if (n !== null) { dict[key] = n; }
    }
    return dict;
  }

  function decodeListField(val) {
    var decoded = decodeField(val);
    if (isArr(decoded)) { return normalizeIdArray(decoded); }
    return [];
  }

  function getFieldIds(session, fieldName, entityId) {
    var schema = FIELD_SCHEMAS[fieldName];
    if (!schema || !session || !session.root) { return []; }
    var target = getEntity(session, entityId);
    if (!target) { return []; }
    var raw = target[fieldName];
    var ids = [];
    var seen = {};
    var i, k, ks;
    if (schema.type === 'dict_list') {
      var dl = decodeDictList(raw);
      ks = Object.keys(dl);
      for (k = 0; k < ks.length; k++) {
        var arr = dl[ks[k]];
        for (i = 0; i < arr.length; i++) {
          if (!seen[String(arr[i])]) { seen[String(arr[i])] = true; ids.push(arr[i]); }
        }
      }
      return ids;
    }
    if (schema.type === 'dict_val') {
      var dv = decodeDictVal(raw, fieldName);
      ks = Object.keys(dv);
      for (k = 0; k < ks.length; k++) {
        var n = dv[ks[k]];
        if (!seen[String(n)]) { seen[String(n)] = true; ids.push(n); }
      }
      return ids;
    }
    return decodeListField(raw);
  }

  function normalizeEntityWritePropertyJson(entity) {
    if (!isObj(entity)) { return; }
    if (entity.m_valueBase !== undefined && entity.m_valueBase !== null && typeof entity.m_valueBase !== 'string') {
      writeValueBase(entity, readValueBase(entity));
    }
    var fieldNames = Object.keys(FIELD_SCHEMAS);
    for (var f = 0; f < fieldNames.length; f++) {
      var fn = fieldNames[f];
      var val = entity[fn];
      if (val === undefined || val === null || typeof val === 'string') { continue; }
      var schema = FIELD_SCHEMAS[fn];
      if (schema.type === 'dict_list') {
        entity[fn] = encodeField(decodeDictList(val));
      } else if (schema.type === 'dict_val') {
        entity[fn] = encodeField(decodeDictVal(val, fn));
      } else {
        entity[fn] = encodeField(decodeListField(val));
      }
    }
  }

  function normalizeWritePropertyJsonRoot(rootObj) {
    if (!isObj(rootObj)) { return; }
    var cols = ['playerentity', 'Entitys'];
    for (var c = 0; c < cols.length; c++) {
      var group = rootObj[cols[c]];
      if (!isObj(group)) { continue; }
      var ks = Object.keys(group);
      for (var i = 0; i < ks.length; i++) {
        normalizeEntityWritePropertyJson(group[ks[i]]);
      }
    }
    var rootStrFields = ['allentityids', 'npcGuidProidDic'];
    for (var r = 0; r < rootStrFields.length; r++) {
      var rk = rootStrFields[r];
      if (rootObj[rk] !== undefined && rootObj[rk] !== null && typeof rootObj[rk] !== 'string') {
        rootObj[rk] = encodeField(rootObj[rk]);
      }
    }
  }

  function detectCorruptedWritePropertyJson(rootObj) {
    var corrupted = [];
    if (!isObj(rootObj)) { return corrupted; }
    var cols = ['playerentity', 'Entitys'];
    var fnames = Object.keys(FIELD_SCHEMAS);
    for (var c = 0; c < cols.length; c++) {
      var group = rootObj[cols[c]];
      if (!isObj(group)) { continue; }
      var ks = Object.keys(group);
      for (var i = 0; i < ks.length; i++) {
        var ent = group[ks[i]];
        if (!isObj(ent)) { continue; }
        if (ent.m_valueBase !== undefined && ent.m_valueBase !== null && typeof ent.m_valueBase !== 'string') {
          corrupted.push(cols[c] + '.' + ks[i] + '.m_valueBase');
        }
        for (var fi = 0; fi < fnames.length; fi++) {
          var fn = fnames[fi];
          if (hasOwn(ent, fn) && ent[fn] !== undefined && ent[fn] !== null && typeof ent[fn] !== 'string') {
            corrupted.push(cols[c] + '.' + ks[i] + '.' + fn);
          }
        }
      }
    }
    var rootStrFields = ['allentityids', 'npcGuidProidDic'];
    for (var r = 0; r < rootStrFields.length; r++) {
      var rk = rootStrFields[r];
      if (rootObj[rk] !== undefined && rootObj[rk] !== null && typeof rootObj[rk] !== 'string') {
        corrupted.push(rk);
      }
    }
    return corrupted;
  }

  function ensureRawBigInts(session) {
    if (!session) { return null; }
    if (!session.doc || typeof session.doc !== 'object') {
      session.doc = { root: session.root, rawBigInts: new Map(), floatPaths: new Set() };
    }
    if (!(session.doc.rawBigInts instanceof Map)) {
      session.doc.rawBigInts = new Map();
    }
    return session.doc.rawBigInts;
  }

  function getExactUidStr(session, path, rawVal) {
    var map = session && session.doc && session.doc.rawBigInts instanceof Map ? session.doc.rawBigInts : null;
    if (map && path && map.has(path)) {
      return map.get(path);
    }
    if (rawVal === undefined || rawVal === null || rawVal === '') { return ''; }
    return String(rawVal);
  }

  function getExactUidBig(session, path, rawVal) {
    return parseUidToBigInt(getExactUidStr(session, path, rawVal));
  }

  function setUidAtPath(session, path, bigVal, obj, prop) {
    var isBig = typeof BigInt === 'function' && typeof bigVal === 'bigint';
    var numVal = Number(bigVal);
    obj[prop] = numVal;
    var map = ensureRawBigInts(session);
    if (map && path) {
      if (isBig && bigVal > BigInt(Number.MAX_SAFE_INTEGER)) {
        map.set(path, bigVal.toString());
      } else {
        map.delete(path);
      }
    }
    return isBig && bigVal > BigInt(Number.MAX_SAFE_INTEGER) ? bigVal.toString() : numVal;
  }

  function parseUidToBigInt(val) {
    if (val === undefined || val === null || val === '') { return null; }
    var s = String(val).trim();
    if (!/^\d+$/.test(s)) { return null; }
    if (typeof BigInt === 'function') {
      try { return BigInt(s); } catch (e) { return null; }
    }
    var n = parseInt(s, 10);
    return isFinite(n) && n >= 0 ? n : null;
  }

  function bigIntToUidValue(b) {
    if (typeof BigInt === 'function' && typeof b === 'bigint') {
      if (b <= BigInt(Number.MAX_SAFE_INTEGER)) { return Number(b); }
      return b.toString();
    }
    return Number(b);
  }

  function compareBig(a, b) {
    return a < b ? -1 : (a > b ? 1 : 0);
  }

  function collectMaxUidBig(session) {
    var zero = typeof BigInt === 'function' ? BigInt(0) : 0;
    var maxUid = zero;
    var entries = listEntitiesWithPaths(session);
    for (var i = 0; i < entries.length; i++) {
      var content = readItemContent(entries[i].entity);
      if (!content) { continue; }
      var keys = Object.keys(content);
      for (var j = 0; j < keys.length; j++) {
        var slotKey = keys[j];
        var row = content[slotKey];
        var uidPath = itemUidPath(entries[i].basePath, slotKey);
        var c = isObj(row) ? getExactUidBig(session, uidPath, row[UID_KEY]) : null;
        if (c === null) { c = parseUidToBigInt(slotKey); }
        if (c !== null && compareBig(c, maxUid) > 0) { maxUid = c; }
      }
    }
    return maxUid;
  }

  function collectMaxUid(session) {
    return bigIntToUidValue(collectMaxUidBig(session));
  }

  function parseSlotKey(key) {
    if (typeof key !== 'string' || !/^\d+$/.test(key)) { return -1; }
    var n = parseInt(key, 10);
    return isFinite(n) && n >= 0 ? n : -1;
  }

  function maxSlotInContent(content) {
    var maxSlot = -1;
    if (!isObj(content)) { return maxSlot; }
    var keys = Object.keys(content);
    for (var i = 0; i < keys.length; i++) {
      var s = parseSlotKey(keys[i]);
      if (s > maxSlot) { maxSlot = s; }
    }
    return maxSlot;
  }

  function findFreeBagSlot(content) {
    var slot = SUB_SLOT_BAG_BEGIN;
    if (!isObj(content)) { return slot; }
    while (Object.prototype.hasOwnProperty.call(content, String(slot)) && content[String(slot)] != null) {
      slot += 1;
    }
    return slot;
  }

  function syncEntityStorage(entity) {
    if (!isObj(entity) || !isObj(entity.itemStorage)) { return; }
    var content = readItemContent(entity);
    var maxSlot = maxSlotInContent(content);
    var existing = toInt(entity.itemStorage.count, NaN);
    var minNeeded = maxSlot >= 0 ? (maxSlot + 1) : 0;
    if (isNaN(existing) || existing < minNeeded) {
      entity.itemStorage.count = Math.max(minNeeded, isNaN(existing) ? 0 : existing);
    }
  }

  function syncDerived(session) {
    if (!session || !session.root) { throw new Error('세션이 없습니다.'); }
    var rootObj = session.root;
    var player = session.player;

    if (player) {
      if (typeof player.name === 'string' && player.name.length > 0 && rootObj.playername !== undefined && rootObj.playername !== player.name) {
        rootObj.playername = player.name;
      }
    }

    var entities = listEntities(session);
    for (var i = 0; i < entities.length; i++) {
      syncEntityStorage(entities[i]);
    }

    var maxUidBig = collectMaxUidBig(session);
    var genBig = getExactUidBig(session, 'm_ItemIdGenerator', rootObj.m_ItemIdGenerator);
    if (genBig === null || compareBig(genBig, maxUidBig) < 0) {
      if (rootObj.m_ItemIdGenerator !== undefined || compareBig(maxUidBig, typeof BigInt === 'function' ? BigInt(0) : 0) > 0) {
        setUidAtPath(session, 'm_ItemIdGenerator', maxUidBig, rootObj, 'm_ItemIdGenerator');
      }
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

    var metaCopy = null;
    if (companionMeta instanceof Uint8Array || (typeof ArrayBuffer !== 'undefined' && companionMeta instanceof ArrayBuffer)) {
      metaCopy = Nj2Codec.parseCompanionHeader(companionMeta);
    } else if (isObj(companionMeta)) {
      metaCopy = clone(companionMeta);
    }

    var origBigInts = parsed.rawBigInts instanceof Map ? new Map(parsed.rawBigInts) : new Map();
    if (!(parsed.rawBigInts instanceof Map)) {
      parsed.rawBigInts = new Map();
    }
    var corruptedFields = detectCorruptedWritePropertyJson(rootObj);
    var needsRepair = corruptedFields.length > 0;

    var session = {
      doc: parsed,
      root: rootObj,
      playerKey: playerKey,
      player: player,
      companionMeta: metaCopy,
      dirty: needsRepair,
      needsRepair: needsRepair,
      corruptedFields: corruptedFields,
      originalRawBigInts: origBigInts,
      originalRoot: clone(rootObj)
    };
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
    var rawVb = isObj(player) ? player.m_valueBase : undefined;
    var base = null;
    if (rawVb === undefined || rawVb === null) {
      errors.push('주인공 속성 표(m_valueBase)가 없습니다.');
    } else if (typeof rawVb === 'string') {
      var decodedVb = decodeField(rawVb);
      if (!isObj(decodedVb)) {
        errors.push('주인공 속성 표(m_valueBase) JSON 문자열이 손상되었습니다.');
      } else {
        base = decodedVb;
      }
    } else if (isObj(rawVb)) {
      base = rawVb;
    } else {
      errors.push('주인공 속성 표(m_valueBase) 형식이 올바르지 않습니다.');
    }
    if (base) {
      var bkeys = Object.keys(base);
      for (var bi = 0; bi < bkeys.length; bi++) {
        var k = bkeys[bi];
        var idx = toInt(k, -1);
        var raw = base[k];
        var numRaw = typeof raw === 'number' ? raw : (typeof raw === 'string' && raw !== '' ? Number(raw) : NaN);
        if (!isFinite(numRaw) || isNaN(numRaw)) {
          errors.push('속성 ' + k + ' (' + attrLabel(idx) + ') 값이 숫자가 아닙니다.');
          continue;
        }
        if (numRaw !== Math.trunc(numRaw)) {
          warnings.push('속성 ' + k + ' (' + attrLabel(idx) + ') 값이 정수가 아닙니다: ' + numRaw);
          continue;
        }
        if (numRaw < INT32_MIN || numRaw > INT_MAX) {
          errors.push('속성 ' + k + ' (' + attrLabel(idx) + ') 값이 정수 범위를 벗어났습니다.');
        } else if (idx === ZHENGXIE_INDEX && (numRaw < ZHENGXIE_MIN || numRaw > ZHENGXIE_MAX)) {
          warnings.push('정사 값이 권장 범위(' + ZHENGXIE_MIN + ' ~ ' + ZHENGXIE_MAX + ')를 벗어났습니다.');
        } else if (numRaw < 0 && idx !== ZHENGXIE_INDEX && idx !== DAODE_INDEX && idx < 200) {
          warnings.push('속성 ' + k + ' (' + attrLabel(idx) + ') 값이 음수입니다: ' + numRaw);
        }
      }
    }

    var corruptedNow = detectCorruptedWritePropertyJson(rootObj);
    if (corruptedNow.length > 0 || session.needsRepair) {
      warnings.push('이전 버전(v1.0.2 등) 손상 의심(비문자열 직렬화 필드 감지): 원본 .backup-*.bak 백업에서 복원한 뒤 v1.0.3으로 다시 편집하는 것을 강력 권장합니다.');
    }

    if (isObj(player)) {
      var fnames = Object.keys(FIELD_SCHEMAS);
      for (var fi = 0; fi < fnames.length; fi++) {
        var fn = fnames[fi];
        if (!hasOwn(player, fn) || player[fn] === undefined || player[fn] === null || player[fn] === '') { continue; }
        var fv = player[fn];
        var fschema = FIELD_SCHEMAS[fn];
        if (typeof fv === 'string') {
          var parsedFv = decodeField(fv);
          if (parsedFv === null) {
            errors.push('항목 ' + fn + ' JSON 문자열이 손상되었습니다.');
          } else if ((fschema.type === 'dict_list' || fschema.type === 'dict_val') && !isObj(parsedFv)) {
            errors.push('항목 ' + fn + ' 형식이 객체(Dictionary)가 아닙니다.');
          } else if (fschema.type === 'list' && !isArr(parsedFv)) {
            errors.push('항목 ' + fn + ' 형식이 배열(List)이 아닙니다.');
          }
        }
      }
    }

    var jl = readJingjieLevel(session);
    if (jl < JINGJIE_MIN || jl > JINGJIE_MAX) {
      warnings.push('경계 단계가 기본 범위(' + JINGJIE_MIN + ' ~ ' + JINGJIE_MAX + ')를 벗어났습니다: ' + jl);
    }

    if (rootObj.m_GameDiff !== undefined) {
      var gd = toInt(rootObj.m_GameDiff, NaN);
      if (isNaN(gd)) {
        errors.push('게임 난이도 값이 정수가 아닙니다.');
      } else if (gd < 0 || gd > GAME_DIFF_MAX) {
        warnings.push('게임 난이도가 기본 범위(0 ~ ' + GAME_DIFF_MAX + ')를 벗어났습니다: ' + gd);
      }
    }

    var entityEntries = listEntitiesWithPaths(session);
    var seenPlayerUids = {};
    for (var e = 0; e < entityEntries.length; e++) {
      var ep = entityEntries[e];
      var entity = ep.entity;
      if (!isObj(entity) || !isObj(entity.itemStorage)) { continue; }
      var content = readItemContent(entity);
      if (!content) { continue; }
      var slotKeys = Object.keys(content);
      var maxSlot = -1;
      for (var u = 0; u < slotKeys.length; u++) {
        var slotKey = slotKeys[u];
        var slotIdx = parseSlotKey(slotKey);
        if (slotIdx > maxSlot) { maxSlot = slotIdx; }
        var row = content[slotKey];
        if (!isObj(row)) {
          errors.push('아이템 슬롯 ' + slotKey + ' 구조가 올바르지 않습니다.');
          continue;
        }
        if (ep.isPlayer) {
          var uidStr = getExactUidStr(session, itemUidPath(ep.basePath, slotKey), row[UID_KEY]);
          if (uidStr && uidStr !== '0') {
            if (hasOwn(seenPlayerUids, uidStr)) {
              errors.push('중복된 아이템 고유 번호(' + uidStr + ')가 슬롯 ' + seenPlayerUids[uidStr] + '과 ' + slotKey + '에 존재합니다.');
            } else {
              seenPlayerUids[uidStr] = slotKey;
            }
          }
        }
        // 게임 Item.Save()는 수량(nOverlap)이 1일 때 키 '2'를 생략한다.
        var rawCount = row[COUNT_KEY];
        if (rawCount !== undefined && rawCount !== null && rawCount !== '') {
          var n = toInt(rawCount, NaN);
          if (isNaN(n) || n < 0) {
            errors.push('아이템 슬롯 ' + slotKey + ' 수량이 올바르지 않습니다.');
          } else if (n === 0) {
            warnings.push('아이템 슬롯 ' + slotKey + ' 수량이 0입니다.');
          }
        }
        var rawProto = row[PROTO_KEY];
        if (rawProto === undefined || rawProto === null || rawProto === '') {
          warnings.push('아이템 슬롯 ' + slotKey + ' 원형 번호가 생략되었습니다.');
        } else {
          var proto = toInt(rawProto, NaN);
          if (isNaN(proto) || proto < 0) {
            errors.push('아이템 슬롯 ' + slotKey + ' 원형 번호가 올바르지 않습니다.');
          }
        }
      }
      var declared = toInt(entity.itemStorage.count, NaN);
      if (!isNaN(declared) && maxSlot >= 0 && declared < maxSlot + 1) {
        warnings.push('가방 슬롯 용량(' + declared + ')이 최대 슬롯 번호(' + maxSlot + ')보다 작습니다.');
      }
    }

    var maxUidBig = collectMaxUidBig(session);
    var genBig = getExactUidBig(session, 'm_ItemIdGenerator', rootObj.m_ItemIdGenerator);
    var zeroBig = typeof BigInt === 'function' ? BigInt(0) : 0;
    if (genBig !== null && compareBig(genBig, maxUidBig) < 0) {
      warnings.push('아이템 번호 생성기(' + bigIntToUidValue(genBig) + ')가 최대 번호(' + bigIntToUidValue(maxUidBig) + ')보다 작습니다.');
    } else if (genBig === null && compareBig(maxUidBig, zeroBig) > 0) {
      warnings.push('아이템 번호 생성기(0)가 최대 번호(' + bigIntToUidValue(maxUidBig) + ')보다 작습니다.');
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
        if (k === 'posX' && session.player.savePosx !== undefined) {
          session.player.savePosx = f.toFixed(1);
        }
        if (k === 'posZ' && session.player.savePosz !== undefined) {
          session.player.savePosz = f.toFixed(1);
        }
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
    var base = readValueBase(target);
    base[String(idx)] = n;
    writeValueBase(target, base);
    session.dirty = true;
    syncDerived(session);
    return okMsg();
  }

  var UINT64_MAX_BIG = typeof BigInt === 'function' ? BigInt('18446744073709551615') : Number.MAX_SAFE_INTEGER;

  function nextItemUidBig(session) {
    var one = typeof BigInt === 'function' ? BigInt(1) : 1;
    var zero = typeof BigInt === 'function' ? BigInt(0) : 0;
    var gen = getExactUidBig(session, 'm_ItemIdGenerator', session.root.m_ItemIdGenerator);
    if (gen === null) { gen = zero; }
    var maxUid = collectMaxUidBig(session);
    var base = compareBig(gen, maxUid) >= 0 ? gen : maxUid;
    if (compareBig(base, UINT64_MAX_BIG) >= 0) {
      return null;
    }
    var nextBig = base + one;
    setUidAtPath(session, 'm_ItemIdGenerator', nextBig, session.root, 'm_ItemIdGenerator');
    return nextBig;
  }

  function nextItemUid(session) {
    var nb = nextItemUidBig(session);
    if (nb === null) {
      throw new Error('아이템 고유 번호 생성기가 UInt64 상한에 도달했습니다.');
    }
    return bigIntToUidValue(nb);
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
    var targetPath = entityBasePath(session, o.entityId);

    var uidBig = nextItemUidBig(session);
    if (uidBig === null) {
      return failMsg('아이템 고유 번호 생성기가 UInt64 상한(18446744073709551615)에 도달하여 아이템을 추가할 수 없습니다.');
    }
    var content = ensureItemContent(target);
    var slot = findFreeBagSlot(content);
    var row = {};
    var uidVal = setUidAtPath(session, itemUidPath(targetPath, slot), uidBig, row, UID_KEY);
    row[PROTO_KEY] = proto;
    if (qty > 1) { row[COUNT_KEY] = qty; }
    if (intensify > 0) { row[INTENSIFY_KEY] = intensify; }
    row[GRADE_KEY] = grade;
    row[LEVEL_KEY] = level;
    content[String(slot)] = row;

    session.dirty = true;
    syncDerived(session);
    return okMsg({ uid: uidVal, slot: slot });
  }

  var ITEM_PATCH_KEYS = {
    count: COUNT_KEY, nOverlap: COUNT_KEY,
    proto: PROTO_KEY, protoId: PROTO_KEY,
    weili: WEILI_KEY, sharp: SHARP_KEY, tenacity: TENACITY_KEY,
    intensify: INTENSIFY_KEY, durability: DURABILITY_KEY,
    grade: GRADE_KEY, quality: GRADE_KEY, level: LEVEL_KEY
  };

  function findItemEntry(session, idOrSlot, opts) {
    var o = isObj(opts) ? opts : {};
    var candidates = [];
    if (o.entityId !== undefined && o.entityId !== null && o.entityId !== '') {
      var target = getEntity(session, o.entityId);
      if (target) {
        candidates.push({ entity: target, basePath: entityBasePath(session, o.entityId) });
      }
    } else {
      candidates = listEntitiesWithPaths(session);
    }

    var slotOpt = (o.slot !== undefined && o.slot !== null && o.slot !== '') ? String(o.slot) : null;
    if (slotOpt !== null) {
      for (var s = 0; s < candidates.length; s++) {
        var sc = readItemContent(candidates[s].entity);
        if (sc && isObj(sc[slotOpt])) {
          return { entity: candidates[s].entity, entityPath: candidates[s].basePath, content: sc, slotKey: slotOpt, row: sc[slotOpt] };
        }
      }
    }

    var key = String(idOrSlot);
    for (var i = 0; i < candidates.length; i++) {
      var content = readItemContent(candidates[i].entity);
      if (!content) { continue; }
      var ckeys = Object.keys(content);
      for (var j = 0; j < ckeys.length; j++) {
        var r = content[ckeys[j]];
        if (isObj(r) && r[UID_KEY] !== undefined && r[UID_KEY] !== null) {
          var exactUid = getExactUidStr(session, itemUidPath(candidates[i].basePath, ckeys[j]), r[UID_KEY]);
          if (exactUid === key) {
            return { entity: candidates[i].entity, entityPath: candidates[i].basePath, content: content, slotKey: ckeys[j], row: r };
          }
        }
      }
      if (isObj(content[key])) {
        return { entity: candidates[i].entity, entityPath: candidates[i].basePath, content: content, slotKey: key, row: content[key] };
      }
    }
    return null;
  }

  function updateItem(session, uid, patch, opts) {
    if (!session || !session.root) { return failMsg('세션이 없습니다.'); }
    if (!isObj(patch)) { return failMsg('변경할 값을 지정하세요.'); }
    var key = String(uid);
    var found = findItemEntry(session, key, opts);
    if (!found) { return failMsg('아이템을 찾지 못했습니다: ' + key); }
    var row = found.row;

    var keys = Object.keys(patch);
    for (var k = 0; k < keys.length; k++) {
      var field = keys[k];
      var slot = ITEM_PATCH_KEYS[field] || (/^\d+$/.test(field) ? field : null);
      if (!slot) { return failMsg('알 수 없는 아이템 항목입니다: ' + field); }
      if (slot === UID_KEY) { return failMsg('고유 번호는 변경할 수 없습니다.'); }
      var n = toInt(patch[field], null);
      if (n === null) { return failMsg(field + ' 값은 정수여야 합니다.'); }
      if (slot === COUNT_KEY && n < 1) { return failMsg('수량은 1 이상이어야 합니다.'); }
      if (slot === COUNT_KEY && n === 1) {
        delete row[COUNT_KEY];
      } else if (slot === INTENSIFY_KEY && n === 0) {
        delete row[INTENSIFY_KEY];
      } else {
        row[slot] = n;
      }
    }
    session.dirty = true;
    syncDerived(session);
    return okMsg({ slot: found.slotKey });
  }

  function removeItem(session, uid, opts) {
    if (!session || !session.root) { return failMsg('세션이 없습니다.'); }
    var key = String(uid);
    var found = findItemEntry(session, key, opts);
    if (!found) { return failMsg('아이템을 찾지 못했습니다: ' + key); }
    delete found.content[found.slotKey];
    if (found.entityPath && session.doc) {
      var slotPrefix = found.entityPath + '\x1fitemStorage\x1fcontent\x1f' + found.slotKey + '\x1f';
      if (session.doc.rawBigInts instanceof Map) {
        session.doc.rawBigInts.delete(slotPrefix + UID_KEY);
      }
      if (session.doc.floatPaths instanceof Set) {
        var toDrop = [];
        session.doc.floatPaths.forEach(function (fp) {
          if (fp.indexOf(slotPrefix) === 0) { toDrop.push(fp); }
        });
        for (var di = 0; di < toDrop.length; di++) {
          session.doc.floatPaths.delete(toDrop[di]);
        }
      }
    }
    session.dirty = true;
    syncDerived(session);
    return okMsg({ slot: found.slotKey });
  }

  function toggleIdInList(session, fieldName, id, add) {
    if (!session || !session.root) { return failMsg('세션이 없습니다.'); }
    var schema = FIELD_SCHEMAS[fieldName];
    if (!schema) {
      return failMsg('알 수 없는 목록 항목입니다: ' + fieldName);
    }
    var n = toInt(id, null);
    if (n === null) { return failMsg('번호는 정수여야 합니다.'); }
    var player = session.player;
    var currentIds = getFieldIds(session, fieldName);
    var hasIt = currentIds.indexOf(n) !== -1;
    var want = typeof add === 'boolean' ? add : !hasIt;

    if (schema.type === 'dict_list') {
      var dl = decodeDictList(player[fieldName]);
      if (want) {
        if (!hasIt) {
          var bk = spellBucketKey(n);
          if (!dl[bk]) { dl[bk] = []; }
          dl[bk].push(n);
        }
      } else {
        var dlKeys = Object.keys(dl);
        for (var i = 0; i < dlKeys.length; i++) {
          var dk = dlKeys[i];
          var filtered = [];
          for (var j = 0; j < dl[dk].length; j++) {
            if (dl[dk][j] !== n) { filtered.push(dl[dk][j]); }
          }
          if (filtered.length > 0) { dl[dk] = filtered; }
          else { delete dl[dk]; }
        }
      }
      player[fieldName] = encodeField(dl);
    } else if (schema.type === 'dict_val') {
      var dv = decodeDictVal(player[fieldName], fieldName);
      var slotKey = fieldName === 'qgactive' ? qinggongGroupKey(n) : stuntSlotKey(n);
      if (want) {
        dv[slotKey] = n;
      } else {
        var dvKeys = Object.keys(dv);
        for (var v = 0; v < dvKeys.length; v++) {
          if (dv[dvKeys[v]] === n) { delete dv[dvKeys[v]]; }
        }
      }
      player[fieldName] = encodeField(dv);
    } else {
      var list = decodeListField(player[fieldName]);
      var pos = list.indexOf(n);
      if (want && pos === -1) { list.push(n); }
      else if (!want && pos !== -1) { list.splice(pos, 1); }
      player[fieldName] = encodeField(list);
    }
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

  function flatten(node, prefix, out, rawBigInts, rawPath) {
    if (isObj(node)) {
      var keys = Object.keys(node);
      if (keys.length === 0 && prefix) { out[prefix] = {}; return; }
      for (var i = 0; i < keys.length; i++) {
        var k = keys[i];
        var v = node[k];
        var nextPrefix = prefix ? (prefix + '/' + k) : k;
        var nextRaw = rawPath ? (rawPath + '\x1f' + k) : k;
        if (typeof v === 'string' && (k === 'm_valueBase' || hasOwn(FIELD_SCHEMAS, k))) {
          var decoded = decodeField(v);
          if (decoded && typeof decoded === 'object') {
            flatten(decoded, nextPrefix, out, null, '');
            continue;
          }
        }
        flatten(v, nextPrefix, out, rawBigInts, nextRaw);
      }
      return;
    }
    if (isArr(node)) {
      if (node.length === 0 && prefix) { out[prefix] = []; return; }
      for (var j = 0; j < node.length; j++) {
        var arrRaw = rawPath ? (rawPath + '\x1f' + j) : String(j);
        flatten(node[j], prefix + '/' + j, out, rawBigInts, arrRaw);
      }
      return;
    }
    if (prefix) {
      if (typeof node === 'number' && rawBigInts instanceof Map && rawPath && rawBigInts.has(rawPath)) {
        out[prefix] = rawBigInts.get(rawPath);
      } else {
        out[prefix] = node;
      }
    }
  }

  function computeDiff(session) {
    if (!session || !session.originalRoot) { return []; }
    var before = {}, after = {};
    flatten(session.originalRoot, '', before, session.originalRawBigInts || null, '');
    flatten(session.root, '', after, session.doc && session.doc.rawBigInts ? session.doc.rawBigInts : null, '');
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

  function summarizeErrors(errors) {
    if (!isArr(errors) || !errors.length) { return ''; }
    if (errors.length <= 5) { return errors.join(' / '); }
    return errors.slice(0, 5).join(' / ') + ' 외 ' + (errors.length - 5) + '건';
  }

  function exportSave(session, opts) {
    if (!session || !session.root) { throw new Error('세션이 없습니다.'); }
    normalizeWritePropertyJsonRoot(session.root);
    syncDerived(session);
    var o = isObj(opts) ? opts : {};
    if (o.validate !== false) {
      var report = validate(session);
      if (!report.ok) {
        var err = new Error('세이브 검증 실패: ' + summarizeErrors(report.errors));
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
    var playerContent = readItemContent(player);
    var playerCount = playerContent ? Object.keys(playerContent).length : 0;
    var totalCount = 0;
    var entities = listEntities(session);
    for (var i = 0; i < entities.length; i++) {
      var content = readItemContent(entities[i]);
      if (content) { totalCount += Object.keys(content).length; }
    }
    var vbase = readValueBase(player);
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
      itemCount: playerCount,
      totalItemCount: totalCount,
      itemIdGenerator: rootObj.m_ItemIdGenerator !== undefined ? rootObj.m_ItemIdGenerator : 0,
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
    session.originalRawBigInts = (session.doc && session.doc.rawBigInts instanceof Map)
      ? new Map(session.doc.rawBigInts) : new Map();
    session.needsRepair = false;
    session.dirty = false;
    return okMsg();
  }

  return {
    VERSION: '1.0.3',
    ATTR_COUNT: ATTR_COUNT,
    INT_MIN: INT_MIN,
    INT32_MIN: INT32_MIN,
    INT_MAX: INT_MAX,
    SUB_SLOT_BAG_BEGIN: SUB_SLOT_BAG_BEGIN,
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
    FIELD_SCHEMAS: FIELD_SCHEMAS,
    PRESETS: PRESETS,
    createSession: createSession,
    syncDerived: syncDerived,
    validate: validate,
    setSummary: setSummary,
    setAttribute: setAttribute,
    getAttributes: getAttributes,
    getFieldIds: getFieldIds,
    normalizeWritePropertyJsonRoot: normalizeWritePropertyJsonRoot,
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
