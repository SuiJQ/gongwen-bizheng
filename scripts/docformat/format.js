#!/usr/bin/env node
/**
 * 版式施加层：页面几何、段落格式化、页码。
 */
'use strict';

const {
  scanParagraphs, paragraphText, getJc, hasMedia,
  replacePPr, el, escapeAttr, XML_DECL,
} = require('./xml');
const { detectType, refineTypes } = require('./detect');
const { buildPPr, applyRunFormat, stripFormatting, stripLeadingWhitespace } = require('./ppr');

const CM_TO_TWIPS = 567; // 1 cm ≈ 566.93 twips
const W_NS = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const R_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';

const FOOTER_REL_TYPE = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/footer';
const FOOTER_CT = 'application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml';

function cm(value) {
  return Math.round(Number(value) * CM_TO_TWIPS);
}

/** 修改单个 sectPr 的页面几何 */
function patchSectPrGeometry(sectPrXml, page) {
  let out = sectPrXml;
  // 自闭合 <w:sectPr/> 先展开为成对标签，否则后续插入的 pgSz/pgMar 会落到 sectPr 外面
  out = out.replace(/<w:sectPr\b([^>]*?)\/>/, '<w:sectPr$1></w:sectPr>');
  const pgSz = el('w:pgSz', {
    'w:w': String(page.width),
    'w:h': String(page.height),
    'w:orient': page.orientation === 'landscape' ? 'landscape' : 'portrait',
  });
  const pgMar = el('w:pgMar', {
    'w:top': String(cm(page.top)),
    'w:right': String(cm(page.right)),
    'w:bottom': String(cm(page.bottom)),
    'w:left': String(cm(page.left)),
    'w:header': String(cm(page.header == null ? 1.5 : page.header)),
    'w:footer': String(cm(page.footer == null ? 2.8 : page.footer)),
    'w:gutter': String(cm(page.gutter || 0)),
  });

  if (/<w:pgSz\b[^>]*\/>/.test(out)) out = out.replace(/<w:pgSz\b[^>]*\/>/, pgSz);
  else out = out.replace(/(<w:sectPr\b[^>]*>)/, '$1' + pgSz);

  if (/<w:pgMar\b[^>]*\/>/.test(out)) out = out.replace(/<w:pgMar\b[^>]*\/>/, pgMar);
  else out = out.replace(pgSz, pgSz + pgMar);

  // 版心网格：公文按行排布，关闭网格吸附以免行距被 docGrid 改写
  if (/<w:docGrid\b[^>]*\/>/.test(out)) out = out.replace(/<w:docGrid\b[^>]*\/>/, '');
  return out;
}

/** 给 sectPr 插入/替换页脚引用 */
function patchSectPrFooters(sectPrXml, refs) {
  let out = sectPrXml.replace(/<w:footerReference\b[^>]*\/>/g, '');
  const tags = Object.keys(refs).map((type) => el('w:footerReference', {
    'w:type': type,
    'r:id': refs[type],
  })).join('');
  return out.replace(/(<w:sectPr\b[^>]*>)/, '$1' + tags);
}

/** 构造页脚 XML（仅页码段落） */
function buildFooterXml(pn, align) {
  const size = pn.sizeHalfPt || 28;
  const rPr = '<w:rPr>' + el('w:rFonts', {
    'w:ascii': pn.font || '宋体',
    'w:hAnsi': pn.font || '宋体',
    'w:eastAsia': pn.font || '宋体',
  }) + el('w:sz', { 'w:val': String(size) }) + el('w:szCs', { 'w:val': String(size) }) + '</w:rPr>';
  const runner = (inner) => '<w:r>' + rPr + inner + '</w:r>';
  const prefix = pn.style === 'dash' ? '— ' : '';
  const suffix = pn.style === 'dash' ? ' —' : '';

  const runs = [];
  if (prefix) runs.push(runner('<w:t xml:space="preserve">' + prefix + '</w:t>'));
  runs.push(runner('<w:fldChar w:fldCharType="begin"/>'));
  runs.push(runner('<w:instrText xml:space="preserve"> PAGE </w:instrText>'));
  runs.push(runner('<w:fldChar w:fldCharType="separate"/>'));
  runs.push(runner('<w:t>1</w:t>'));
  runs.push(runner('<w:fldChar w:fldCharType="end"/>'));
  if (suffix) runs.push(runner('<w:t xml:space="preserve">' + suffix + '</w:t>'));

  const pPr = '<w:pPr>' + el('w:spacing', { 'w:line': '240', 'w:lineRule': 'auto' }) +
    el('w:jc', { 'w:val': align }) + '<w:rPr>' + el('w:sz', { 'w:val': String(size) }) + '</w:rPr></w:pPr>';

  return XML_DECL + '<w:ftr xmlns:w="' + W_NS + '" xmlns:r="' + R_NS + '">' +
    '<w:p>' + pPr + runs.join('') + '</w:p></w:ftr>';
}

/**
 * 去掉页脚里的页码域段落（用于替换）。
 * 判据必须是「含 PAGE 域」而非「含 PAGE 字样」——后者会误删写明"PAGE 1 of 3"
 * 或正文含 PAGE 字样的页脚段落（v0.6.1 及以前的缺陷）。
 */
function stripPageNumberParagraphs(footerXml) {
  return footerXml.replace(/<w:p\b[\s\S]*?<\/w:p>/g, (p) => {
    const hasField = /<w:instrText[^>]*>\s*PAGE\b/.test(p) || /<w:fldSimple[^>]*w:instr="\s*PAGE\b/.test(p);
    return hasField ? '' : p;
  });
}

/**
 * 施加页面几何与页码。
 * @returns {{footerParts:string[], margins:object}}
 */
function applyPage(pkg, preset, options) {
  const opts = options || {};
  const mainName = pkg.mainDocumentName;
  let doc = pkg.getText(mainName);
  if (!doc) throw new Error('缺少正文部件：' + mainName);

  const page = preset.page;
  const pn = preset.pageNumber || { enabled: false };

  // ---- 页码：准备页脚部件 ----
  const footerRefs = {};
  const createdFooters = [];
  if (pn.enabled) {
    const needEven = pn.position === 'outside';
    const alignOdd = pn.position === 'outside' ? 'right' : (pn.position === 'left' ? 'left' : 'center');
    const alignEven = 'left';

    const existing = pkg.getRels(mainName).filter((r) => r.Type === FOOTER_REL_TYPE);

    const ensureFooter = (index, align) => {
      // 复用已有页脚时，若要求保护其它页脚内容则追加，否则重建
      const reuse = existing[index] && pn.protectOtherFooterContent;
      let partName;
      let xml;
      if (reuse) {
        partName = 'word/' + existing[index].Target.replace(/^\/?word\//, '').replace(/^\//, '');
        xml = pkg.getText(partName) || '';
        if (pn.replaceExisting) xml = stripPageNumberParagraphs(xml);
        const pnXml = buildFooterXml(pn, align);
        const inner = /<w:ftr\b[^>]*>([\s\S]*)<\/w:ftr>/.exec(pnXml);
        const add = inner ? inner[1] : '';
        xml = xml.replace('</w:ftr>', add + '</w:ftr>');
      } else {
        partName = 'word/footer' + (index === 0 ? '' : 'Even') + '.xml';
        xml = buildFooterXml(pn, align);
      }
      pkg.setText(partName, xml);
      pkg.ensureContentTypeOverride(partName, FOOTER_CT);
      createdFooters.push(partName);
      return pkg.ensureRel(mainName, FOOTER_REL_TYPE, partName.replace(/^word\//, ''));
    };

    footerRefs.default = ensureFooter(0, alignOdd);
    if (needEven) footerRefs.even = ensureFooter(1, alignEven);

    if (needEven) {
      const settingsName = 'word/settings.xml';
      let settings = pkg.getText(settingsName);
      if (settings) {
        if (!/evenAndOddHeaders/.test(settings)) {
          settings = settings.replace(/<w:settings\b([^>]*)>/, '<w:settings$1><w:evenAndOddHeaders/>');
          pkg.setText(settingsName, settings);
        }
      } else {
        pkg.setText(settingsName, XML_DECL + '<w:settings xmlns:w="' + W_NS + '"><w:evenAndOddHeaders/></w:settings>');
        pkg.ensureContentTypeOverride(settingsName,
          'application/vnd.openxmlformats-officedocument.wordprocessingml.settings+xml');
      }
    }
  }

  // ---- 修改所有 sectPr ----
  // 页码引用必须挂到**每一个** sectPr 上：只挂首个会导致第 2 节起无页码
  // （v0.6.1 及以前用 footerPatched 标志只打第一处，多节文档后续页面丢页码）。
  doc = doc.replace(/<w:sectPr\b[^>]*\/>|<w:sectPr\b[^>]*>[\s\S]*?<\/w:sectPr>/g, (sect) => {
    let out = patchSectPrGeometry(sect, page);
    if (pn.enabled) out = patchSectPrFooters(out, footerRefs);
    return out;
  });
  pkg.setText(mainName, doc);

  return { footerParts: createdFooters, margins: page };
}

/** 文档级样式清理：移除自动间距与默认段落格式覆盖 */
function stripStyleAutospacing(stylesXml) {
  return stylesXml
    .replace(/<w:autoSpaceDE\b[^>]*\/>/g, '')
    .replace(/<w:autoSpaceDN\b[^>]*\/>/g, '');
}

/**
 * 段落格式化：识别类型 -> 套用预设。
 * @returns {{stats:object, types:string[]}}
 */
function formatParagraphs(pkg, preset, options) {
  const opts = options || {};
  const mainName = pkg.mainDocumentName;
  const doc = pkg.getText(mainName);
  const scan = scanParagraphs(doc);

  // 只处理正文级段落（表格内段落另行处理）
  const bodyParas = scan.paragraphs.filter((p) => !p.inTable);

  const texts = bodyParas.map((p) => paragraphText(p.xml).trim());
  let firstNonEmpty = texts.findIndex((t) => t.length > 0);
  if (firstNonEmpty < 0) firstNonEmpty = 0;

  const types = [];
  const replacements = [];
  const stats = {};

  // 第一遍：识别类型（依赖前一段结果，故按顺序推进）
  bodyParas.forEach((para, i) => {
    types.push(detectType({
      text: texts[i],
      index: i,
      total: bodyParas.length,
      align: getJc(para.xml),
      hasMedia: hasMedia(para.xml),
      firstNameIndex: firstNonEmpty,
    }));
  });
  const refined = refineTypes(types, texts);
  types.length = 0;
  refined.forEach((t) => types.push(t));

  // 第二遍：套用格式
  bodyParas.forEach((para, i) => {
    const type = refined[i];
    stats[type] = (stats[type] || 0) + 1;

    let xml = para.xml;
    const fmt = preset.types[type] || preset.types.unknown;

    if (opts.deepClean) xml = stripFormatting(xml);

    // 主送机关、落款、日期不允许前导空格（顶格或右对齐）
    if (type === 'recipient' || type === 'signature' || type === 'date' || type === 'attachment') {
      xml = stripLeadingWhitespace(xml);
    }

    if (type === 'blank') {
      xml = replacePPr(xml, buildPPr({
        sizeHalfPt: (preset.types.body && preset.types.body.sizeHalfPt) || 32,
        align: 'both',
      }, preset.emptyLineSpacing || preset.lineSpacing));
    } else {
      const lineSpacing = type === 'media' ? { value: 240, rule: 'auto' }
        : (hasMedia(xml) ? { value: 240, rule: 'auto' } : preset.lineSpacing);
      const outline = /^heading([1-4])$/.exec(type);
      xml = replacePPr(xml, buildPPr(fmt, lineSpacing, {
        outlineLevel: outline ? Number(outline[1]) - 1 : (type === 'title' ? 0 : undefined),
        keepNext: isHeadingType(type),
        pageBreakBefore: type === 'attachmentTitle' && i > 0,
      }));
      xml = applyRunFormat(xml, fmt, { bold: fmt.bold });
    }

    if (xml !== para.xml) replacements.push({ start: para.start, end: para.end, xml });
  });

  if (opts.stripStyles) {
    const stylesName = 'word/styles.xml';
    const styles = pkg.getText(stylesName);
    if (styles) pkg.setText(stylesName, stripStyleAutospacing(styles));
  }

  // 单次遍历拼装：逐次 slice 重拼是 O(n²)，大文件会到分钟级
  replacements.sort((a, b) => a.start - b.start);
  const chunks = [];
  let cursor = 0;
  for (const r of replacements) {
    chunks.push(doc.slice(cursor, r.start), r.xml);
    cursor = r.end;
  }
  chunks.push(doc.slice(cursor));
  pkg.setText(mainName, chunks.join(''));

  // 表格内段落：只统一字体字号，不改对齐与缩进（单元格排版自成体系）
  const tableFixed = formatTableCells(pkg, preset, opts);

  return { stats, types, paragraphs: bodyParas.length, tableCells: tableFixed };
}

function isHeadingType(type) {
  return /^heading[1-4]$/.test(type) || type === 'title';
}

/**
 * 表格单元格段落：统一为正文的字体字号，但保留原有对齐与缩进。
 * 表格里的文字同样是公文正文的一部分，字体不一致会被一眼看出。
 */
function formatTableCells(pkg, preset, opts) {
  const mainName = pkg.mainDocumentName;
  const doc = pkg.getText(mainName);
  const scan = scanParagraphs(doc);
  const cells = scan.paragraphs.filter((p) => p.inTable);
  if (!cells.length) return 0;

  const body = preset.types.body;
  let count = 0;
  const patches = [];
  for (const cell of cells) {
    const text = paragraphText(cell.xml).trim();
    if (!text) continue;
    let xml0 = cell.xml;
    if (opts.deepClean) xml0 = stripFormatting(xml0);
    // 仅替换 run 字体，不动 pPr 的缩进与对齐
    const withFont = applyRunFormat(xml0, {
      sizeHalfPt: body.sizeHalfPt,
      fontCn: body.fontCn,
      fontEn: body.fontEn,
    }, { bold: false, preserveMedia: true });
    if (withFont !== cell.xml) {
      patches.push({ start: cell.start, end: cell.end, xml: withFont });
      count += 1;
    }
  }
  if (count) {
    patches.sort((a, b) => a.start - b.start);
    const chunks = [];
    let cursor = 0;
    for (const p of patches) {
      chunks.push(doc.slice(cursor, p.start), p.xml);
      cursor = p.end;
    }
    chunks.push(doc.slice(cursor));
    pkg.setText(mainName, chunks.join(''));
  }
  return count;
}

module.exports = {
  applyPage, formatParagraphs, isHeadingType,
  buildFooterXml, stripPageNumberParagraphs, patchSectPrGeometry, cm, CM_TO_TWIPS, FOOTER_CT,
};
