#!/usr/bin/env node
/**
 * 健壮性与畸形输入回归（纯 Node，零第三方依赖）。
 *
 * 这套用例覆盖"正则解析 OOXML"最容易踩的坑：属性含 '>'、XML 注释、CDATA、
 * 嵌套同名标签、超长属性、无 w:t 的域段落，以及六类非法/损坏输入。
 *
 * 判定原则：
 * - 非法输入必须**明确报错**，不得静默产出；
 * - 合法但结构特殊的输入，处理后输出必须是**良构 XML**（语义保真见
 *   docformat_test.js 的表格/图片/分节符用例）；
 * - 已知不支持的构造（嵌套 w:p）只要求不崩溃且输出良构，见 README「已知边界」。
 *
 * 运行：node tests/robustness_test.js
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { DocxPackage } = require('../scripts/docformat/docpkg');
const { readZip, writeZip } = require('../scripts/docformat/zip');
const xml = require('../scripts/docformat/xml');
const api = require('../scripts/docformat/index');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'gw-robust-'));
const W_NS = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const R_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';

let passed = 0;
let failed = 0;
const failures = [];

function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log('PASS ' + name);
  } catch (e) {
    failed += 1;
    failures.push(name + '：' + e.message);
    console.log('FAIL ' + name + '  => ' + e.message);
  }
}

/** 极简良构检查：引号感知扫标签，忽略声明/注释/CDATA，校验开闭配对 */
function assertWellFormed(text, label) {
  const stack = [];

  let i = 0;
  while (i < text.length) {
    const lt = text.indexOf('<', i);
    if (lt < 0) break;
    if (text.startsWith('<?', lt)) { i = text.indexOf('?>', lt) + 2; continue; }
    if (text.startsWith('<!--', lt)) { i = text.indexOf('-->', lt) + 3; continue; }
    if (text.startsWith('<![CDATA[', lt)) { i = text.indexOf(']]>', lt) + 3; continue; }
    // 引号感知找标签结束
    let quote = null;
    let end = -1;
    for (let k = lt; k < text.length; k += 1) {
      const c = text[k];
      if (quote) { if (c === quote) quote = null; } else if (c === '"' || c === "'") quote = c;
      else if (c === '>') { end = k; break; }
    }
    if (end < 0) throw new Error(label + '：标签未闭合 @' + lt);
    const raw = text.slice(lt + 1, end);
    const closing = raw.startsWith('/');
    const selfClose = raw.endsWith('/');
    const name = raw.replace(/^\//, '').replace(/\/$/, '').split(/[\s/]/)[0];
    if (closing) {
      const top = stack.pop();
      if (top !== name) throw new Error(label + '：闭合标签不匹配 </' + name + '> vs ' + top);
    } else if (!selfClose) {
      stack.push(name);
    }
    i = end + 1;
  }
  if (stack.length) throw new Error(label + '：未闭合 ' + stack.join(','));
}

function pkgWith(bodyXml, extraParts) {
  const parse = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
  const document = parse + '<w:document xmlns:w="' + W_NS + '" xmlns:r="' + R_NS + '">' +
    '<w:body>' + bodyXml +
    '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/>' +
    '<w:pgMar w:top="1440" w:right="1800" w:bottom="1440" w:left="1800" ' +
    'w:header="851" w:footer="992" w:gutter="0"/></w:sectPr></w:body></w:document>';
  const entries = [
    { name: '[Content_Types].xml', data: parse + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
      '<Default Extension="xml" ContentType="application/xml"/>' +
      '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>' },
    { name: '_rels/.rels', data: parse + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>' },
    { name: 'word/document.xml', data: document },
  ].concat(extraParts || []);
  return writeZip(entries.map((e) => ({ name: e.name, data: Buffer.from(e.data, 'utf8') })));
}

function roundTrip(bodyXml, label, extraParts) {
  const src = path.join(TMP, label + '.docx');
  fs.writeFileSync(src, pkgWith(bodyXml, extraParts));
  const out = path.join(TMP, label + '-fixed.docx');
  api.processFile(src, out, { force: true });
  const fixed = new DocxPackage(fs.readFileSync(out));
  const doc = fixed.getText('word/document.xml');
  assertWellFormed(doc, label);
  return doc;
}

// ------------------------------------------------------------------ 非法输入
test('空 zip（无 word/document.xml）明确报错', () => {
  const empty = writeZip([
    { name: '[Content_Types].xml', data: '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>' },
    { name: '_rels/.rels', data: '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"/>' },
  ]);
  const f = path.join(TMP, 'empty.docx');
  fs.writeFileSync(f, empty);
  assert.throws(() => api.openPackage(f), /缺少正文部件|未找到/);
});

test('非 zip 内容改名 .docx 明确报错', () => {
  assert.throws(() => readZip(Buffer.from('这不是一个 zip 文件，只是一段文本。', 'utf8')),
    /未找到中央目录/);
});

test('CRC 损坏明确报错并指名部件', () => {
  const buf = pkgWith('<w:p><w:r><w:t>正文</w:t></w:r></w:p>');
  const cd = buf.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  const bad = Buffer.from(buf);
  bad.writeUInt32LE(0xdeadbeef, cd + 16);
  assert.throws(() => readZip(bad), /CRC/);
});

test('ZIP64 标记明确拒绝', () => {
  const buf = pkgWith('<w:p><w:r><w:t>正文</w:t></w:r></w:p>');
  const eocd = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const bad = Buffer.from(buf);
  bad.writeUInt32LE(0xffffffff, eocd + 16);
  assert.throws(() => readZip(bad), /ZIP64/);
});

// ------------------------------------------------------- 合法但结构特殊的输入
test('属性值含 ">" 的段落处理后仍良构', () => {
  const doc = roundTrip('<w:p><w:pPr w:val="a>b"><w:jc w:val="both"/></w:pPr>' +
    '<w:r><w:t>属性含大于号的段落</w:t></w:r></w:p>', 'attr-gt');
  assert.ok(doc.includes('属性含大于号的段落'), '正文丢失');
});

test('XML 注释中的 w:p 不被当成真段落（不改写注释为段落属性）', () => {
  const doc = roundTrip('<w:p><w:r><w:t>真实段落。</w:t></w:r></w:p>' +
    '<!-- <w:p><w:r><w:t>注释里的假段落</w:t></w:r></w:p> -->', 'comment');
  assert.ok(doc.includes('真实段落。'), '正文丢失');
  assertWellFormed(doc, 'comment');
});

test('w:t 内含 CDATA 时不崩溃且输出良构', () => {
  const doc = roundTrip('<w:p><w:r><w:t><![CDATA[含 <尖括号> 与 & 符号]]></w:t></w:r></w:p>', 'cdata');
  assert.ok(doc.length > 0);
});

test('嵌套同名 w:p（表格特殊结构）不崩溃且输出良构', () => {
  const doc = roundTrip('<w:p><w:r><w:t>外层</w:t></w:r>' +
    '<w:p><w:r><w:t>内层</w:t></w:r></w:p></w:p>', 'nested-p');
  assert.ok(doc.includes('</w:document>'));
});

test('超长属性值（512KB）不崩溃', () => {
  const huge = 'x'.repeat(512 * 1024);
  const doc = roundTrip('<w:p><w:pPr w:val="' + huge + '"/><w:r><w:t>超长属性</w:t></w:r></w:p>', 'huge-attr');
  assert.ok(doc.includes('超长属性'));
});

test('只有域代码无 w:t 的段落不崩溃', () => {
  const doc = roundTrip('<w:p><w:r><w:fldChar w:fldCharType="begin"/></w:r>' +
    '<w:r><w:instrText> PAGE </w:instrText></w:r>' +
    '<w:r><w:fldChar w:fldCharType="end"/></w:r></w:p>', 'fld-only');
  assertWellFormed(doc, 'fld-only');
});

test('空正文（只有 sectPr）不崩溃', () => {
  const src = path.join(TMP, 'empty-body.docx');
  fs.writeFileSync(src, pkgWith(''));
  const out = path.join(TMP, 'empty-body-fixed.docx');
  api.processFile(src, out, { force: true });
  assert.ok(new DocxPackage(fs.readFileSync(out)).getText('word/document.xml').includes('</w:document>'));
});

// ------------------------------------------------- 编码判定（v0.8.2）
// 背景：无 BOM 的 GBK 曾按 utf8 解码，非法字节静默变 U+FFFD——
// 机检报"缺标题/缺日期"，导出产出乱码 docx 且 exit 0。
const { decodeBufferWithMeta } = require('../scripts/docformat/textio');

// Node 的 Buffer 只能解码 GBK、不能编码，故用十六进制固件（Python 生成，内容同下注释）
// 原文：关于做好汛期安全隐患排查工作的通知\n\n各区县人民政府：\n
const GBK_SAMPLE = Buffer.from(
  'b9d8d3dad7f6bac3d1b4c6dab0b2c8abd2febbbcc5c5b2e9b9a4d7f7b5c4cda8d6aa0a0ab8f7c7f8cfd8c8cbc3f1d5feb8aea3ba0a',
  'hex');
// 完整稿：标题→主送→缘由→结语→署名→日期
const GBK_FULL = Buffer.from(
  'b9d8d3dad7f6bac3d1b4c6dab0b2c8abd2febbbcc5c5b2e9b9a4d7f7b5c4cda8d6aa0a0ab8f7c7f8cfd8c8cbc3f1d5feb8aea3ba0a0a' +
  'ceaad7f6bac3d1b4c6dab0b2c8abb9a4d7f7a3accfd6becdd3d0b9d8cac2cfeecda8d6aac8e7cfc2a1a30a0accd8b4cbcda8d6aaa1a30a0a' +
  'a1c1a1c1cad0c8cbc3f1d5feb8ae0a0a32303236c4ea3131d4c23135c8d50a',
  'hex');

test('无 BOM 的 GBK 文本次要路径：识别为 gb18030 且正文正确', () => {
  const r = decodeBufferWithMeta(GBK_SAMPLE);
  assert.strictEqual(r.encoding, 'gb18030', '应识别为 gb18030，实际 ' + r.encoding);
  assert.ok(r.text.startsWith('关于做好汛期'), '解码后正文应为原文，实际 ' + r.text.slice(0, 12));
});

test('UTF-8 不被误判为 GB18030', () => {
  const text = '关于加强安全生产工作的通知\n';
  const r = decodeBufferWithMeta(Buffer.from(text, 'utf8'));
  assert.strictEqual(r.encoding, 'utf-8');
  assert.strictEqual(r.text, text);
});

test('随机二进制判定为 unknown（不静默当文本）', () => {
  const buf = Buffer.from([0x00, 0xff, 0xfe, 0x81, 0x40, 0x9a, 0xc3, 0x28]);
  const r = decodeBufferWithMeta(buf);
  assert.ok(r.encoding === 'unknown' || r.text.includes('\ufffd'), '应判 unknown，实际 ' + r.encoding);
});

test('GBK 输入经 export 后正文不乱码（曾产出乱码 docx）', () => {
  const { execFileSync } = require('child_process');
  const md = path.join(TMP, 'gbk-src.txt');
  fs.writeFileSync(md, GBK_FULL);
  const out = path.join(TMP, 'gbk-out.docx');
  execFileSync(process.execPath, [path.join(__dirname, '..', 'scripts', 'export_docx.js'), md, out, '--force'],
    { stdio: 'pipe' });
  const doc = new DocxPackage(fs.readFileSync(out)).getText('word/document.xml');
  assert.ok(doc.includes('关于做好汛期安全隐患排查工作的通知'), 'docx 正文缺原文');
  assert.ok(!doc.includes('\ufffd'), 'docx 正文含替换字符，说明仍按错误编码解码');
});

// ------------------------------------------------------------------ 汇总
console.log('\n' + '='.repeat(56));
console.log('健壮性回归：通过 ' + passed + ' / 失败 ' + failed);
if (failed) failures.forEach((f) => console.log('  - ' + f));
try {
  fs.rmSync(TMP, { recursive: true, force: true });
} catch (e) { /* 清理失败不影响结论 */ }
process.exitCode = failed ? 1 : 0;
