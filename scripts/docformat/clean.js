#!/usr/bin/env node
/**
 * 文字层规范：日期规范化、文档级残留格式清理。
 */
'use strict';

const { scanParagraphs, unescapeXml, escapeText } = require('./xml');

const FULLWIDTH_DIGITS = { '０': '0', '１': '1', '２': '2', '３': '3', '４': '4', '５': '5', '６': '6', '７': '7', '８': '8', '９': '9' };

function toHalfWidthDigits(text) {
  return text.replace(/[０-９]/g, (c) => FULLWIDTH_DIGITS[c] || c);
}

/**
 * 日期规范化：月、日不编虚位。
 * 2026年11月05日 -> 2026年11月5日；2026年01月 -> 2026年1月
 * 仅作用于含"年…月…日"结构的片段，不触碰其它数字。
 */
function normalizeDateText(text) {
  let out = text;
  const hasDate = /\d{4}\s*年\s*\d{1,2}\s*月/.test(toHalfWidthDigits(out));
  if (!hasDate) return out;
  out = toHalfWidthDigits(out);
  out = out.replace(/(\d{4})\s*年\s*0*(\d{1,2})\s*月\s*0*(\d{1,2})\s*日/g,
    (m, y, mo, d) => y + '年' + Number(mo) + '月' + Number(d) + '日');
  out = out.replace(/(\d{4})\s*年\s*0*(\d{1,2})\s*月(?!\s*\d)/g,
    (m, y, mo) => y + '年' + Number(mo) + '月');
  return out;
}

/** 对整个部件里的 w:t 文本做日期规范化 */
function normalizeDatesInXml(xml) {
  let count = 0;
  const out = xml.replace(/(<w:t(?:\s[^>]*)?>)([\s\S]*?)(<\/w:t>)/g, (whole, open, inner, close) => {
    const raw = unescapeXml(inner);
    const fixed = normalizeDateText(raw);
    if (fixed === raw) return whole;
    count += 1;
    return open + escapeText(fixed) + close;
  });
  return { xml: out, count };
}

function normalizeDates(pkg) {
  const mainName = pkg.mainDocumentName;
  const doc = pkg.getText(mainName);
  if (!doc) return { count: 0 };
  const { xml, count } = normalizeDatesInXml(doc);
  if (count) pkg.setText(mainName, xml);
  return { count };
}

/** 文档级清理：样式表里的自动间距、兼容性段落属性 */
function cleanStyles(pkg) {
  const name = 'word/styles.xml';
  const text = pkg.getText(name);
  if (!text) return { changed: false };
  const out = text
    .replace(/<w:autoSpaceDE\b[^>]*\/>/g, '')
    .replace(/<w:autoSpaceDN\b[^>]*\/>/g, '')
    .replace(/<w:adjustRightInd\b[^>]*\/>/g, '');
  if (out === text) return { changed: false };
  pkg.setText(name, out);
  return { changed: true };
}

/** 统计正文段落与字符数（供 app.xml 写作统计使用） */
function documentStats(pkg) {
  const doc = pkg.getText(pkg.mainDocumentName) || '';
  const scan = scanParagraphs(doc);
  const texts = scan.paragraphs.map((p) => {
    let out = '';
    const re = /<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g;
    let m = re.exec(p.xml);
    while (m) {
      out += unescapeXml(m[1]);
      m = re.exec(p.xml);
    }
    return out;
  });
  const chars = texts.join('').replace(/\s/g, '').length;
  return {
    paragraphs: texts.length,
    characters: chars,
    charactersWithSpaces: texts.join('').length,
    lines: Math.max(1, Math.ceil(chars / 28)),
  };
}

module.exports = { normalizeDateText, normalizeDatesInXml, normalizeDates, cleanStyles, documentStats, toHalfWidthDigits };
