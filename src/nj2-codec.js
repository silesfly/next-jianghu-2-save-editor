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

    return {
      root: doc,
      rawText: text,
      hasBom: hasBom,
      prettyPrint: true
    };
  }

  function detectPrettyStyle(rawText) {
    if (!rawText) return { pretty: true, indent: '  ' };
    var tabMatch = rawText.match(/^\t+/m);
    var spaceMatch = rawText.match(/^ {2,}/m);
    if (tabMatch) return { pretty: true, indent: '\t' };
    if (spaceMatch) return { pretty: true, indent: spaceMatch[0].slice(0, 2) };
    return { pretty: true, indent: '  ' };
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
    var hasBom = opts.hasBom !== undefined ? !!opts.hasBom : !!(doc && doc.hasBom);

    var text = pretty
      ? JSON.stringify(target, null, indent)
      : JSON.stringify(target);

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
          m_valueBase: {
            '0': 4500, '1': 3200, '2': 4500, '3': 3200, '4': 120, '5': 85,
            '6': 90, '7': 88, '8': 82, '9': 80, '10': 84, '11': 78, '12': 75,
            '20': 480, '21': 450, '22': 360, '23': 340, '34': 120, '35': 260,
            '36': 150, '37': 180, '66': 500, '67': 60, '68': 50000, '69': 18000,
            '70': 6000, '71': 50, '72': 15, '73': 95, '74': 120, '75': 110, '76': 25
          },
          gongliRate: 100,
          itemStorage: {
            count: 120,
            content: {
              '12': { '0': 900001, '1': 1001, '2': 3, '9': 10, '10': 1 },
              '13': { '0': 900002, '1': 1002, '9': 11, '10': 1 },
              '14': { '0': 900003, '1': 1003, '2': 2, '9': 12, '10': 1 }
            }
          },
          m_learntSpell: [3, 4],
          curTaolu: 1,
          m_CurTaoLuZu: {},
          equipedSpellIdList: {},
          mijiIdList: [10000],
          m_StuntIds: [3400, 3401],
          m_EquipedStuntIds: [3400],
          talents: [1, 2],
          m_MenPaiTalentList: [],
          learnedpeifang: [1001, 1002],
          m2: {}, m3: [], m4: {}, m5: {},
          m8: [100, 101], m9: [], attriPointUseDict: {},
          j0: {}, j1: {}, j2: {}, j3: {}, j4: {}, j5: {}, j6: {},
          jingJieNodeBuff: {}, qgactive: [], qgword: {}, lzactive: [], lzequip: {},
          m_AchievementList: [1, 2],
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
          m_valueBase: {
            '0': 3800, '1': 2800, '4': 95, '5': 80,
            '20': 390, '21': 410, '22': 310, '23': 320, '68': 1200
          },
          gongliRate: 100,
          itemStorage: {
            count: 48,
            content: {
              '0': { '0': 900004, '1': 1001, '9': 10, '10': 1 }
            }
          },
          m_learntSpell: [3],
          curTaolu: 1
        }
      },
      allentityids: [1, 2],
      npcGuidProidDic: { '2': 2 },
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
    createDemoSave: createDemoSave,
    utf8Encode: utf8Encode,
    utf8Decode: utf8Decode
  };
}));
