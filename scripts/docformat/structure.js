#!/usr/bin/env node
/**
 * 结构处理：结构空行、标题拆分、媒体段保护。
 *
 * 结构空行是公文版式的固定要求：标题与主送之间、落款之前各留一个空行。
 * 只在缺失时补，已存在则不重复插入。
 */
'use strict';

const {
  scanParagraphs, paragraphText, getJc, hasMedia, replacePPr,
} = require('./xml');
const { detectType, refineTypes } = require('./detect');
const { buildPPr } = require('./ppr');

function detectAll(paras, preset) {
  const texts = paras.map((p) => paragraphText(p.xml).trim());
  let first = texts.findIndex((t) => t.length > 0);
  if (first < 0) first = 0;
  const types = [];
  paras.forEach((para, i) => {
    types.push(detectType({
      text: texts[i],
      index: i,
      total: paras.length,
      align: getJc(para.xml),
      hasMedia: hasMedia(para.xml),
      firstNameIndex: first,
    }));
  });
  return { texts, types: refineTypes(types, texts) };
}

/** 生成一个公文行距的空段落 */
function blankParagraph(preset) {
  const pPr = buildPPr({
    sizeHalfPt: (preset.types.body && preset.types.body.sizeHalfPt) || 32,
    align: 'both',
  }, preset.emptyLineSpacing || preset.lineSpacing);
  return '<w:p>' + pPr + '</w:p>';
}

/**
 * 补齐结构空行。
 * @param {DocxPackage} pkg
 * @param {object} preset
 * @param {object} opts { afterTitle, beforeSignature }
 */
function applyStructuralBlanks(pkg, preset, opts) {
  const o = Object.assign(
    { afterTitle: true, beforeSignature: true },
    preset.structuralBlank || {},
    opts || {}
  );
  const mainName = pkg.mainDocumentName;
  const doc = pkg.getText(mainName);
  const scan = scanParagraphs(doc);
  const bodyParas = scan.paragraphs.filter((p) => !p.inTable);
  const { types } = detectAll(bodyParas, preset);

  const inserts = [];
  const blank = blankParagraph(preset);

  const titleIdx = types.indexOf('title');
  if (o.afterTitle && titleIdx >= 0) {
    const next = types[titleIdx + 1];
    if (next && next !== 'blank') {
      inserts.push({ at: bodyParas[titleIdx].end, xml: blank });
    }
  }

  if (o.beforeSignature) {
    const sigIdx = types.findIndex((t) => t === 'signature');
    if (sigIdx > 0) {
      const prev = types[sigIdx - 1];
      const prevBlank = prev === 'blank';
      if (!prevBlank) {
        inserts.push({ at: bodyParas[sigIdx].start, xml: blank });
      }
    }
  }

  if (!inserts.length) return { inserted: 0 };

  inserts.sort((a, b) => b.at - a.at);
  let out = doc;
  for (const ins of inserts) {
    out = out.slice(0, ins.at) + ins.xml + out.slice(ins.at);
  }
  pkg.setText(mainName, out);
  return { inserted: inserts.length };
}

/**
 * 标题拆分（保守实现）：把"一、xxxx。后续正文"拆成标题段 + 正文段。
 * 默认不启用；仅当段落同时满足"标题样式前缀 + 正文句号 + 长度超阈值"才拆。
 */
function splitHeadings(pkg, preset, opts) {
  const o = Object.assign({ minLength: 60 }, opts || {});
  const mainName = pkg.mainDocumentName;
  const doc = pkg.getText(mainName);
  const scan = scanParagraphs(doc);
  const bodyParas = scan.paragraphs.filter((p) => !p.inTable);
  const { texts, types } = detectAll(bodyParas, preset);

  const ops = [];
  bodyParas.forEach((para, i) => {
    const type = types[i];
    if (!/^heading[1-4]$/.test(type)) return;
    const text = texts[i];
    if (text.length < o.minLength) return;
    const cut = text.search(/[。；]/);
    if (cut <= 0 || cut >= text.length - 2) return;
    const head = text.slice(0, cut + 1);
    const tail = text.slice(cut + 1).trim();
    if (tail.length < 10) return;
    ops.push({ para, head, tail, type });
  });
  if (!ops.length) return { split: 0 };

  let out = doc;
  ops.sort((a, b) => b.para.start - a.para.start);
  for (const op of ops) {
    const fmt = preset.types[op.type];
    const headP = '<w:p>' + buildPPr(fmt, preset.lineSpacing, { keepNext: true }) + runOf(op.head, fmt) + '</w:p>';
    const bodyP = '<w:p>' + buildPPr(preset.types.body, preset.lineSpacing) + runOf(op.tail, preset.types.body) + '</w:p>';
    out = out.slice(0, op.para.start) + headP + bodyP + out.slice(op.para.end);
  }
  pkg.setText(mainName, out);
  return { split: ops.length };
}

function runOf(text, fmt) {
  return '<w:r><w:rPr><w:rFonts w:ascii="' + (fmt.fontEn || 'Times New Roman') +
    '" w:hAnsi="' + (fmt.fontEn || 'Times New Roman') + '" w:eastAsia="' + (fmt.fontCn || '仿宋_GB2312') +
    '"/><w:sz w:val="' + (fmt.sizeHalfPt || 32) + '"/></w:rPr><w:t xml:space="preserve">' +
    text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;') + '</w:t></w:r>';
}

/** 媒体段保护：含图片的段落改为单倍行距，避免图片被固定行距裁切 */
function protectMediaParagraphs(pkg, preset) {
  const mainName = pkg.mainDocumentName;
  const doc = pkg.getText(mainName);
  const scan = scanParagraphs(doc);
  const targets = scan.paragraphs.filter((p) => hasMedia(p.xml));
  if (!targets.length) return { protected: 0 };

  let out = doc;
  targets.sort((a, b) => b.start - a.start);
  for (const para of targets) {
    const pPr = buildPPr({
      sizeHalfPt: (preset.types.body && preset.types.body.sizeHalfPt) || 32,
      align: 'center',
    }, { value: 240, rule: 'auto' });
    const replaced = replacePPr(para.xml, pPr);
    out = out.slice(0, para.start) + replaced + out.slice(para.end);
  }
  pkg.setText(mainName, out);
  return { protected: targets.length };
}

module.exports = { applyStructuralBlanks, splitHeadings, protectMediaParagraphs, detectAll, blankParagraph };
