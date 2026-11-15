#!/usr/bin/env node
/**
 * 净稿导出 DOCX。
 *
 * 实现要点（v0.4.1 起）：
 * - 本脚本只负责「解析净稿 → 生成骨架包」，版式一律交给 docformat 管线
 *   （preset 定参数、detect 定段落类型、ppr 装配属性），因此导出产物与
 *   `format_docx.js smart` 的产物同源，不会再出现两套参数各写各的分叉。
 * - 骨架包只含文字，不含任何硬编码字体字号；页面几何、行距、层次字体、
 *   结构空行、页码、文档属性均由管线统一施加。
 * - 仅使用 Node 内置模块，无第三方依赖，无网络访问，无删除操作。
 */
'use strict';

const fs = require('fs');
const { writeZip } = require('./docformat/zip');
const { DocxPackage } = require('./docformat/docpkg');
const { getPreset } = require('./docformat/preset');
const { formatDocument, assertDistinctPaths } = require('./docformat/index');
const { XML_DECL, escapeText } = require('./docformat/xml');

const W_NS = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const R_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const REL_NS = 'http://schemas.openxmlformats.org/package/2006/relationships';
const CT_NS = 'http://schemas.openxmlformats.org/package/2006/content-types';

const HELP = `用法: node export_docx.js <输入.md|txt> <输出.docx> [--force] [--dry-run]

输入: 纯文本或 Markdown 净稿。Markdown 的 #/##/### 只用于剥离标记，
      段落类型由 docformat 判定链按公文要素与层次序数识别（与 format_docx.js 同源）。
选项:
  --force     允许覆盖已存在的输出文件
  --dry-run   只解析输入并报告，不写文件
  -h, --help  显示本帮助

退出码: 0 成功；2 参数、读取、覆盖或写入错误。
生成: A4、版心边距、统一预设字号行距、层次标题字体、结构空行、奇偶页页码、
      文档属性；不生成版头/版记/印章。版式可用 format_docx.js analyze 复检。
`;

function parseArgs(argv) {
  const args = {
    help: false, force: false, dryRun: false, input: null, output: null, error: null,
  };
  const positional = [];
  argv.forEach((a) => {
    if (a === '-h' || a === '--help') args.help = true;
    else if (a === '--force') args.force = true;
    else if (a === '--dry-run') args.dryRun = true;
    else if (a.startsWith('-')) args.error = '未知参数：' + a;
    else positional.push(a);
  });
  if (positional[0]) args.input = positional[0];
  if (positional[1]) args.output = positional[1];
  if (positional.length > 2) args.error = '参数过多：' + positional.slice(2).join(' ');
  return args;
}

/** 逐行剥离 Markdown 标记，保留原顺序（不做任何重排） */
function linesToParagraphs(lines) {
  const out = [];
  lines.forEach((raw) => {
    const line = raw.replace(/\s+$/, '');
    if (!line.trim()) return;
    if (line.startsWith('### ')) out.push(line.slice(4).trim());
    else if (line.startsWith('## ')) out.push(line.slice(3).trim());
    else if (line.startsWith('# ')) out.push(line.slice(2).trim());
    else out.push(line.trim());
  });
  return out;
}

/** 骨架正文：只写文字，不含任何版式属性；sectPr 留空交给管线补页面几何 */
function buildSkeletonDocument(paragraphs) {
  const body = paragraphs.map((text) => '<w:p><w:r><w:t xml:space="preserve">' +
    escapeText(text) + '</w:t></w:r></w:p>').join('');
  return XML_DECL + '<w:document xmlns:w="' + W_NS + '" xmlns:r="' + R_NS + '">' +
    '<w:body>' + body + '<w:sectPr></w:sectPr></w:body></w:document>';
}

/** 骨架样式表：docDefaults 取自预设，不硬编码字面值 */
function buildSkeletonStyles(preset) {
  const body = preset.types.body;
  const spacing = preset.lineSpacing || { value: 560, rule: 'exact' };
  return XML_DECL + '<w:styles xmlns:w="' + W_NS + '">' +
    '<w:docDefaults><w:rPrDefault><w:rPr>' +
    '<w:rFonts w:ascii="' + (body.fontEn || 'Times New Roman') + '"' +
    ' w:eastAsia="' + (body.fontCn || '仿宋_GB2312') + '"' +
    ' w:hAnsi="' + (body.fontEn || 'Times New Roman') + '"/>' +
    '<w:sz w:val="' + String(body.sizeHalfPt || 32) + '"/>' +
    '<w:szCs w:val="' + String(body.sizeHalfPt || 32) + '"/>' +
    '</w:rPr></w:rPrDefault>' +
    '<w:pPrDefault><w:pPr><w:spacing w:line="' + String(spacing.value) +
    '" w:lineRule="' + (spacing.rule || 'exact') + '"/></w:pPr></w:pPrDefault>' +
    '</w:docDefaults>' +
    '<w:style w:type="paragraph" w:default="1" w:styleId="Normal">' +
    '<w:name w:val="Normal"/><w:qFormat/></w:style>' +
    '</w:styles>';
}

function buildContentTypes() {
  return XML_DECL + '<Types xmlns="' + CT_NS + '">' +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Default Extension="xml" ContentType="application/xml"/>' +
    '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
    '<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>' +
    '</Types>';
}

function buildRootRels() {
  return XML_DECL + '<Relationships xmlns="' + REL_NS + '">' +
    '<Relationship Id="rId1" Type="' + R_NS + '/officeDocument" Target="word/document.xml"/>' +
    '</Relationships>';
}

/** 生成骨架包并交给 docformat 管线施加版式，返回 DocxPackage */
function buildPackage(paragraphs, presetName) {
  const preset = getPreset(presetName || 'official');
  const entries = [
    { name: '[Content_Types].xml', data: buildContentTypes() },
    { name: '_rels/.rels', data: buildRootRels() },
    { name: 'word/document.xml', data: buildSkeletonDocument(paragraphs) },
    { name: 'word/styles.xml', data: buildSkeletonStyles(preset) },
  ];
  const pkg = new DocxPackage(writeZip(entries.map((e) => ({ name: e.name, data: Buffer.from(e.data, 'utf8') }))));
  const result = formatDocument(pkg, { preset: presetName || 'official' }, new Date());
  return { pkg, result, preset };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(HELP);
    return 0;
  }
  if (args.error) {
    process.stderr.write(args.error + '\n');
    return 2;
  }
  if (!args.input || !args.output) {
    process.stderr.write('缺少输入或输出路径。使用 --help 查看用法。\n');
    return 2;
  }

  let text;
  try {
    text = fs.readFileSync(args.input, 'utf8');
  } catch (error) {
    process.stderr.write('读取失败：' + error.message + '\n');
    return 2;
  }

  const paragraphs = linesToParagraphs(text.split(/\r?\n/));
  if (!paragraphs.length) {
    process.stderr.write('输入为空，未生成文件。\n');
    return 2;
  }

  const exists = fs.existsSync(args.output);
  if (args.dryRun) {
    process.stdout.write('dry-run：解析到 ' + paragraphs.length + ' 个段落；输出' +
      (exists ? '已存在' : '不存在') + '；未写入文件。\n');
    return 0;
  }
  if (exists && !args.force) {
    process.stderr.write('输出文件已存在：' + args.output + '。使用 --force 覆盖。\n');
    return 2;
  }
  try {
    assertDistinctPaths(args.input, args.output);
  } catch (error) {
    process.stderr.write(error.message + '\n');
    return 2;
  }

  let built;
  try {
    built = buildPackage(paragraphs);
  } catch (error) {
    process.stderr.write('排版处理失败：' + error.message + '\n');
    return 2;
  }

  try {
    fs.writeFileSync(args.output, built.pkg.save());
  } catch (error) {
    process.stderr.write('导出失败：' + error.message + '\n');
    return 2;
  }

  const stats = built.result.stats;
  process.stdout.write('已生成：' + args.output + '（' + fs.statSync(args.output).size + ' 字节）\n');
  process.stdout.write('段落类型：' + Object.keys(stats).map((k) => k + '=' + stats[k]).join(' ') + '\n');
  process.stdout.write('结构空行：补 ' + (built.result.steps.structure ? built.result.steps.structure.inserted : 0) + ' 处\n');
  process.stdout.write('提示：页码为奇偶页右/左对齐的 PAGE 域；版头、版记与印章未自动生成；' +
    '日期与署名的相对缩进需人工复核；字体需系统存在，请人工复核。\n');
  return 0;
}

try {
  process.exitCode = main();
} catch (error) {
  process.stderr.write('导出失败：' + error.message + '\n');
  process.exitCode = 2;
}
