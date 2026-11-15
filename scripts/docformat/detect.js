#!/usr/bin/env node
/**
 * 段落类型识别（判定链）。
 *
 * 按 GB/T 9704-2012 的要素结构与公文行文通例独立实现，不沿用第三方判定表。
 * 判定顺序：确定性强的先判（文号/附件/抄送/日期），语义依赖位置的后判（标题/落款）。
 */
'use strict';

const CN_NUM = '一二三四五六七八九十百零〇两';
const DATE_RE = new RegExp(
  '^\\s*(?:[' + CN_NUM + '\\d]{2,4})\\s*年\\s*(?:[' + CN_NUM + '\\d]{1,2})\\s*月' +
  '\\s*(?:[' + CN_NUM + '\\d]{1,2})\\s*日\\s*$'
);
const DOC_NUMBER_RE = /^\s*[\u4e00-\u9fa5]{2,12}\s*〔\s*\d{4}\s*〕\s*\d+\s*号\s*$/;
const ATTACH_NOTE_RE = /^\s*附\s*件\s*[：:]|^\s*附\s*件\s*\d+\s*$/;
const ATTACH_TITLE_RE = /^\s*附\s*件\s*\d*\s*$/;
const CC_RE = /^\s*抄\s*送\s*[：:]/;
const CLOSING_RE = new RegExp(
  '^(特此(通知|报告|批复|函告|公告|通报|说明|请示|函)|此复|专此(函达|报告)|' +
  '以上(意见|报告|请示|通知|办法)(，|,)?\\s*(请|如|妥|是否)?.*|请(予|予以)?(批复|审示|审阅|批示))'
);
const HEADING1_RE = new RegExp('^\\s*[' + CN_NUM + ']+\\s*、');
const HEADING2_RE = new RegExp('^\\s*[（(]\\s*[' + CN_NUM + ']+\\s*[)）]');
const HEADING3_RE = /^\s*\d{1,2}\s*[.．、]/;
const HEADING4_RE = /^\s*[（(]\s*\d{1,2}\s*[)）]/;
const TITLE_RE = /^.{2,60}(通知|决定|意见|报告|请示|批复|函|通报|纪要|方案|办法|规定|细则|公告|通告|决议|议案|命令|公报)$/;

/** 是否以冒号结尾（全角/半角） */
function endsWithColon(text) {
  return /[：:]\s*$/.test(text);
}

/** 是否含句末标点 */
function hasSentenceEnd(text) {
  return /[。！？；]$/.test(text);
}

/**
 * @param {object} ctx
 *   text       段落纯文本（已 trim）
 *   rawText    未 trim 文本（判断前导空格）
 *   index      在正文段落序列中的序号（不含表内段落）
 *   total      正文段落总数
 *   align      段落对齐值（left/center/right/both/null）
 *   hasMedia   是否含图片/媒体
 *   hasPageBreak 是否含分页符
 *   firstNameIndex 第一个非空段落序号
 *   prevType   上一段类型
 * @returns {string} title|docNumber|recipient|heading1..4|body|closing|signature|date|attachment|attachmentTitle|cc|sourceNote|media|blank|unknown
 */
function detectType(ctx) {
  const text = (ctx.text || '').trim();
  const index = ctx.index;
  const total = ctx.total;
  const align = ctx.align || null;
  const tailZone = index >= total - 4;
  const tail2 = index >= total - 3;

  if (!text) {
    return ctx.hasMedia ? 'media' : 'blank';
  }
  if (ctx.hasMedia && text.length === 0) return 'media';

  // 1. 发文字号
  if (DOC_NUMBER_RE.test(text)) return 'docNumber';

  // 2. 附件（说明 vs 单独标题）
  if (ATTACH_TITLE_RE.test(text) && text.length <= 12) return 'attachmentTitle';
  if (ATTACH_NOTE_RE.test(text)) return 'attachment';

  // 3. 抄送
  if (CC_RE.test(text)) return 'cc';

  // 4. 成文日期：形态严格匹配，且需右对齐或位于文末区佐证
  if (DATE_RE.test(text) && (align === 'right' || tail2)) return 'date';

  // 5. 主送机关：以冒号收尾的短行，且不是"如下："这类引导语
  if (endsWithColon(text) && text.length <= 60 && !/如下\s*[：:]$/.test(text) && !hasSentenceEnd(text)) {
    // 排除"（一）xx："这种层次标题带冒号的写法
    if (!HEADING1_RE.test(text) && !HEADING2_RE.test(text) && !HEADING3_RE.test(text)) {
      return 'recipient';
    }
  }

  // 6. 结语
  if (CLOSING_RE.test(text)) return 'closing';

  // 7. 标题：首个非空段，或具备"关于…的X"完整结构
  if (index === ctx.firstNameIndex && text.length <= 80 && !hasSentenceEnd(text) && align !== 'right') {
    return 'title';
  }
  if (TITLE_RE.test(text) && text.length <= 60 && index <= Math.max(2, ctx.firstNameIndex + 1)) {
    return 'title';
  }

  // 8. 层次标题（先判更深的层级，避免"1."被误判为正文）
  if (HEADING4_RE.test(text)) return 'heading4';
  if (HEADING3_RE.test(text)) return 'heading3';
  if (HEADING2_RE.test(text)) return 'heading2';
  if (HEADING1_RE.test(text)) return 'heading1';

  // 9. 落款：文末区、右对齐、短语、无句末标点
  if (tailZone && align === 'right' && text.length <= 30 && !hasSentenceEnd(text) && !endsWithColon(text)) {
    return 'signature';
  }

  // 10. 来源标注（——摘自…／资料来源：…）
  if (/^[—\-－]{1,2}\s*(摘自|引自|来源)/.test(text) || /^(资料来源|数据来源)\s*[：:]/.test(text)) {
    return 'sourceNote';
  }

  return 'body';
}

/** 类型是否属于"标题类"（用于结构空行与诊断） */
function isHeading(type) {
  return /^heading[1-4]$/.test(type) || type === 'title';
}

/**
 * 类型序列后处理。
 *
 * 公文落款常不设右对齐（手写或转换文档尤甚），单看对齐会漏判。
 * 规则：紧邻成文日期之前、短语、无句末标点的那一段，判定为落款。
 * 有"下一段是日期"作为强证据，误判风险低。
 */
function refineTypes(types, texts) {
  const out = types.slice();
  for (let i = 0; i < out.length - 1; i += 1) {
    if (out[i] !== 'body' || out[i + 1] !== 'date') continue;
    const text = (texts[i] || '').trim();
    if (!text || text.length > 22) continue;
    if (/[。！？；：:，,、]$/.test(text)) continue;
    out[i] = 'signature';
  }
  return out;
}

module.exports = {
  detectType,
  refineTypes,
  isHeading,
  DATE_RE,
  DOC_NUMBER_RE,
  ATTACH_NOTE_RE,
  CLOSING_RE,
  HEADING1_RE,
  HEADING2_RE,
  HEADING3_RE,
  HEADING4_RE,
};
