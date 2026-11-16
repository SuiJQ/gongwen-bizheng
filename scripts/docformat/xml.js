#!/usr/bin/env node
/**
 * OOXML 片段级工具：不构建完整 DOM，只按需定位与替换目标节点。
 *
 * 这样做的原因：完整 DOM 解析再序列化会改写整份 XML 的命名空间声明、属性顺序
 * 与空白，容易触发 Word 的"需要修复"提示；而按片段替换可保证未触及的字节原样保留。
 */
'use strict';

const XML_DECL = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';

function escapeText(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function escapeAttr(value) {
  return escapeText(value).replace(/"/g, '&quot;');
}

function unescapeXml(value) {
  return String(value)
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (m, d) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-fA-F]+);/g, (m, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&amp;/g, '&');
}

const TAG_RE = /<(\/?)([A-Za-z0-9_:.-]+)((?:"[^"]*"|'[^']*'|[^>"'])*?)(\/?)>/g;

/**
 * 扫描 document.xml，返回段落与 sectPr 的位置信息。
 * 段落记录 inTable 标志，用于区分正文段与表格内段落。
 */
function scanParagraphs(xml) {
  const result = [];
  const stack = [];
  let paraStart = -1;
  let paraInTable = false;
  let current = null;
  let sectPr = null;
  TAG_RE.lastIndex = 0;
  let match = TAG_RE.exec(xml);
  while (match) {
    const closing = match[1] === '/';
    const name = match[2];
    const selfClosing = match[4] === '/';

    if (!closing && name === 'w:tbl' && !selfClosing) {
      stack.push('w:tbl');
    } else if (closing && name === 'w:tbl') {
      stack.pop();
    }

    if (!closing && name === 'w:p') {
      if (selfClosing) {
        result.push({
          start: match.index, end: match.index + match[0].length,
          inTable: stack.includes('w:tbl'), selfClosing: true, xml: match[0],
        });
      } else {
        paraStart = match.index;
        paraInTable = stack.includes('w:tbl');
        current = { openEnd: match.index + match[0].length };
      }
    } else if (closing && name === 'w:p' && paraStart >= 0) {
      result.push({
        start: paraStart, end: match.index + match[0].length,
        inTable: paraInTable, selfClosing: false,
        openEnd: current.openEnd,
        xml: xml.slice(paraStart, match.index + match[0].length),
      });
      paraStart = -1;
      current = null;
    } else if (name === 'w:sectPr' && !closing) {
      sectPr = { start: match.index, selfClosing };
      if (!selfClosing) {
        // 找到对应的 </w:sectPr>
        const close = xml.indexOf('</w:sectPr>', match.index);
        if (close >= 0) {
          sectPr.end = close + '</w:sectPr>'.length;
          sectPr.xml = xml.slice(match.index, sectPr.end);
        }
      } else {
        sectPr.end = match.index + match[0].length;
        sectPr.xml = match[0];
      }
    }
    match = TAG_RE.exec(xml);
  }
  return { paragraphs: result, sectPr };
}

/** 提取段落内所有 w:t 文本；tab 转空格，br 转空。 */
function paragraphText(pXml) {
  let out = '';
  const re = /<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>|<w:tab\/>|<w:br\/>|<w:cr\/>/g;
  let m = re.exec(pXml);
  while (m) {
    if (m[1] !== undefined) out += unescapeXml(m[1]);
    else if (m[0].startsWith('<w:tab')) out += '\t';
    else out += '\n';
    m = re.exec(pXml);
  }
  return out;
}

/** 段落是否含图片/媒体 */
function hasMedia(pXml) {
  return /<w:drawing\b|<w:pict\b|<w:object\b|<v:imagedata\b/.test(pXml);
}

/** 段落是否含分页符 */
function hasPageBreak(pXml) {
  return /<w:br[^>]*w:type="page"/.test(pXml);
}

/** 引号感知地找标签结束的 '>'：属性值里含 '>' 时不会提前截断 */
function findTagEnd(xml, start) {
  let quote = null;
  for (let i = start; i < xml.length; i += 1) {
    const c = xml[i];
    if (quote) {
      if (c === quote) quote = null;
    } else if (c === '"' || c === "'") {
      quote = c;
    } else if (c === '>') {
      return i;
    }
  }
  return -1;
}

/** 取段落属性块（w:pPr）的完整 XML；没有则返回空串 */
function getPPr(pXml) {
  const open = pXml.indexOf('<w:pPr');
  if (open < 0) return '';
  const end = findTagEnd(pXml, open);
  if (end < 0) return '';
  // 自闭合
  if (pXml[end - 1] === '/') return pXml.slice(open, end + 1);
  const close = pXml.indexOf('</w:pPr>', end);
  if (close < 0) return '';
  return pXml.slice(open, close + '</w:pPr>'.length);
}

/** 取段落自身的对齐值（w:jc），无则 null */
function getJc(pXml) {
  const pPr = getPPr(pXml);
  const m = /<w:jc[^>]*w:val="([^"]+)"/.exec(pPr);
  return m ? m[1] : null;
}

/** 取段落首行缩进（twips 字符串），无则 null */
function getFirstLineIndent(pXml) {
  const pPr = getPPr(pXml);
  const m = /<w:ind\b[^>]*w:firstLine="(\d+)"/.exec(pPr);
  if (m) return Number(m[1]);
  const chars = /<w:ind\b[^>]*w:firstLineChars="(\d+)"/.exec(pPr);
  return chars ? Number(chars[1]) : null;
}

/** 取段落行距（w:line） */
function getLineSpacing(pXml) {
  const pPr = getPPr(pXml);
  const m = /<w:spacing\b[^>]*w:line="(\d+)"/.exec(pPr);
  return m ? Number(m[1]) : null;
}

/** 取段落中第一个 run 的字体名（w:eastAsia 优先） */
function getFirstRunFont(pXml) {
  const m = /<w:rPr\b[\s\S]*?<\/w:rPr>/.exec(pXml);
  if (!m) return null;
  const ea = /<w:rFonts[^>]*w:eastAsia="([^"]*)"/.exec(m[0]);
  if (ea && ea[1]) return ea[1];
  const ascii = /<w:rFonts[^>]*w:ascii="([^"]*)"/.exec(m[0]);
  return ascii ? ascii[1] : null;
}

/** 取段落中第一个 run 的字号（半磅值） */
function getFirstRunSize(pXml) {
  const m = /<w:rPr\b[\s\S]*?<\/w:rPr>/.exec(pXml);
  if (!m) return null;
  const sz = /<w:sz[^>]*w:val="(\d+)"/.exec(m[0]);
  return sz ? Number(sz[1]) : null;
}

/**
 * 合并 pPr：以新的版式属性为主，保留旧 pPr 中**结构性子元素**。
 *
 * 必须保留：pStyle（样式引用）、framePr（文本框定位）、numPr（自动编号）、
 * tabs（制表位）、sectPr（段落级分节符）。
 * 丢掉 numPr 会让自动编号消失——那是改了内容外观，违反「只改版式」；
 * 丢掉段落级 sectPr 会让多节文档塌成一节、页码全部失效。
 */
const PPR_PROTECTED = ['w:pStyle', 'w:framePr', 'w:numPr', 'w:tabs', 'w:sectPr'];

/**
 * CT_PPrBase 的 schema 序号（wordprocessingml.xsd 的 xs:sequence 顺序）。
 * 插入位置一律按本表定位，不得用"锚点元素列表"近似——v0.6.0 曾用锚点表，
 * 导致 numPr/tabs 落到 autoSpaceDE/DN 之后，违反 schema，Word 会提示"需要修复"。
 */
const PPR_SEQ = [
  'w:pStyle', 'w:keepNext', 'w:keepLines', 'w:pageBreakBefore', 'w:framePr',
  'w:widowControl', 'w:numPr', 'w:pBdr', 'w:shd', 'w:tabs',
  'w:suppressAutoHyphens', 'w:kinsoku', 'w:wordWrap', 'w:overflowPunct',
  'w:topLinePunct', 'w:autoSpaceDE', 'w:autoSpaceDN', 'w:bidi',
  'w:adjustRightInd', 'w:snapToGrid', 'w:spacing', 'w:ind', 'w:contextualSpacing',
  'w:mirrorIndents', 'w:suppressOverlap', 'w:jc', 'w:textDirection',
  'w:textAlignment', 'w:textboxTightWrap', 'w:outlineLvl', 'w:divId',
  'w:cnfStyle', 'w:rPr', 'w:sectPr', 'w:pPrChange',
];

/** 取 pPr 文本中某个子元素（入参是 pPr，不是整段） */
function pPrChildOf(pPrText, name) {
  const re = new RegExp('<' + name + '\\b[^>]*/>|<' + name + '\\b[^>]*>[\\s\\S]*?</' + name + '>');
  const m = re.exec(pPrText || '');
  return m ? m[0] : '';
}

/** 列出 pPr 里已出现的直接子元素名（按 schema 表过滤，避免误匹配嵌套子孙） */
function pPrChildNames(pPr) {
  const found = [];
  PPR_SEQ.forEach((n) => {
    if (new RegExp('<' + n + '[\\s/>]').test(pPr)) found.push(n);
  });
  return found;
}

/** 按 schema 顺序把子元素插进 pPr：插到第一个"位次更大"的已有子元素之前 */
function insertPPrChild(pPr, name, child) {
  const seqIdx = PPR_SEQ.indexOf(name);
  if (seqIdx < 0) return pPr.replace('</w:pPr>', child + '</w:pPr>');
  const present = pPrChildNames(pPr);
  for (const n of present) {
    if (PPR_SEQ.indexOf(n) > seqIdx) {
      const i = pPr.indexOf('<' + n);
      if (i >= 0) return pPr.slice(0, i) + child + pPr.slice(i);
    }
  }
  return pPr.replace('</w:pPr>', child + '</w:pPr>');
}

function mergePPr(oldPPr, newPPr) {
  if (!oldPPr) return newPPr;
  let merged = newPPr;
  PPR_PROTECTED.forEach((name) => {
    const child = pPrChildOf(oldPPr, name);
    if (!child) return;
    if (pPrChildOf(merged, name)) return;
    merged = insertPPrChild(merged, name, child);
  });
  return merged;
}

/** 用新的 pPr 替换段落原有 pPr（保留结构性兄弟元素；无 pPr 则插入到段落开头标签之后） */
function replacePPr(pXml, newPPr) {
  const old = getPPr(pXml);
  const merged = mergePPr(old, newPPr);
  if (old) {
    const idx = pXml.indexOf(old);
    return pXml.slice(0, idx) + merged + pXml.slice(idx + old.length);
  }
  const openMatch = /^<w:p(?:\s[^>]*)?>/.exec(pXml);
  if (!openMatch) return pXml;
  return openMatch[0] + merged + pXml.slice(openMatch[0].length);
}

/** 取段落的 open 标签（<w:p ...>），引号感知 */
function paragraphOpenTag(pXml) {
  const end = findTagEnd(pXml, 0);
  if (end < 0 || pXml.indexOf('<w:p') !== 0) return '<w:p>';
  return pXml.slice(0, end + 1);
}

/** 取段落 pPr 中某个子元素 XML */
function getPPrChild(pXml, childName) {
  const pPr = getPPr(pXml);
  if (!pPr) return '';
  const re = new RegExp('<' + childName + '\\b[^>]*/>|<' + childName + '\\b[^>]*>[\\s\\S]*?</' + childName + '>');
  const m = re.exec(pPr);
  return m ? m[0] : '';
}

/** 从 pPr 中移除指定子元素 */
function removePPrChild(pPrXml, childName) {
  const re = new RegExp('<' + childName + '\\b[^>]*/>|<' + childName + '\\b[^>]*>[\\s\\S]*?</' + childName + '>', 'g');
  return pPrXml.replace(re, '');
}

/** 生成带属性的空元素，如 el('w:ind', {'w:firstLine': '640'}) */
function el(name, attrs) {
  const parts = Object.keys(attrs || {}).map((k) => ' ' + k + '="' + escapeAttr(attrs[k]) + '"');
  return '<' + name + parts.join('') + '/>';
}

/** 取 <tag>…</tag> 或 <tag/> 的文本内容（不含标签自身）；无此标签返回 null */
function readTag(xml, tag) {
  const re = new RegExp('<' + tag + '(?:\\s[^>]*)?>([\\s\\S]*?)</' + tag + '>|<' + tag + '(?:\\s[^>]*)?/>');
  const m = re.exec(xml || '');
  if (!m) return null;
  return m[1] === undefined ? '' : unescapeXml(m[1]);
}

module.exports = {
  XML_DECL,
  readTag,
  escapeText,
  escapeAttr,
  unescapeXml,
  el,
  scanParagraphs,
  paragraphText,
  hasMedia,
  hasPageBreak,
  getPPr,
  getPPrChild,
  removePPrChild,
  replacePPr,
  mergePPr,
  findTagEnd,
  PPR_SEQ,
  pPrChildNames,
  paragraphOpenTag,
  getJc,
  getFirstLineIndent,
  getLineSpacing,
  getFirstRunFont,
  getFirstRunSize,
};
