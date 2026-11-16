#!/usr/bin/env node
/**
 * 跨平台回归（纯 Node，零第三方依赖）。
 *
 * 这套用例对应 v0.7.2 的跨平台收口，覆盖三类只在特定宿主上才暴露的缺陷：
 *   1. 文本编码：UTF-8 BOM / UTF-16LE / UTF-16BE（Windows 记事本、PowerShell）
 *   2. 换行：CRLF 与单独的 CR（Windows 与旧版 Mac），行切分错位会让逐行检查失效
 *   3. 平台判定：Application 平台规则可注入，三条分支在任意宿主上都能确定性复现
 *
 * 判据与 gate_test 一致：不是"能跑"，而是"能给出一致的结论"。
 *
 * 运行：node tests/crossplatform_test.js
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const { DocxPackage } = require('../scripts/docformat/docpkg');

const ROOT = path.join(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'gw-cross-'));

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

/** 跑脚本：参数一律走数组，不经过 shell，Windows 与 POSIX 行为一致 */
function run(script, args) {
  return spawnSync(process.execPath, [path.join(ROOT, 'scripts', script)].concat(args),
    { encoding: 'utf8' });
}

function writeBuffer(name, buf) {
  const p = path.join(TMP, name);
  fs.writeFileSync(p, buf);
  return p;
}

function write(name, text) {
  return writeBuffer(name, Buffer.from(text, 'utf8'));
}

function checkJson(file) {
  const r = run('check_format.js', [file, '--json']);
  let json = null;
  try { json = JSON.parse(r.stdout); } catch (e) { /* 保留 null，断言里会报 */ }
  return { code: r.status, json, stderr: r.stderr };
}

const GOOD = [
  '关于做好汛期安全隐患排查工作的通知', '',
  '各区县人民政府：', '',
  '为做好汛期安全工作，现就有关事项通知如下。', '',
  '一、总体要求', '',
  '（一）压实责任。各区县于11月30日前完成排查。', '',
  '二、工作要求', '',
  '请认真贯彻执行。', '',
  '特此通知。', '',
  '××市人民政府', '',
  '2026年11月15日', '',
].join('\n');

const GOOD_LF = write('good-lf.txt', GOOD);

// ------------------------------------------------------------ 换行
test('CRLF 与 LF 的检查结论完全一致', () => {
  const lf = checkJson(GOOD_LF);
  const crlf = checkJson(write('good-crlf.txt', GOOD.replace(/\n/g, '\r\n')));
  assert.strictEqual(lf.code, 0, 'LF 基线不通过：' + JSON.stringify(lf.json && lf.json.issues));
  assert.strictEqual(crlf.code, lf.code, 'CRLF exit=' + crlf.code + ' issues=' +
    JSON.stringify(crlf.json && crlf.json.issues));
  assert.strictEqual(crlf.json.chars, lf.json.chars, 'CRLF 字数口径漂移');
});

test('单独的 CR（旧 Mac）不被当成一行', () => {
  const r = checkJson(write('good-cr.txt', GOOD.replace(/\n/g, '\r')));
  assert.strictEqual(r.code, 0, 'CR 换行未归一，逐行检查已失效：' +
    JSON.stringify(r.json && r.json.issues));
});

// ------------------------------------------------------------ 编码
test('UTF-8 BOM 不影响结构与逐行判定', () => {
  const buf = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(GOOD, 'utf8')]);
  const r = checkJson(writeBuffer('good-bom.txt', buf));
  assert.strictEqual(r.code, 0, '带 BOM 被误判：' + JSON.stringify(r.json && r.json.issues));
});

test('UTF-16LE（记事本 Unicode）可正常读取', () => {
  const buf = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('\ufeff' + GOOD, 'utf16le')]);
  const r = checkJson(writeBuffer('good-utf16le.txt', buf));
  assert.strictEqual(r.code, 0, 'UTF-16LE 解码失败：' + JSON.stringify(r.json && r.json.issues));
});

test('UTF-16BE 可正常读取', () => {
  const le = Buffer.from('\ufeff' + GOOD, 'utf16le');
  const be = Buffer.from(le);
  be.swap16();
  const buf = Buffer.concat([Buffer.from([0xfe, 0xff]), be]);
  const r = checkJson(writeBuffer('good-utf16be.txt', buf));
  assert.strictEqual(r.code, 0, 'UTF-16BE 解码失败：' + JSON.stringify(r.json && r.json.issues));
});

test('export_docx 对 BOM+CRLF 输入：正文不残留 BOM', () => {
  const md = writeBuffer('bom-crlf.md',
    Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(GOOD.replace(/\n/g, '\r\n'), 'utf8')]));
  const out = path.join(TMP, 'bom-crlf.docx');
  const r = run('export_docx.js', [md, out, '--force']);
  assert.strictEqual(r.status, 0, 'stderr=' + r.stderr);
  const doc = new DocxPackage(fs.readFileSync(out)).getText('word/document.xml');
  assert.ok(doc.indexOf('\ufeff') === -1, '正文残留 BOM 字符');
  const rep = JSON.parse(run('format_docx.js', ['analyze', out, '--json']).stdout);
  assert.ok((rep.typeCounts.title || 0) >= 1, '首段未被识别为标题：' + JSON.stringify(rep.typeCounts));
});

test('check_rhythm 对 CRLF 输入结论一致', () => {
  const lfText = [GOOD, GOOD, GOOD].join('\n\n');
  const lf = run('check_rhythm.js', [write('rhythm-lf.txt', lfText), '--json']);
  const crlf = run('check_rhythm.js',
    [write('rhythm-crlf.txt', lfText.replace(/\n/g, '\r\n')), '--json']);
  assert.strictEqual(crlf.status, lf.status, 'LF=' + lf.status + ' CRLF=' + crlf.status);
  const a = JSON.parse(lf.stdout);
  const b = JSON.parse(crlf.stdout);
  assert.deepStrictEqual(b.metrics, a.metrics, '节奏指标随换行符变化');
});

// ------------------------------------------------------------ 平台规则
function macFixture() {
  const md = write('mac.md', GOOD);
  const base = path.join(TMP, 'mac-base.docx');
  const r = run('export_docx.js', [md, base, '--force']);
  assert.strictEqual(r.status, 0, '导出失败：' + r.stderr);
  const pkg = new DocxPackage(fs.readFileSync(base));
  const app = pkg.getText('docProps/app.xml');
  pkg.setText('docProps/app.xml',
    app.replace(/<Application>[^<]*<\/Application>/, '<Application>Microsoft Macintosh Word</Application>'));
  const out = path.join(TMP, 'mac.docx');
  fs.writeFileSync(out, pkg.save());
  return out;
}

test('--platform 生效：darwin 保留、linux 报矛盾、非法值报 2', () => {
  const mac = macFixture();
  const darwin = run('format_docx.js', ['analyze', mac, '--json', '--platform', 'darwin']);
  const darwinReport = JSON.parse(darwin.stdout);
  assert.ok(!darwinReport.issues.some((i) => i.code === 'META_APP'), 'darwin 误报 META_APP');
  const linux = run('format_docx.js', ['analyze', mac, '--json', '--platform', 'linux']);
  const linuxReport = JSON.parse(linux.stdout);
  assert.ok(linuxReport.issues.some((i) => i.code === 'META_APP'), 'linux 未报 META_APP');
  const bad = run('format_docx.js', ['analyze', mac, '--platform', 'windows']);
  assert.strictEqual(bad.status, 2, '非法平台值应 exit 2，实际 ' + bad.status);
});

test('--platform 传到清理侧：smart 后 Mac 签名归一为 Windows Word', () => {
  const mac = macFixture();
  const out = path.join(TMP, 'mac-smart.docx');
  const r = run('format_docx.js', ['smart', mac, out, '--platform', 'linux', '--force']);
  assert.strictEqual(r.status, 0, 'stderr=' + r.stderr);
  const app = new DocxPackage(fs.readFileSync(out)).getText('docProps/app.xml');
  assert.ok(/<Application>Microsoft Office Word<\/Application>/.test(app), '未归一：' + app);
  const again = run('format_docx.js', ['analyze', out, '--json', '--platform', 'linux']);
  assert.ok(!JSON.parse(again.stdout).issues.some((i) => i.code === 'META_APP'), '清理后仍报 META_APP');
});

test('--custom-settings 的 JSON 带 BOM 仍可解析', () => {
  const doc = macFixture();
  const settings = writeBuffer('bom-settings.json', Buffer.concat([
    Buffer.from([0xef, 0xbb, 0xbf]),
    Buffer.from(JSON.stringify({ overrides: { page: { left: 3.0 } } }), 'utf8'),
  ]));
  const out = path.join(TMP, 'bom-settings-out.docx');
  const r = run('format_docx.js', ['smart', doc, out, '--custom-settings', settings, '--force']);
  assert.strictEqual(r.status, 0, '带 BOM 的 JSON 未被接受：' + r.stderr);
  const rep = JSON.parse(run('format_docx.js', ['analyze', out, '--json']).stdout);
  assert.ok(Math.abs(rep.geometry.left - 3.0) < 0.05, '覆盖参数未生效：left=' + rep.geometry.left);
});

// ------------------------------------------------------------ 路径比较
test('同路径判定按文件系统语义：大小写不敏感平台拒绝，敏感平台放行', () => {
  const { assertDistinctPaths } = require('../scripts/docformat/index');
  const lower = write('case.docx', 'placeholder');   // 只是占位文件，不要求是合法 docx
  const upper = path.join(TMP, 'CASE.docx');
  assert.throws(() => assertDistinctPaths(lower, upper, 'win32'), /输出路径与输入文件相同/,
    'win32 下大小写不同仍是同一文件，应拒绝');
  assert.throws(() => assertDistinctPaths(lower, upper, 'darwin'), /输出路径与输入文件相同/,
    'darwin 默认 APFS 大小写不敏感，应拒绝');
  assert.doesNotThrow(() => assertDistinctPaths(lower, upper, 'linux'),
    'linux 大小写敏感，不同路径应放行');
  assert.throws(() => assertDistinctPaths(lower, lower, 'linux'), /输出路径与输入文件相同/,
    '同一路径在任何平台都必须拒绝');
});

// ------------------------------------------------------------------ 汇总
console.log('\n' + '='.repeat(56));
console.log('跨平台回归：通过 ' + passed + ' / 失败 ' + failed);
if (failed) failures.forEach((f) => console.log('  - ' + f));
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) { /* 清理失败不影响结论 */ }
process.exitCode = failed ? 1 : 0;