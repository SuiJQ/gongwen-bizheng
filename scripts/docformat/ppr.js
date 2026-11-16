#!/usr/bin/env node
/**
 * 段落与文字属性装配：把预设参数翻译成 OOXML 属性块。
 *
 * 统一约定：
 * - 字号单位半磅（w:sz），1 个中文字符宽度 = 字号(磅) × 20 twips。
 * - 缩进同时写 ...Chars（字符数，Word 优先采用）与对应的绝对 twips（兼容性回退）。
 */
'use strict';

const { escapeAttr, el } = require('./xml');

const ALIGN_MAP = {
  left: 'left',
  right: 'right',
  center: 'center',
  both: 'both',
  justify: 'both',
  distribute: 'distribute',
};

/** 字符数 -> twips；sizeHalfPt 为该段字号 */
function charsToTwips(chars, sizeHalfPt) {
  return Math.round((chars / 100) * (sizeHalfPt / 2) * 20);
}

function buildRPr(fmt, opts) {
  const o = opts || {};
  const size = fmt.sizeHalfPt || 32;
  const parts = [];
  parts.push(el('w:rFonts', {
    'w:ascii': fmt.fontEn || 'Times New Roman',
    'w:hAnsi': fmt.fontEn || 'Times New Roman',
    'w:eastAsia': fmt.fontCn || '仿宋_GB2312',
    'w:cs': fmt.fontEn || 'Times New Roman',
  }));
  if (o.bold) parts.push('<w:b/><w:bCs/>');
  else parts.push(el('w:b', { 'w:val': '0' }) + el('w:bCs', { 'w:val': '0' }));
  if (o.italic === false) parts.push(el('w:i', { 'w:val': '0' }) + el('w:iCs', { 'w:val': '0' }));
  // 强制黑色、无下划线、无底纹，避免继承浮动格式
  parts.push(el('w:color', { 'w:val': '000000' }));
  parts.push(el('w:sz', { 'w:val': String(size) }) + el('w:szCs', { 'w:val': String(size) }));
  parts.push(el('w:u', { 'w:val': 'none' }));
  return '<w:rPr>' + parts.join('') + '</w:rPr>';
}

/**
 * 生成段落属性块。
 * @param {object} fmt      类型格式（preset.types[x]）
 * @param {object} lineSpacing {value, rule}
 * @param {object} opts     { keepNext, pageBreakBefore, outlineLevel }
 */
function buildPPr(fmt, lineSpacing, opts) {
  const o = opts || {};
  const size = fmt.sizeHalfPt || 32;
  const parts = [];

  if (o.pageBreakBefore) parts.push('<w:pageBreakBefore/>');
  if (o.keepNext || fmt.keepNext) parts.push('<w:keepNext/>');
  parts.push('<w:widowControl/>');
  // 关闭自动调整中英文/数字间距继承，避免行宽漂移
  parts.push('<w:autoSpaceDE w:val="1"/><w:autoSpaceDN w:val="1"/>');

  const spacingAttrs = {};
  if (lineSpacing) {
    spacingAttrs['w:line'] = String(lineSpacing.value);
    spacingAttrs['w:lineRule'] = lineSpacing.rule || 'exact';
  }
  if (fmt.spaceBefore) spacingAttrs['w:before'] = String(fmt.spaceBefore);
  if (fmt.spaceAfter) spacingAttrs['w:after'] = String(fmt.spaceAfter);
  if (Object.keys(spacingAttrs).length) parts.push(el('w:spacing', spacingAttrs));

  const indAttrs = {};
  if (fmt.firstLineChars) {
    indAttrs['w:firstLineChars'] = String(fmt.firstLineChars);
    indAttrs['w:firstLine'] = String(charsToTwips(fmt.firstLineChars, size));
  }
  if (fmt.hangingChars) {
    indAttrs['w:hangingChars'] = String(fmt.hangingChars);
    indAttrs['w:hanging'] = String(charsToTwips(fmt.hangingChars, size));
  }
  if (fmt.leftChars) {
    indAttrs['w:leftChars'] = String(fmt.leftChars);
    indAttrs['w:left'] = String(charsToTwips(fmt.leftChars, size));
  } else if (!fmt.firstLineChars && !fmt.hangingChars) {
    // 显式清零，覆盖继承的首行缩进
    indAttrs['w:firstLineChars'] = '0';
    indAttrs['w:firstLine'] = '0';
  }
  if (fmt.rightChars) {
    indAttrs['w:rightChars'] = String(fmt.rightChars);
    indAttrs['w:right'] = String(charsToTwips(fmt.rightChars, size));
  } else {
    indAttrs['w:rightChars'] = '0';
    indAttrs['w:right'] = '0';
  }
  parts.push(el('w:ind', indAttrs));

  const jc = ALIGN_MAP[fmt.align || 'both'] || 'both';
  parts.push(el('w:jc', { 'w:val': jc }));
  if (o.outlineLevel !== undefined && o.outlineLevel !== null) {
    parts.push(el('w:outlineLvl', { 'w:val': String(o.outlineLevel) }));
  }
  // 段落标记自身也套用字体，避免空段继承怪异字号
  parts.push(buildRPr(fmt, { bold: false }));

  return '<w:pPr>' + parts.join('') + '</w:pPr>';
}

/** 替换段落中每个 run 的 rPr（跳过含媒体的 run，以免影响图形） */
function applyRunFormat(pXml, fmt, opts) {
  const o = opts || {};
  const preserveMedia = o.preserveMedia !== false;
  return pXml.replace(/<w:r(?:\s[^>]*)?>([\s\S]*?)<\/w:r>/g, (whole, inner) => {
    if (preserveMedia && /<w:drawing\b|<w:pict\b|<w:object\b|<v:imagedata\b/.test(inner)) {
      return whole;
    }
    if (!/<w:t[\s>]/.test(inner)) return whole; // 无文字内容的 run（仅制表/换行）不动
    const newRPr = buildRPr(fmt, { bold: o.bold });
    const cleaned = inner.replace(/<w:rPr\b[^>]*\/>|<w:rPr\b[\s\S]*?<\/w:rPr>/, '');
    return '<w:r>' + newRPr + cleaned + '</w:r>';
  });
}

/**
 * 深度清洗：清除 run 上的颜色/下划线/斜体/底纹/高亮，段落上的底纹与边框。
 *
 * 不删 pStyle / numPr：pStyle 是样式引用、numPr 是自动编号，属**结构**而非"外观格式"。
 * v0.6.0 曾在此处删掉二者，导致 --deep-clean 路径下 mergePPr 无源可保、编号消失。
 */
function stripFormatting(pXml) {
  let out = pXml;
  out = out.replace(/<w:rPr\b[\s\S]*?<\/w:rPr>/g, (rPr) => {
    let r = rPr;
    r = r.replace(/<w:highlight[^>]*\/>/g, '');
    r = r.replace(/<w:shd\b[^>]*\/>/g, '');
    r = r.replace(/<w:em[^>]*\/>/g, '');
    r = r.replace(/<w:color[^>]*\/>/g, el('w:color', { 'w:val': '000000' }));
    r = r.replace(/<w:u[^>]*\/>/g, el('w:u', { 'w:val': 'none' }));
    r = r.replace(/<w:i\/>/g, el('w:i', { 'w:val': '0' }));
    r = r.replace(/<w:vertAlign[^>]*\/>/g, '');
    r = r.replace(/<w:spacing[^>]*\/>/g, ''); // 字符间距
    if (!/<w:sz[^>]*\/>/.test(r)) r = r.replace('</w:rPr>', el('w:sz', { 'w:val': '32' }) + '</w:rPr>');
    return r;
  });
  out = out.replace(/<w:pPr\b[\s\S]*?<\/w:pPr>/g, (pPr) => pPr
    .replace(/<w:shd\b[^>]*\/>/g, '')
    .replace(/<w:pBdr\b[\s\S]*?<\/w:pBdr>/g, '')
    .replace(/<w:snapToGrid[^>]*\/>/g, ''));
  return out;
}

/** 去掉段落内的前导空格 run 文本（主送机关顶格、避免首行飘移） */
function stripLeadingWhitespace(pXml) {
  let done = false;
  return pXml.replace(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g, (whole, inner) => {
    if (done) return whole;
    const text = inner.replace(/&amp;/g, '&');
    if (/^\s+$/.test(text)) return '';
    if (/^\s+/.test(text)) {
      done = true;
      return whole.replace(inner, inner.replace(/^\s+/, ''));
    }
    done = true;
    return whole;
  });
}

module.exports = { buildPPr, buildRPr, applyRunFormat, stripFormatting, stripLeadingWhitespace, charsToTwips, ALIGN_MAP };
