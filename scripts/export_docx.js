#!/usr/bin/env node
/**
 * 将净稿导出为公文基础版式 DOCX（可选，零第三方依赖）。
 *
 * 支持 Markdown（# / ## / ###）与纯文本净稿（启发式识别标题、主送、署名、日期）。
 * 生成 A4、版心边距、3 号仿宋正文、2 号小标宋标题、奇偶页页码；
 * 不生成版头、版记与印章，需人工补齐。
 */
'use strict';

const fs = require('fs');

const HELP = `用法: node export_docx.js <输入.md|txt> <输出.docx> [--force] [--dry-run]

输入: 纯文本或 Markdown 净稿；Markdown 的 #/##/### 映射为标题层级。
选项:
  --force     允许覆盖已存在的输出文件
  --dry-run   只解析输入并报告，不写文件
  -h, --help  显示本帮助

退出码: 0 成功；2 参数、读取、覆盖或写入错误。
生成: A4、版心边距、3号仿宋正文、2号小标宋标题、奇偶页页码；不生成版头/版记/印章。
`;

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[i] = c >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  let crc = 0xffffffff;
  for (let i = 0; i < buffer.length; i += 1) {
    crc = CRC_TABLE[(crc ^ buffer[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function xmlEscape(value) {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function runXml(text, font, sizeHalfPoints, bold) {
  const rPr = '<w:rFonts w:ascii="' + font + '" w:eastAsia="' + font + '" w:hAnsi="' + font + '"/>' +
    (bold ? '<w:b/>' : '') +
    '<w:sz w:val="' + sizeHalfPoints + '"/><w:szCs w:val="' + sizeHalfPoints + '"/>';
  return '<w:r><w:rPr>' + rPr + '</w:rPr><w:t xml:space="preserve">' + xmlEscape(text) + '</w:t></w:r>';
}

function paragraph(text, options) {
  const opts = options || {};
  const spacing = ['w:line="580"', 'w:lineRule="exact"'];
  if (opts.before) spacing.push('w:before="' + opts.before + '"');
  if (opts.after) spacing.push('w:after="' + opts.after + '"');

  const pPr = ['<w:spacing ' + spacing.join(' ') + '/>'];
  const ind = [];
  if (opts.indent) ind.push('w:firstLineChars="200"', 'w:firstLine="640"');
  if (opts.leftIndent) ind.push('w:left="' + opts.leftIndent + '"');
  if (opts.rightIndent) ind.push('w:right="' + opts.rightIndent + '"');
  if (ind.length) pPr.push('<w:ind ' + ind.join(' ') + '/>');
  if (opts.align) pPr.push('<w:jc w:val="' + opts.align + '"/>');

  return '<w:p><w:pPr>' + pPr.join('') + '</w:pPr>' +
    runXml(text, opts.font, opts.size, opts.bold) + '</w:p>';
}

function buildMarkdownBlocks(lines) {
  const blocks = [];
  lines.forEach((raw) => {
    const line = raw.replace(/\s+$/, '');
    if (!line.trim()) return;
    if (line.startsWith('# ')) {
      blocks.push({ type: 'title', text: line.slice(2).trim() });
      return;
    }
    if (line.startsWith('## ')) {
      blocks.push({ type: 'h1', text: line.slice(3).trim() });
      return;
    }
    if (line.startsWith('### ')) {
      blocks.push({ type: 'h2', text: line.slice(4).trim() });
      return;
    }
    blocks.push({ type: 'body', text: line.trim() });
  });
  return blocks;
}

function applyPositionHeuristics(blocks) {
  if (!blocks.length) return blocks;

  const bodyIndexes = [];
  blocks.forEach((block, index) => {
    if (block.type === 'body') bodyIndexes.push(index);
  });
  if (!bodyIndexes.length) return blocks;

  const first = bodyIndexes[0];
  if (blocks[0].type === 'title' && first === 1 &&
      /[：:]$/.test(blocks[first].text) && blocks[first].text.length <= 40) {
    blocks[first] = { type: 'recipient', text: blocks[first].text };
  }

  const last = bodyIndexes[bodyIndexes.length - 1];
  if (/^\d{4}年\d{1,2}月\d{1,2}日$/.test(blocks[last].text)) {
    blocks[last] = { type: 'date', text: blocks[last].text };
  }

  const remaining = [];
  blocks.forEach((block, index) => {
    if (block.type === 'body') remaining.push(index);
  });
  if (remaining.length >= 1) {
    const lastBody = remaining[remaining.length - 1];
    const next = blocks[lastBody + 1];
    const text = blocks[lastBody].text;
    if (next && next.type === 'date' && text.length <= 30 && !/[。；，：！？]$/.test(text)) {
      blocks[lastBody] = { type: 'signature', text };
    }
  }

  return blocks;
}

function buildPlainBlocks(lines) {
  const content = lines.map((line) => line.trim()).filter(Boolean);
  if (!content.length) return [];

  const blocks = [{ type: 'title', text: content[0] }];
  let start = 1;
  let end = content.length - 1;

  if (start <= end && /[：:]$/.test(content[start]) && content[start].length <= 40) {
    blocks.push({ type: 'recipient', text: content[start] });
    start += 1;
  }

  let date = null;
  if (/^\d{4}年\d{1,2}月\d{1,2}日$/.test(content[end])) {
    date = content[end];
    end -= 1;
  }

  let signature = null;
  if (end >= start && content[end].length <= 30 && !/[。；，：！？]$/.test(content[end])) {
    signature = content[end];
    end -= 1;
  }

  for (let i = start; i <= end; i += 1) {
    blocks.push({ type: 'body', text: content[i] });
  }
  if (signature) blocks.push({ type: 'signature', text: signature });
  if (date) blocks.push({ type: 'date', text: date });

  return blocks;
}

function buildDocumentXml(blocks) {
  const body = blocks.map((block) => {
    if (block.type === 'title') {
      return paragraph(block.text, {
        font: '方正小标宋简体', size: 44, align: 'center', before: 240, after: 240,
      });
    }
    if (block.type === 'h1') {
      return paragraph(block.text, { font: '黑体', size: 32, bold: true, indent: true, before: 120, after: 60 });
    }
    if (block.type === 'h2') {
      return paragraph(block.text, { font: '楷体', size: 32, indent: true, before: 60, after: 30 });
    }
    if (block.type === 'recipient') {
      return paragraph(block.text, { font: '仿宋', size: 32, align: 'left' });
    }
    if (block.type === 'signature') {
      return paragraph(block.text, { font: '仿宋', size: 32, align: 'right', rightIndent: 640 });
    }
    if (block.type === 'date') {
      return paragraph(block.text, { font: '仿宋', size: 32, align: 'right' });
    }
    return paragraph(block.text, { font: '仿宋', size: 32, indent: true });
  });

  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" ' +
    'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
    '<w:body>' + body.join('') +
    '<w:sectPr>' +
    '<w:footerReference w:type="default" r:id="rId2"/>' +
    '<w:footerReference w:type="even" r:id="rId3"/>' +
    '<w:pgSz w:w="11906" w:h="16838"/>' +
    '<w:pgMar w:top="2098" w:right="1474" w:bottom="1984" w:left="1587" w:header="851" w:footer="1587" w:gutter="0"/>' +
    '</w:sectPr>' +
    '</w:body></w:document>';
}

function buildStylesXml() {
  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
    '<w:docDefaults>' +
    '<w:rPrDefault><w:rPr>' +
    '<w:rFonts w:ascii="仿宋" w:eastAsia="仿宋" w:hAnsi="仿宋"/>' +
    '<w:sz w:val="32"/><w:szCs w:val="32"/>' +
    '</w:rPr></w:rPrDefault>' +
    '<w:pPrDefault><w:pPr><w:spacing w:line="580" w:lineRule="exact"/></w:pPr></w:pPrDefault>' +
    '</w:docDefaults>' +
    '<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style>' +
    '</w:styles>';
}

function pageFieldXml() {
  const rPr = '<w:rFonts w:ascii="宋体" w:eastAsia="宋体" w:hAnsi="宋体"/>' +
    '<w:sz w:val="28"/><w:szCs w:val="28"/>';
  return '<w:fldSimple w:instr=" PAGE "><w:r><w:rPr>' + rPr + '</w:rPr><w:t>1</w:t></w:r></w:fldSimple>';
}

function buildFooterXml(align, side) {
  const indent = side === 'right' ? '<w:ind w:right="320"/>' : '<w:ind w:left="320"/>';
  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<w:ftr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
    '<w:p><w:pPr>' + indent + '<w:jc w:val="' + align + '"/></w:pPr>' +
    runXml('— ', '宋体', 28, false) + pageFieldXml() + runXml(' —', '宋体', 28, false) +
    '</w:p></w:ftr>';
}

function buildSettingsXml() {
  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<w:settings xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
    '<w:evenAndOddHeaders/>' +
    '</w:settings>';
}

function buildZip(entries) {
  const localChunks = [];
  const centralChunks = [];
  let offset = 0;
  const dosTime = 0;
  const dosDate = 0x21;

  entries.forEach((entry) => {
    const name = Buffer.from(entry.name, 'utf8');
    const data = Buffer.from(entry.data, 'utf8');
    const crc = crc32(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt16LE(dosTime, 10);
    local.writeUInt16LE(dosDate, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    localChunks.push(local, name, data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(dosTime, 12);
    central.writeUInt16LE(dosDate, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    centralChunks.push(central, name);

    offset += 30 + name.length + data.length;
  });

  const centralStart = offset;
  const centralSize = centralChunks.reduce((sum, chunk) => sum + chunk.length, 0);

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralSize, 12);
  eocd.writeUInt32LE(centralStart, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...localChunks, ...centralChunks, eocd]);
}

function parseArgs(argv) {
  const result = { input: null, output: null, force: false, dryRun: false, help: false, error: '' };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '-h' || arg === '--help') {
      result.help = true;
      continue;
    }
    if (arg === '--force') {
      result.force = true;
      continue;
    }
    if (arg === '--dry-run') {
      result.dryRun = true;
      continue;
    }
    if (arg.startsWith('-')) {
      result.error = '未知参数：' + arg;
      continue;
    }
    if (!result.input) result.input = arg;
    else if (!result.output) result.output = arg;
    else result.error = '参数过多：' + arg;
  }
  return result;
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

  const lines = text.split(/\r?\n/);
  const isMarkdown = lines.some((line) => /^#\s+/.test(line));
  const blocks = isMarkdown
    ? applyPositionHeuristics(buildMarkdownBlocks(lines))
    : buildPlainBlocks(lines);
  if (!blocks.length) {
    process.stderr.write('输入为空，未生成文件。\n');
    return 2;
  }

  const exists = fs.existsSync(args.output);
  if (args.dryRun) {
    process.stdout.write('dry-run：解析到 ' + blocks.length + ' 个段落块（' +
      (isMarkdown ? 'Markdown' : '纯文本启发式') + '）；输出' +
      (exists ? '已存在' : '不存在') + '；未写入文件。\n');
    return 0;
  }
  if (exists && !args.force) {
    process.stderr.write('输出文件已存在：' + args.output + '。使用 --force 覆盖。\n');
    return 2;
  }

  const contentTypes = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Default Extension="xml" ContentType="application/xml"/>' +
    '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
    '<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>' +
    '<Override PartName="/word/footer1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml"/>' +
    '<Override PartName="/word/footer2.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml"/>' +
    '<Override PartName="/word/settings.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.settings+xml"/>' +
    '</Types>';

  const rootRels = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>' +
    '</Relationships>';

  const documentRels = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>' +
    '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/footer" Target="footer1.xml"/>' +
    '<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/footer" Target="footer2.xml"/>' +
    '<Relationship Id="rId4" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/settings" Target="settings.xml"/>' +
    '</Relationships>';

  const entries = [
    { name: '[Content_Types].xml', data: contentTypes },
    { name: '_rels/.rels', data: rootRels },
    { name: 'word/document.xml', data: buildDocumentXml(blocks) },
    { name: 'word/styles.xml', data: buildStylesXml() },
    { name: 'word/footer1.xml', data: buildFooterXml('right', 'right') },
    { name: 'word/footer2.xml', data: buildFooterXml('left', 'left') },
    { name: 'word/settings.xml', data: buildSettingsXml() },
    { name: 'word/_rels/document.xml.rels', data: documentRels },
  ];

  try {
    fs.writeFileSync(args.output, buildZip(entries));
  } catch (error) {
    process.stderr.write('导出失败：' + error.message + '\n');
    return 2;
  }

  process.stdout.write('已生成：' + args.output + '\n');
  process.stdout.write('提示：页码为奇偶页右/左对齐的 PAGE 域；版头、版记与印章未自动生成；日期与署名的相对缩进需人工复核；字体需系统存在，请人工复核。\n');
  return 0;
}

try {
  process.exitCode = main();
} catch (error) {
  process.stderr.write('导出失败：' + error.message + '\n');
  process.exitCode = 2;
}