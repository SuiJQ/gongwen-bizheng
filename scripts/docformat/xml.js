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

/** 取段落属性块（w:pPr）的完整 XML；没有则返回空串 */
function getPPr(pXml) {
  const open = pXml.indexOf('<w:pPr');
  if (open < 0) return '';
  // 自闭合
  const afterOpen = pXml.indexOf('>', open);
  if (pXml[afterOpen - 1] === '/') return pXml.slice(open, afterOpen + 1);
  const close = pXml.indexOf('</w:pPr>', open);
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

/** 用新的 pPr 替换段落原有 pPr（无则插入到段落开头标签之后） */
function replacePPr(pXml, newPPr) {
  const old = getPPr(pXml);
  if (old) {
    const idx = pXml.indexOf(old);
    return pXml.slice(0, idx) + newPPr + pXml.slice(idx + old.length);
  }
  const openMatch = /^<w:p(?:\s[^>]*)?>/.exec(pXml);
  if (!openMatch) return pXml;
  return openMatch[0] + newPPr + pXml.slice(openMatch[0].length);
}

/** 取段落的 open 标签（<w:p ...>） */
function paragraphOpenTag(pXml) {
  const m = /^<w:p(?:\s[^>]*)?>/.exec(pXml);
  return m ? m[0] : '<w:p>';
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

module.exports = {
  XML_DECL,
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
  paragraphOpenTag,
  getJc,
  getFirstLineIndent,
  getLineSpacing,
  getFirstRunFont,
  getFirstRunSize,
};
