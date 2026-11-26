/* Next Jianghu II save codec — UMD */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.Nj2Codec = factory();
  }
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var MAX_VARINT_BYTES = 3;
  var MAX_STRING_BYTES = 0x1FFFFF;

  function isU8(v) {
    return v instanceof Uint8Array ||
      (typeof ArrayBuffer !== 'undefined' && v instanceof ArrayBuffer);
  }

  function toU8(input) {
    if (input instanceof Uint8Array) return input;
    if (typeof ArrayBuffer !== 'undefined' && input instanceof ArrayBuffer) return new Uint8Array(input);
    throw new Error('Nj2Codec: expected Uint8Array');
  }

  function utf8Decode(bytes) {
    if (typeof TextDecoder === 'function') {
      return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    }
    var out = '';
    var i = 0;
    while (i < bytes.length) {
      var b0 = bytes[i++];
      if (b0 < 0x80) {
        out += String.fromCharCode(b0);
      } else if (b0 < 0xE0) {
        var b1 = bytes[i++];
        out += String.fromCharCode(((b0 & 0x1F) << 6) | (b1 & 0x3F));
      } else if (b0 < 0xF0) {
        var b1b = bytes[i++], b2b = bytes[i++];
        out += String.fromCharCode(((b0 & 0x0F) << 12) | ((b1b & 0x3F) << 6) | (b2b & 0x3F));
      } else {
        var b1c = bytes[i++], b2c = bytes[i++], b3c = bytes[i++];
        var cp = ((b0 & 0x07) << 18) | ((b1c & 0x3F) << 12) | ((b2c & 0x3F) << 6) | (b3c & 0x3F);
        cp -= 0x10000;
        out += String.fromCharCode(0xD800 + (cp >> 10), 0xDC00 + (cp & 0x3FF));
      }
    }
    return out;
  }

  function utf8Encode(str) {
    if (typeof TextEncoder === 'function') {
      return new TextEncoder().encode(str);
    }
    var out = [];
    for (var i = 0; i < str.length; i++) {
      var c = str.charCodeAt(i);
      if (c < 0x80) out.push(c);
      else if (c < 0x800) {
        out.push(0xC0 | (c >> 6), 0x80 | (c & 0x3F));
      } else if (c < 0xD800 || c >= 0xE000) {
        out.push(0xE0 | (c >> 12), 0x80 | ((c >> 6) & 0x3F), 0x80 | (c & 0x3F));
      } else {
        var next = str.charCodeAt(++i);
        var cp = 0x10000 + (((c & 0x3FF) << 10) | (next & 0x3FF));
        out.push(
          0xF0 | (cp >> 18),
          0x80 | ((cp >> 12) & 0x3F),
          0x80 | ((cp >> 6) & 0x3F),
          0x80 | (cp & 0x3F)
        );
      }
    }
    return new Uint8Array(out);
  }

  function readVarint(bytes, ptr, limit) {
    var value = 0;
    var shift = 0;
    var count = 0;
    while (true) {
      if (ptr >= limit) throw new Error('Nj2Codec: truncated 7-bit length prefix');
      var b = bytes[ptr++];
      value |= (b & 0x7F) << shift;
      count++;
      if ((b & 0x80) === 0) break;
      shift += 7;
      if (count >= MAX_VARINT_BYTES || shift > 21) {
        throw new Error('Nj2Codec: 7-bit length prefix exceeds bounds');
      }
    }
    if (value < 0 || value > MAX_STRING_BYTES) {
      throw new Error('Nj2Codec: 7-bit length prefix out of range: ' + value);
    }
    return { value: value, ptr: ptr };
  }

  function writeVarint(value) {
    if (value < 0 || value > MAX_STRING_BYTES) {
      throw new Error('Nj2Codec: value out of range for 7-bit prefix: ' + value);
    }
    var out = [];
    var v = value >>> 0;
    while (v >= 0x80) {
      out.push((v & 0x7F) | 0x80);
      v >>>= 7;
    }
    out.push(v);
    return out;
  }

  var HEADER_FIELDS_10 = [
    'name', 'saveTime', 'gameTime', 'posX', 'posZ',
    'filename', 'saveFileVersion', 'gameDiff', 'modelId', 'maintaskName'
  ];
  var HEADER_FIELDS_11 = HEADER_FIELDS_10.concat(['gameType']);

  function parseCompanionHeader(bytes) {
    var b = toU8(bytes);
    var limit = b.length;
    var ptr = 0;
    var fields = [];

    for (var k = 0; k < HEADER_FIELDS_10.length; k++) {
      if (ptr >= limit) {
        throw new Error('Nj2Codec: truncated companion header at field ' + k);
      }
      var r = readVarint(b, ptr, limit);
      var len = r.value;
      ptr = r.ptr;
      if (ptr + len > limit) {
        throw new Error('Nj2Codec: truncated payload for field ' + k);
      }
      fields.push(utf8Decode(b.subarray(ptr, ptr + len)));
      ptr += len;
    }

    if (ptr < limit) {
      var r2 = readVarint(b, ptr, limit);
      var len2 = r2.value;
      ptr = r2.ptr;
      if (ptr + len2 > limit) throw new Error('Nj2Codec: truncated gameType field');
      fields.push(utf8Decode(b.subarray(ptr, ptr + len2)));
      ptr += len2;
    }

    if (ptr !== limit) throw new Error('Nj2Codec: trailing bytes after companion header');

    var fieldCount = fields.length;
    var map = fieldCount >= 11 ? HEADER_FIELDS_11 : HEADER_FIELDS_10;
    var out = { fieldCount: fieldCount };
    for (var i = 0; i < map.length; i++) {
      out[map[i]] = fields[i] !== undefined ? fields[i] : '';
    }
    return out;
  }

  function encodeCompanionHeader(meta) {
    if (!meta || typeof meta !== 'object') throw new Error('Nj2Codec: meta required');
    var ver = Number(meta.saveFileVersion);
    var useEleven = !(ver < 77 && meta.gameType === undefined);
    var fields = useEleven ? HEADER_FIELDS_11 : HEADER_FIELDS_10;
    var chunks = [];
    for (var i = 0; i < fields.length; i++) {
      var key = fields[i];
      var value = meta[key];
      if (value === undefined || value === null) value = '';
      var encoded = utf8Encode(String(value));
      var prefix = writeVarint(encoded.length);
      chunks.push(new Uint8Array(prefix));
      chunks.push(encoded);
    }
    var total = 0;
    for (var c = 0; c < chunks.length; c++) total += chunks[c].length;
    var out = new Uint8Array(total);
    var off = 0;
    for (var d = 0; d < chunks.length; d++) {
      out.set(chunks[d], off);
      off += chunks[d].length;
    }
    return out;
  }

  function stripBomString(text) {
    if (text.charCodeAt(0) === 0xFEFF) {
      return { text: text.slice(1), hasBom: true };
    }
    return { text: text, hasBom: false };
  }

  function parseSaveJson(input) {
    var text;
    var hasBom = false;
    if (typeof input === 'string') {
      var s = stripBomString(input);
      text = s.text;
      hasBom = s.hasBom;
    } else if (isU8(input)) {
      var bytes = toU8(input);
      if (bytes.length >= 3 && bytes[0] === 0xEF && bytes[1] === 0xBB && bytes[2] === 0xBF) {
        text = utf8Decode(bytes.subarray(3));
        hasBom = true;
      } else {
        text = utf8Decode(bytes);
      }
    } else {
      throw new Error('Nj2Codec: parseSaveJson requires string or Uint8Array');
    }

    var doc;
    try {
      doc = JSON.parse(text);
    } catch (err) {
      throw new Error('Nj2Codec: invalid JSON: ' + (err && err.message ? err.message : err));
    }

    if (!doc || typeof doc !== 'object' || Array.isArray(doc)) {
      throw new Error('Nj2Codec: save root must be an object');
    }
    if (!doc.playerentity || typeof doc.playerentity !== 'object') {
      throw new Error('Nj2Codec: save missing playerentity object');
    }

    var numMeta = scanJsonNumberMetadata(text);
    return {
      root: doc,
      rawText: text,
      hasBom: hasBom,
      prettyPrint: text.indexOf('\n') !== -1,
      floatPaths: numMeta.floatPaths,
      rawBigInts: numMeta.rawBigInts
    };
  }

  function _nj2PathJoin(parent, key) {
    var k = String(key);
    if (parent === '') return k;
    return parent + '\x1f' + k;
  }

  function _nj2ReadString(text, i, n) {
    i++;
    var out = '';
    var start = i;
    while (i < n) {
      var c = text.charCodeAt(i);
      if (c === 0x22) {
        out += text.slice(start, i);
        return { value: out, end: i + 1 };
      }
      if (c === 0x5c) {
        out += text.slice(start, i);
        i++;
        if (i >= n) break;
        var e = text.charAt(i);
        switch (e) {
          case '"': out += '"'; break;
          case '\\': out += '\\'; break;
          case '/': out += '/'; break;
          case 'b': out += '\b'; break;
          case 'f': out += '\f'; break;
          case 'n': out += '\n'; break;
          case 'r': out += '\r'; break;
          case 't': out += '\t'; break;
          case 'u':
            out += String.fromCharCode(parseInt(text.slice(i + 1, i + 5), 16) || 0);
            i += 4;
            break;
          default: out += e; break;
        }
        i++;
        start = i;
        continue;
      }
      i++;
    }
    out += text.slice(start, i);
    return { value: out, end: i };
  }

  function _nj2RecordNumber(raw, path, floatPaths, rawBigInts) {
    if (!raw) return;
    var c0 = raw.charCodeAt(0);
    if (c0 !== 0x2d && (c0 < 0x30 || c0 > 0x39)) return;
    var isFloat = false;
    var len = raw.length;
    for (var k = 0; k < len; k++) {
      var cc = raw.charCodeAt(k);
      if (cc === 0x2e || cc === 0x65 || cc === 0x45) {
        isFloat = true;
        break;
      }
    }
    if (isFloat) {
      floatPaths.add(path);
      return;
    }
    if (len >= 16) {
      var asNum = Number(raw);
      if (String(asNum) !== raw) {
        rawBigInts.set(path, raw);
      }
    }
  }

  function scanJsonNumberMetadata(text) {
    var floatPaths = new Set();
    var rawBigInts = new Map();
    if (typeof text !== 'string') return { floatPaths: floatPaths, rawBigInts: rawBigInts };

    var n = text.length;
    var i = 0;
    if (n > 0 && text.charCodeAt(0) === 0xFEFF) i = 1;
    var stack = [];

    function currentValuePath() {
      var top = stack.length ? stack[stack.length - 1] : null;
      if (!top) return '';
      if (top.isObj) return _nj2PathJoin(top.path, top.key);
      return _nj2PathJoin(top.path, top.idx);
    }

    function afterValue() {
      var top = stack.length ? stack[stack.length - 1] : null;
      if (!top) return;
      if (top.isObj) {
        top.awaiting = 'comma';
      } else {
        top.idx++;
        top.awaiting = 'comma';
      }
    }

    while (i < n) {
      var c = text.charCodeAt(i);
      if (c === 0x20 || c === 0x09 || c === 0x0A || c === 0x0D) { i++; continue; }
      var top = stack.length ? stack[stack.length - 1] : null;

      if (c === 0x7D) {
        if (top && top.isObj) stack.pop();
        i++;
        afterValue();
        continue;
      }
      if (c === 0x5D) {
        if (top && !top.isObj) stack.pop();
        i++;
        afterValue();
        continue;
      }
      if (c === 0x2C) {
        if (top) top.awaiting = top.isObj ? 'key' : 'value';
        i++;
        continue;
      }
      if (c === 0x3A) {
        if (top) top.awaiting = 'value';
        i++;
        continue;
      }
      if (top && top.isObj && top.awaiting === 'key') {
        if (c === 0x22) {
          var kr = _nj2ReadString(text, i, n);
          top.key = kr.value;
          top.awaiting = 'colon';
          i = kr.end;
          continue;
        }
        break;
      }
      if (c === 0x7B) {
        stack.push({ isObj: true, path: currentValuePath(), awaiting: 'key', key: null, idx: 0 });
        i++;
        continue;
      }
      if (c === 0x5B) {
        stack.push({ isObj: false, path: currentValuePath(), awaiting: 'value', key: null, idx: 0 });
        i++;
        continue;
      }
      if (c === 0x22) {
        var sr = _nj2ReadString(text, i, n);
        i = sr.end;
        afterValue();
        continue;
      }

      var j = i;
      while (j < n) {
        var cc = text.charCodeAt(j);
        if (cc === 0x2C || cc === 0x7D || cc === 0x5D ||
            cc === 0x20 || cc === 0x09 || cc === 0x0A || cc === 0x0D) break;
        j++;
      }
      if (j === i) { i++; continue; }
      var raw = text.slice(i, j);
      var rc0 = raw.charCodeAt(0);
      if (rc0 === 0x2d || (rc0 >= 0x30 && rc0 <= 0x39)) {
        _nj2RecordNumber(raw, currentValuePath(), floatPaths, rawBigInts);
      }
      i = j;
      afterValue();
    }

    return { floatPaths: floatPaths, rawBigInts: rawBigInts };
  }

  function isKnownDoubleField(path, key) {
    if (key === 'm_DaTiTime') {
      var dsegs = path.split('\x1f');
      if (dsegs.length === 3 && (dsegs[0] === 'Entitys' || dsegs[0] === 'playerentity') && dsegs[2] === 'm_DaTiTime') {
        return true;
      }
      return false;
    }
    if (key === '4') {
      var segs = path.split('\x1f');
      var L = segs.length;
      if (L >= 4 && segs[L - 4] === 'itemStorage' && segs[L - 3] === 'content' && segs[L - 1] === '4') {
        return true;
      }
    }
    return false;
  }

  function stringifyLitJson(root, meta) {
    meta = meta || {};
    var floatPaths = meta.floatPaths || new Set();
    var rawBigInts = meta.rawBigInts || new Map();
    var pretty = !!meta.pretty;
    var indent = (typeof meta.indent === 'string' && meta.indent.length)
      ? meta.indent : (pretty ? '  ' : '');
    var trailingNewline = !!meta.trailingNewline;
    var parts = [];

    function appendIndent(depth) {
      if (!pretty) return;
      for (var d = 0; d < depth; d++) parts.push(indent);
    }

    function writeValue(val, path, key, depth) {
      if (val === null || val === undefined) {
        parts.push('null');
        return;
      }
      var t = typeof val;
      if (t === 'string') {
        parts.push(JSON.stringify(val));
        return;
      }
      if (t === 'boolean') {
        parts.push(val ? 'true' : 'false');
        return;
      }
      if (t === 'number') {
        if (!isFinite(val)) {
          parts.push((floatPaths.has(path) || isKnownDoubleField(path, key)) ? '0.0' : '0');
          return;
        }
        if (rawBigInts.has(path)) {
          var raw = rawBigInts.get(path);
          if (Number(raw) === val) {
            parts.push(raw);
            return;
          }
        }
        var s = String(val);
        if ((floatPaths.has(path) || isKnownDoubleField(path, key)) &&
            s.indexOf('.') === -1 && s.indexOf('e') === -1 && s.indexOf('E') === -1) {
          parts.push(s + '.0');
          return;
        }
        parts.push(s);
        return;
      }
      if (t === 'bigint') {
        parts.push(val.toString());
        return;
      }
      if (Object.prototype.toString.call(val) === '[object Array]') {
        if (val.length === 0) { parts.push('[]'); return; }
        parts.push('[');
        var n = val.length;
        for (var a = 0; a < n; a++) {
          if (a > 0) parts.push(',');
          if (pretty) { parts.push('\n'); appendIndent(depth + 1); }
          var cval = val[a];
          if (cval === undefined) {
            parts.push('null');
          } else {
            writeValue(cval, _nj2PathJoin(path, a), String(a), depth + 1);
          }
        }
        if (pretty) { parts.push('\n'); appendIndent(depth); }
        parts.push(']');
        return;
      }
      var keys = Object.keys(val);
      var first = true;
      parts.push('{');
      for (var k = 0; k < keys.length; k++) {
        var kk = keys[k];
        var vv = val[kk];
        if (vv === undefined) continue;
        if (!first) parts.push(',');
        first = false;
        if (pretty) { parts.push('\n'); appendIndent(depth + 1); }
        parts.push(JSON.stringify(kk));
        parts.push(pretty ? ': ' : ':');
        writeValue(vv, _nj2PathJoin(path, kk), kk, depth + 1);
      }
      if (!first && pretty) { parts.push('\n'); appendIndent(depth); }
      parts.push('}');
    }

    writeValue(root, '', null, 0);
    var out = parts.join('');
    if (trailingNewline) out += '\n';
    return out;
  }

  function decodeJsonField(val) {
    if (val === null || val === undefined) return null;
    if (typeof val === 'string') {
      var s = val.trim();
      if (!s) return null;
      try {
        return JSON.parse(s);
      } catch (e) {
        return null;
      }
    }
    if (typeof val === 'object') return val;
    return null;
  }

  function encodeJsonField(val) {
    if (val === undefined) return 'null';
    return JSON.stringify(val);
  }

  function detectPrettyStyle(rawText) {
    if (!rawText) return { pretty: true, indent: '  ', trailingNewline: false };
    var trailingNewline = rawText.charAt(rawText.length - 1) === '\n';
    if (rawText.indexOf('\n') === -1) {
      return { pretty: false, indent: '', trailingNewline: false };
    }
    var indentMatch = rawText.match(/\r?\n([ \t]+)"/);
    if (indentMatch) {
      return { pretty: true, indent: indentMatch[1], trailingNewline: trailingNewline };
    }
    return { pretty: true, indent: '  ', trailingNewline: trailingNewline };
  }

  function serializeSaveJson(doc, opts) {
    opts = opts || {};
    var target = doc && doc.root ? doc.root : doc;
    if (!target || typeof target !== 'object') {
      throw new Error('Nj2Codec: serializeSaveJson requires object');
    }
    var style = opts.style || detectPrettyStyle(doc && doc.rawText);
    var pretty = opts.pretty !== undefined ? !!opts.pretty : style.pretty;
    var indent = opts.indent !== undefined ? opts.indent : style.indent;
    var trailingNewline = opts.trailingNewline !== undefined ? !!opts.trailingNewline : !!style.trailingNewline;
    var hasBom = opts.hasBom !== undefined ? !!opts.hasBom : !!(doc && doc.hasBom);
    var floatPaths = opts.floatPaths || (doc && doc.floatPaths) || new Set();
    var rawBigInts = opts.rawBigInts || (doc && doc.rawBigInts) || new Map();

    var text = stringifyLitJson(target, {
      floatPaths: floatPaths,
      rawBigInts: rawBigInts,
      pretty: pretty,
      indent: indent,
      trailingNewline: trailingNewline
    });

    if (hasBom) text = '\uFEFF' + text;
    if (opts.asString) return text;
    return utf8Encode(text);
  }

  function createDemoSave() {
    var saveJson = {
      playername: '양소',
      saveTime: '2026/11/17 17:30:00',
      gameTime: 3600.5,
      filename: 'savefile0',
      posX: 1118.25,
      posZ: 1490.5,
      gameVersion: 138,
      dbVersion: 138,
      m_GameDiff: 1,
      m_DLC_version: 1,
      m_playerRoleType: 1,
      m_playerTitleId: 1001,
      m_ItemIdGenerator: 900010,
      characterLine: 1,
      CurGameType: 0,
      xiaonejianghu: false,
      zhenshijianghu: false,
      m_CurrentDiffWin: false,
      playerentity: {
        '1': {
          guid: 1,
          type: 1,
          isActive: true,
          name: '양소',
          playerPrototypeGroupId: 10001,
          jingjieGangLevel: 3,
          m_GamePlayedSecond: 3600,
          m_GameTimeYear: 1,
          m_GameTimeMonth: 3,
          m_GameTimeDay: 15,
          m_TotalGetXiuWei: 25000,
          titleId: 1001,
          saveMapid: 1,
          savePosx: '1118.3',
          savePosy: '365.6',
          savePosz: '1490.5',
          m_valueBase: encodeJsonField({
            '0': 4500, '1': 3200, '2': 4500, '3': 3200, '4': 120, '5': 85,
            '6': 90, '7': 88, '8': 82, '9': 80, '10': 84, '11': 78, '12': 75,
            '20': 480, '21': 450, '22': 360, '23': 340, '34': 120, '35': 260,
            '36': 150, '37': 180, '66': 500, '67': 60, '68': 50000, '69': 18000,
            '70': 6000, '71': 50, '72': 15, '73': 95, '74': 120, '75': 110, '76': 25
          }),
          gongliRate: 100,
          itemStorage: {
            count: 120,
            content: {
              '12': { '0': 900001, '1': 1001, '2': 3, '9': 10, '10': 1 },
              '13': { '0': 900002, '1': 1002, '4': 1.0, '9': 11, '10': 1 },
              '14': { '0': 900003, '1': 1003, '2': 2, '9': 12, '10': 1 }
            }
          },
          m_learntSpell: encodeJsonField({ '0': [3, 4] }),
          curTaolu: 1,
          m_CurTaoLuZu: encodeJsonField({}),
          equipedSpellIdList: encodeJsonField({}),
          mijiIdList: encodeJsonField([10000]),
          m_StuntIds: encodeJsonField([3400, 3401]),
          m_EquipedStuntIds: encodeJsonField({ '34': 3400 }),
          talents: encodeJsonField([1, 2]),
          m_MenPaiTalentList: encodeJsonField([]),
          learnedpeifang: encodeJsonField([1001, 1002]),
          m0: encodeJsonField([10000, 10010]),
          m2: encodeJsonField({}),
          m3: encodeJsonField([]),
          m4: encodeJsonField({}),
          m5: encodeJsonField({}),
          m8: encodeJsonField([1]),
          m9: encodeJsonField([]),
          attriPointUseDict: encodeJsonField({}),
          j0: encodeJsonField([]),
          j1: encodeJsonField({}),
          j2: encodeJsonField([]),
          j3: encodeJsonField({}),
          j4: encodeJsonField({}),
          j5: encodeJsonField({}),
          j6: encodeJsonField([]),
          jingJieNodeBuff: encodeJsonField({}),
          qgactive: encodeJsonField({ '101': 1010 }),
          qgword: encodeJsonField({}),
          lzactive: encodeJsonField({}),
          lzequip: encodeJsonField({}),
          m_AchievementList: encodeJsonField([1, 2]),
          m_Team: {
            m_MainPlayers: [1],
            m_NormalPlayers: [],
            m_AllManualPlayerList: [1],
            m_FollowNpcs: []
          },
          m_DicQuest: { count: 0 },
          m_QuestFinish: { count: 0 },
          m_QuestFail: []
        }
      },
      Entitys: {
        '2': {
          guid: 2,
          type: 2,
          isActive: true,
          proBaseId: 2,
          titleId: 0,
          sectid: 2,
          m_DaTiTime: 0.0,
          m_valueBase: encodeJsonField({
            '0': 3800, '1': 2800, '4': 95, '5': 80,
            '20': 390, '21': 410, '22': 310, '23': 320, '68': 1200
          }),
          gongliRate: 100,
          itemStorage: {
            count: 48,
            content: {
              '0': { '0': 900004, '1': 1001, '9': 10, '10': 1 }
            }
          },
          m_learntSpell: encodeJsonField({ '0': [3] }),
          curTaolu: 1
        }
      },
      allentityids: encodeJsonField([1, 2]),
      npcGuidProidDic: encodeJsonField({ '2': 2 }),
      m_TeamInfo: {},
      m_PlayerMemeberScrInfos: {}
    };

    var headerBytes = encodeCompanionHeader({
      name: '양소',
      saveTime: '2026/11/17 17:30:00',
      gameTime: '3600.5',
      posX: '1118.25',
      posZ: '1490.5',
      filename: 'savefile0',
      saveFileVersion: '77',
      gameDiff: '1',
      modelId: '1',
      maintaskName: '',
      gameType: '0'
    });

    return { saveJson: saveJson, headerBytes: headerBytes };
  }

  return {
    parseCompanionHeader: parseCompanionHeader,
    encodeCompanionHeader: encodeCompanionHeader,
    parseSaveJson: parseSaveJson,
    serializeSaveJson: serializeSaveJson,
    scanJsonNumberMetadata: scanJsonNumberMetadata,
    stringifyLitJson: stringifyLitJson,
    decodeJsonField: decodeJsonField,
    encodeJsonField: encodeJsonField,
    createDemoSave: createDemoSave,
    utf8Encode: utf8Encode,
    utf8Decode: utf8Decode
  };
}));
