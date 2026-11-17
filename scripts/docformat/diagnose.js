#!/usr/bin/env node
/**
 * 只读诊断：输出格式问题清单（JSON 或文本）。
 *
 * 判定原则：只报有把握的问题。主送机关顶格、落款与成文日期右对齐属于正确形态，
 * 不得判为"缺少首行缩进"；继承样式导致取不到显式属性时，报"未显式设置"而非"不合规"。
 */
'use strict';

const {
  scanParagraphs, paragraphText, getJc, getPPr, getFirstLineIndent,
  getLineSpacing, getFirstRunFont, getFirstRunSize, hasMedia, unescapeXml, readTag,
} = require('./xml');
const { detectType, refineTypes, placeholderType } = require('./detect');
const { resolveGenre } = require('./genre');
const { isGeneratorValue, isAppPlatformMismatch, CORE_PART, APP_PART } = require('./meta');

const CM_TOLERANCE = 0.2;



/** 取段落有效字体：优先首个 run 的显式设置，其次 pPr 内的 rPr */
function effectiveFormat(pXml) {
  const font = getFirstRunFont(pXml);
  const size = getFirstRunSize(pXml);
  if (font || size) return { font, size, source: 'run' };
  const pPr = getPPr(pXml);
  const rPr = /<w:rPr\b[\s\S]*?<\/w:rPr>/.exec(pPr);
  if (rPr) {
    const ea = /<w:rFonts[^>]*w:eastAsia="([^"]*)"/.exec(rPr[0]);
    const sz = /<w:sz[^>]*w:val="(\d+)"/.exec(rPr[0]);
    return { font: ea ? ea[1] : null, size: sz ? Number(sz[1]) : null, source: 'pPr' };
  }
  return { font: null, size: null, source: 'none' };
}

function twipsToCm(twips) {
  return Number(twips) / 567;
}

function diagnoseGeometry(pkg, preset, issues) {
  const doc = pkg.getText(pkg.mainDocumentName) || '';
  const sect = /<w:sectPr\b[^>]*>[\s\S]*?<\/w:sectPr>/.exec(doc);
  if (!sect) {
    issues.push({ code: 'SEC_MISSING', level: 'error', category: 'page', message: '缺少分节属性（sectPr），无法判定页面几何' });
    return null;
  }
  const mar = /<w:pgMar\b[^>]*\/>/.exec(sect[0]);
  if (!mar) {
    issues.push({ code: 'PGMAR_MISSING', level: 'error', category: 'page', message: '缺少页边距设置' });
    return null;
  }
  const attr = (name) => {
    const m = new RegExp('w:' + name + '="(-?\\d+)"').exec(mar[0]);
    return m ? Number(m[1]) : null;
  };
  const actual = {
    top: twipsToCm(attr('top')),
    bottom: twipsToCm(attr('bottom')),
    left: twipsToCm(attr('left')),
    right: twipsToCm(attr('right')),
  };
  const expect = preset.page;
  ['top', 'bottom', 'left', 'right'].forEach((side) => {
    const diff = Math.abs(actual[side] - expect[side]);
    if (diff > CM_TOLERANCE) {
      issues.push({
        code: 'PAGE_MARGIN',
        level: 'error',
        category: 'page',
        location: '页面设置',
        message: side + ' 边距 ' + actual[side].toFixed(2) + ' cm，应为 ' + expect[side] + ' cm',
        evidence: '实测 ' + actual[side].toFixed(2) + ' cm，GB/T 9704 要求 ' + expect[side] + ' cm',
      });
    }
  });
  return actual;
}

function diagnoseParagraphs(pkg, preset, issues) {
  const doc = pkg.getText(pkg.mainDocumentName) || '';
  const scan = scanParagraphs(doc);
  const body = scan.paragraphs.filter((p) => !p.inTable);
  const texts = body.map((p) => paragraphText(p.xml).trim());
  let first = texts.findIndex((t) => t.length > 0);
  if (first < 0) first = 0;

  const types = [];
  const rows = [];
  body.forEach((para, i) => {
    const type = detectType({
      text: texts[i],
      index: i,
      total: body.length,
      align: getJc(para.xml),
      hasMedia: hasMedia(para.xml),
      firstNameIndex: first,
    });
    types.push(type);
    const eff = effectiveFormat(para.xml);
    rows.push({
      index: i,
      text: texts[i],
      type,
      align: getJc(para.xml),
      firstLineIndent: getFirstLineIndent(para.xml),
      lineSpacing: getLineSpacing(para.xml),
      font: eff.font,
      size: eff.size,
      formatSource: eff.source,
      hasMedia: hasMedia(para.xml),
    });
  });

  const refined = refineTypes(types, texts);
  refined.forEach((t, k) => { types[k] = t; rows[k].type = t; });

  // 逐段格式核对（仅对有显式属性的段落判定，避免误报）
  rows.forEach((row) => {
    const fmt = preset.types[row.type] || preset.types.body;
    if (row.type === 'blank') return;
    if (row.formatSource === 'none') {
      issues.push({
        code: 'FONT_INHERITED',
        level: 'warn',
        category: 'paragraph',
        location: '第' + (row.index + 1) + '段',
        message: '未显式设置字体字号（依赖样式继承），版式不可控',
        evidence: '锚点：' + row.text.slice(0, 18),
      });
      return;
    }
    if (row.font && fmt.fontCn && row.font !== fmt.fontCn) {
      issues.push({
        code: 'FONT_MISMATCH',
        level: 'error',
        category: 'paragraph',
        location: '第' + (row.index + 1) + '段（' + row.type + '）',
        message: '中文字体为 "' + row.font + '"，应为 "' + fmt.fontCn + '"',
        evidence: '锚点：' + row.text.slice(0, 18),
      });
    }
    if (row.size && fmt.sizeHalfPt && row.size !== fmt.sizeHalfPt) {
      issues.push({
        code: 'SIZE_MISMATCH',
        level: 'error',
        category: 'paragraph',
        location: '第' + (row.index + 1) + '段（' + row.type + '）',
        message: '字号为 ' + (row.size / 2) + ' 磅，应为 ' + (fmt.sizeHalfPt / 2) + ' 磅',
        evidence: '锚点：' + row.text.slice(0, 18),
      });
    }
    const expectLine = preset.lineSpacing.value;
    if (row.lineSpacing && row.lineSpacing !== expectLine && !row.hasMedia) {
      issues.push({
        code: 'LINE_SPACING',
        level: 'warn',
        category: 'paragraph',
        location: '第' + (row.index + 1) + '段',
        message: '行距 ' + (row.lineSpacing / 20) + ' 磅，应为 ' + (expectLine / 20) + ' 磅',
        evidence: '锚点：' + row.text.slice(0, 18),
      });
    }
    // 缩进：只有"应采用首行缩进"的类型才判缺失
    if (fmt.firstLineChars && row.type !== 'signature' && row.type !== 'date' && row.type !== 'recipient') {
      if (row.firstLineIndent === null || row.firstLineIndent === 0) {
        issues.push({
          code: 'INDENT_MISSING',
          level: 'warn',
          category: 'paragraph',
          location: '第' + (row.index + 1) + '段（' + row.type + '）',
          message: '缺少首行缩进 2 字符',
          evidence: '锚点：' + row.text.slice(0, 18),
        });
      }
    }
    // 对齐：落款与日期应右对齐，标题应居中
    if ((row.type === 'signature' || row.type === 'date') && row.align !== 'right') {
      issues.push({
        code: 'ALIGN_SIGNATURE',
        level: 'error',
        category: 'paragraph',
        location: '第' + (row.index + 1) + '段（' + row.type + '）',
        message: '落款/日期应右对齐，当前为 ' + (row.align || '默认'),
        evidence: '锚点：' + row.text.slice(0, 18),
      });
    }
    if (row.type === 'title' && row.align && row.align !== 'center') {
      issues.push({
        code: 'ALIGN_TITLE',
        level: 'error',
        category: 'paragraph',
        location: '第' + (row.index + 1) + '段（标题）',
        message: '标题应居中，当前为 ' + row.align,
        evidence: '锚点：' + row.text.slice(0, 18),
      });
    }
  });

  return { types, rows };
}

function diagnoseElements(types, issues, rows, options) {
  const opts = options || {};
  const has = (t) => types.includes(t);
  // v0.8.1：要素要求按文种分流，与 check_format 共用 genre.js——
  // 否则讲话稿/经验材料会被报"未识别到成文日期/署名"，而它们本就不设落款。
  const headLines = (rows || []).filter((r) => r.text).slice(0, 2).map((r) => r.text);
  const rules = resolveGenre(opts.type, headLines).rules;
  const needTitle = !rules || rules.title !== false;
  const needDate = !rules || rules.date !== false;
  if (needTitle && !has('title')) {
    issues.push({ code: 'ELEMENT_TITLE', level: 'error', category: 'structure', message: '未识别到公文标题' });
  }
  if (needDate && !has('date')) {
    issues.push({ code: 'ELEMENT_DATE', level: 'warn', category: 'structure', message: '未识别到成文日期' });
  }
  if (needDate && !has('signature')) {
    issues.push({ code: 'ELEMENT_SIGNATURE', level: 'warn', category: 'structure', message: '未识别到发文机关署名（落款）' });
  }
  // 整行占位不是"缺失"，而是"待补"：记 info，便于交付时逐条对账（v0.8.0）
  (rows || []).forEach((row) => {
    const t = placeholderType(row.text);
    if (!t) return;
    const label = { date: '成文日期', signature: '发文机关署名', recipient: '主送机关' }[t] || t;
    issues.push({
      code: 'ELEMENT_PENDING',
      level: 'info',
      category: 'structure',
      location: '第' + (row.index + 1) + '段',
      message: label + '为待补占位，未填实；正式件导出前须清零',
      evidence: '锚点：' + row.text.slice(0, 24),
    });
  });
  // 结构空行
  const titleIdx = types.indexOf('title');
  if (titleIdx >= 0 && types[titleIdx + 1] && types[titleIdx + 1] !== 'blank') {
    issues.push({ code: 'BLANK_AFTER_TITLE', level: 'warn', category: 'structure', message: '标题与下一段之间缺少结构空行' });
  }
  const sigIdx = types.indexOf('signature');
  if (sigIdx > 0 && types[sigIdx - 1] !== 'blank') {
    issues.push({ code: 'BLANK_BEFORE_SIGNATURE', level: 'warn', category: 'structure', message: '落款之前缺少结构空行' });
  }
}

function diagnoseText(rows, issues) {
  rows.forEach((row) => {
    if (!row.text) return;
    if (/^\s*\d+\s*、/.test(row.text)) {
      issues.push({
        code: 'SERIAL_COMMA',
        level: 'error',
        category: 'text',
        location: '第' + (row.index + 1) + '段',
        message: '层次序数用"1、"，应为"1."（下脚点）',
        evidence: '锚点：' + row.text.slice(0, 18),
      });
    }
    if (/^\s*[（(]\s*[一二三四五六七八九十]+\s*[)）]\s*、/.test(row.text)) {
      issues.push({
        code: 'SERIAL_PAREN',
        level: 'error',
        category: 'text',
        location: '第' + (row.index + 1) + '段',
        message: '"（一）"之后不应加顿号',
        evidence: '锚点：' + row.text.slice(0, 18),
      });
    }
    if (/\d{4}\s*年\s*0\d\s*月/.test(row.text) || /\d{4}\s*年\s*\d{1,2}\s*月\s*0\d\s*日/.test(row.text)) {
      issues.push({
        code: 'DATE_ZERO_PAD',
        level: 'error',
        category: 'text',
        location: '第' + (row.index + 1) + '段',
        message: '成文日期编虚位（如 11月05日），应写 11月5日',
        evidence: '锚点：' + row.text.slice(0, 22),
      });
    }
    if (/[a-zA-Z0-9],[\u4e00-\u9fa5]|[\u4e00-\u9fa5],[\u4e00-\u9fa5a-zA-Z0-9]/.test(row.text)) {
      issues.push({
        code: 'PUNCT_COMMA_HALF',
        level: 'warn',
        category: 'text',
        location: '第' + (row.index + 1) + '段',
        message: '中文语境使用半角逗号',
        evidence: '锚点：' + row.text.slice(0, 22),
      });
    }
    if (/[\u4e00-\u9fa5]\([^)]*\)/.test(row.text) || /\([^)]*[\u4e00-\u9fa5]/.test(row.text)) {
      issues.push({
        code: 'PUNCT_PAREN_HALF',
        level: 'warn',
        category: 'text',
        location: '第' + (row.index + 1) + '段',
        message: '中文语境使用半角括号',
        evidence: '锚点：' + row.text.slice(0, 22),
      });
    }
    if (/[\u4e00-\u9fa5]:/.test(row.text)) {
      issues.push({
        code: 'PUNCT_COLON_HALF',
        level: 'warn',
        category: 'text',
        location: '第' + (row.index + 1) + '段',
        message: '中文语境使用半角冒号',
        evidence: '锚点：' + row.text.slice(0, 22),
      });
    }
  });
}

function diagnoseMetadata(pkg, issues, platform) {
  const core = pkg.getText(CORE_PART);
  const app = pkg.getText(APP_PART);
  if (!core) {
    issues.push({
      code: 'META_NO_CORE', level: 'warn', category: 'metadata',
      message: '缺少文档属性（docProps/core.xml），正常 Word 保存的文档必有',
    });
  } else {
    const creator = readTag(core, 'dc:creator');
    const desc = readTag(core, 'dc:description');
    const lastBy = readTag(core, 'cp:lastModifiedBy');
    const created = readTag(core, 'dcterms:created');
    const modified = readTag(core, 'dcterms:modified');
    if (isGeneratorValue(creator)) {
      issues.push({ code: 'META_CREATOR', level: 'warn', category: 'metadata', message: '作者字段为生成器签名：' + creator });
    }
    if (isGeneratorValue(lastBy)) {
      issues.push({ code: 'META_LASTBY', level: 'warn', category: 'metadata', message: '最后修改者为生成器签名：' + lastBy });
    }
    if (isGeneratorValue(desc)) {
      issues.push({ code: 'META_DESC', level: 'warn', category: 'metadata', message: '描述自述由程序生成：' + desc });
    }
    if (created && modified && created === modified) {
      issues.push({ code: 'META_TIME_SAME', level: 'warn', category: 'metadata', message: '创建与修改时间完全相同（' + created + '）' });
    }
    if (created && Number(created.slice(0, 4)) < 2000) {
      issues.push({ code: 'META_TIME_OLD', level: 'warn', category: 'metadata', message: '创建时间异常久远：' + created });
    }
  }
  if (app) {
    const application = readTag(app, 'Application');
    // 与 meta.js 共用同一张平台规则表：诊断报的问题，正是 smart 会修的那条
    if (isAppPlatformMismatch(application, platform)) {
      issues.push({
        code: 'META_APP', level: 'warn', category: 'metadata',
        message: 'Application 与运行平台（' + (platform || process.platform) + '）矛盾：' + application,
      });
    }
    if (readTag(app, 'TotalTime') === '0') {
      issues.push({ code: 'META_TOTALTIME', level: 'info', category: 'metadata', message: 'TotalTime=0，文档从未被编辑的特征' });
    }
  }
  if (pkg.has('docProps/thumbnail.jpeg')) {
    issues.push({ code: 'META_THUMBNAIL', level: 'info', category: 'metadata', message: '存在模板缩略图（与实际内容无关）' });
  }
  // 自定义文档属性（v0.8.2）：smart/meta 按设计保留 custom.xml（属文档数据而非
  // 生成器痕迹），但里面常带客户编号、系统流水号等内部标识，交付前须人工确认。
  const custom = pkg.getText('docProps/custom.xml');
  if (custom) {
    const count = (custom.match(/<property\b/g) || []).length || 1;
    issues.push({
      code: 'META_CUSTOM',
      level: 'info',
      category: 'metadata',
      message: '存在 ' + count + ' 项自定义文档属性（docProps/custom.xml，' +
        'smart/meta 默认保留）；如含客户编号、系统流水等内部标识，交付前手工删除',
    });
  }
  const docXml = pkg.getText(pkg.mainDocumentName) || '';
  const rsidCount = (docXml.match(/\sw:rsid[A-Za-z]*="/g) || []).length;
  if (rsidCount > 0) {
    const core2 = pkg.getText('word/settings.xml') || '';
    const listCount = (core2.match(/<w:rsid\b/g) || []).length;
    issues.push({
      code: 'META_RSID',
      level: 'info',
      category: 'metadata',
      message: '正文含 ' + rsidCount + ' 处 rsid 属性' + (listCount ? '，settings 内登记 ' + listCount + ' 条会话' : ''),
    });
  }
}

/**
 * 执行诊断。
 * @returns {object} 报告
 */
function diagnose(pkg, preset, options) {
  const issues = [];
  const opts = options || {};
  const geometry = diagnoseGeometry(pkg, preset, issues);
  const para = diagnoseParagraphs(pkg, preset, issues);
  diagnoseElements(para.types, issues, para.rows, opts);
  diagnoseText(para.rows, issues);
  diagnoseMetadata(pkg, issues, opts.platform);

  const summary = { error: 0, warn: 0, info: 0 };
  issues.forEach((i) => { summary[i.level] = (summary[i.level] || 0) + 1; });

  return {
    paragraphs: para.rows.length,
    geometry,
    typeCounts: para.types.reduce((acc, t) => {
      acc[t] = (acc[t] || 0) + 1;
      return acc;
    }, {}),
    issues,
    summary,
    pass: summary.error === 0,
  };
}

module.exports = { diagnose, effectiveFormat, readTag, twipsToCm };
