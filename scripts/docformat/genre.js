#!/usr/bin/env node
/**
 * 文体规则（v0.8.1）——文本层与版式层共用的唯一一份。
 *
 * 动因：v0.6.3 引入的结构检查对**所有**文体套"通知形态"，实测 23 类受支持文体中
 * 13 类被误判阻断；`detect.js` 的结语正则与文本层各写一份，又导致"特此函达""以上请示，
 * 请批示"在两层得到相反结论。两份判据必然漂移，故收敛到这里，两边只读不写。
 *
 * 依据：`04-rules.md` 第五、六节（行文方向与主送）、`07-review.md` 第二十二行
 * （公布无主送）、`03-patterns.md` 第二、三部分（15 法定文种 + 8 类事务材料骨架）。
 */
'use strict';

/** 15 个法定文种 */
const LEGAL_TYPES = ['决议', '决定', '命令', '公报', '公告', '通告', '意见', '通知', '通报',
  '报告', '请示', '批复', '议案', '函', '纪要'];

/** 8 类高频事务材料：不套法定文种形态 */
const AFFAIR_TYPES = ['讲话', '总结', '述职', '方案', '调研报告', '经验材料', '汇报', '会议材料'];

/**
 * 事务材料识别：后缀锚定。
 * 锚定是必需的——否则"关于开展总结评比的通知"会被判成总结，
 * 而"…的调研报告"又会被法定文种"报告"截胡。判定顺序：事务材料先于法定文种。
 */
const AFFAIR_HINTS = [
  ['调研报告', /调研(报告|情况报告)?$/],
  ['述职', /述职(报告)?$/],
  ['总结', /(工作总结|小结|总结)$/],
  ['方案', /(实施方案|方案|规划|行动计划)$/],
  ['讲话', /(讲话|致辞|发言|演讲)$/],
  ['经验材料', /(经验材料|经验做法|经验交流材料)$/],
  ['汇报', /(汇报|情况汇报)$/],
  ['会议材料', /(议题说明|主持词|议程|会议材料|会议方案)$/],
];

/**
 * 各文种的要素要求。未列出的项按"要求"处理。
 *
 * - recipient：是否必须有主送机关。公布性文种（公告/通告/公报）、决议、命令、纪要为否。
 * - closing：是否必须有结语。通知/报告/请示/批复/函为是；决定、通报、意见、议案不设固定结语。
 * - date：是否必须有成文日期。纪要与事务材料为否（讲话稿、经验材料按体例无落款）。
 * - title：标题是否须含法定文种名。事务材料为否。
 * - titleWords：标题允许的文种词（命令类允许"令"）。
 */
const GENRE_RULES = {
  决议: { recipient: false, closing: false },
  决定: { recipient: true, closing: false },
  命令: { recipient: false, closing: false, titleWords: ['命令', '令'] },
  公报: { recipient: false, closing: false },
  公告: { recipient: false, closing: false },
  通告: { recipient: false, closing: false },
  意见: { recipient: true, closing: false },
  通知: { recipient: true, closing: true },
  通报: { recipient: true, closing: false },
  报告: { recipient: true, closing: true },
  请示: { recipient: true, closing: true },
  批复: { recipient: true, closing: true },
  议案: { recipient: true, closing: false },
  函: { recipient: true, closing: true },
  纪要: { recipient: false, closing: false, date: false },
};

/** 事务材料：只查空白/过短/序数/标点，不查公文五大要素 */
const AFFAIR_RULES = { recipient: false, closing: false, date: false, title: false };

/** 文体归一：接受"命令（令）""会议纪要""实施方案""讲话稿"等口语写法 */
function normalizeType(raw) {
  const t = String(raw || '').replace(/[（(].*?[)）]/g, '').replace(/\s/g, '').trim();
  if (!t) return '';
  const alias = {
    令: '命令', 会议纪要: '纪要', 实施方案: '方案', 规划: '方案', 行动计划: '方案',
    讲话稿: '讲话', 致辞: '讲话', 发言: '讲话', 演讲: '讲话',
    工作总结: '总结', 小结: '总结', 述职报告: '述职', 汇报材料: '汇报',
    调研: '调研报告', 经验: '经验材料', 经验做法: '经验材料',
    议题说明: '会议材料', 主持词: '会议材料', 议程: '会议材料',
  };
  return alias[t] || t;
}

/** 是否为受支持的文体名（归一后） */
function isSupportedType(name) {
  const t = normalizeType(name);
  return LEGAL_TYPES.indexOf(t) >= 0 || AFFAIR_TYPES.indexOf(t) >= 0;
}

/**
 * 按标题推断文体。可传字符串或前两段文本数组（主标题＋副标题）。
 * 返回 { type, genre }，genre ∈ legal|affairs|unknown。
 */
function inferGenre(headLines) {
  const heads = (Array.isArray(headLines) ? headLines : [headLines])
    .map((l) => (l || '').trim()).filter(Boolean).slice(0, 2);
  for (let i = 0; i < heads.length; i += 1) {
    const line = heads[i];
    for (let j = 0; j < AFFAIR_HINTS.length; j += 1) {
      if (AFFAIR_HINTS[j][1].test(line)) return { type: AFFAIR_HINTS[j][0], genre: 'affairs' };
    }
    if (/令$/.test(line)) return { type: '命令', genre: 'legal' };
    const hit = LEGAL_TYPES.filter((t) => line.endsWith(t))
      .sort((a, b) => b.length - a.length)[0];
    if (hit) return { type: hit, genre: 'legal' };
  }
  return { type: null, genre: 'unknown' };
}

/** 该文体的要素要求；未知文体返回 null（调用方按最严口径处理） */
function rulesFor(type, genre) {
  if (genre === 'affairs') return Object.assign({ title: false }, AFFAIR_RULES);
  if (type && GENRE_RULES[type]) return Object.assign({ title: true }, GENRE_RULES[type]);
  return null;
}

/** 解析调用方声明：返回 { type, genre, rules } */
function resolveGenre(declared, headLines) {
  if (declared) {
    const type = normalizeType(declared);
    const genre = AFFAIR_TYPES.indexOf(type) >= 0 ? 'affairs' : 'legal';
    return { type, genre, rules: rulesFor(type, genre) };
  }
  const inf = inferGenre(headLines);
  return { type: inf.type, genre: inf.genre, rules: rulesFor(inf.type, inf.genre) };
}

module.exports = {
  LEGAL_TYPES,
  AFFAIR_TYPES,
  AFFAIR_HINTS,
  GENRE_RULES,
  AFFAIR_RULES,
  normalizeType,
  isSupportedType,
  inferGenre,
  rulesFor,
  resolveGenre,
};