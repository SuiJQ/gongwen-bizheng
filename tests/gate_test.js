#!/usr/bin/env node
/**
 * 门禁有效性回归（纯 Node，零第三方依赖）。
 *
 * 这套用例对应 2026-11-16 对抗压测发现的四个 P0：
 *   1. 缺要素的稿子曾能 check_format 通过（自证闭环）
 *   2. 12-redlines 曾是孤儿文件（五个门禁文件零引用）
 *   3. 「一.」式序数曾完全不识别
 *   4. Markdown 表格曾静默退化成正文
 *
 * 判定原则：门禁必须"能拦住"，而不是"能描述"。
 *
 * 运行：node tests/gate_test.js
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const CHECK = path.join(ROOT, 'scripts', 'check_format.js');
const EXPORT = path.join(ROOT, 'scripts', 'export_docx.js');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'gw-gate-'));

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

function write(name, text) {
  const p = path.join(TMP, name);
  fs.writeFileSync(p, text, 'utf8');
  return p;
}

function check(file, extraArgs) {
  const r = spawnSync(process.execPath, [CHECK, file, '--json'].concat(extraArgs || []),
    { encoding: 'utf8' });
  let json = null;
  try { json = JSON.parse(r.stdout); } catch (e) { /* 保留 null */ }
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

// ---------------------------------------------------------------- P0-1
test('合格稿通过检查（不误伤）', () => {
  const r = check(write('good.txt', GOOD));
  assert.strictEqual(r.code, 0, 'exit=' + r.code + ' issues=' + JSON.stringify(r.json && r.json.issues));
  assert.strictEqual(r.json.passed, true);
});

test('缺成文日期必须被拦（曾 pass:true）', () => {
  const text = GOOD.replace('2026年11月15日\n', '');
  const r = check(write('no-date.txt', text));
  assert.strictEqual(r.code, 1, '缺日期应 exit 1，实际 ' + r.code);
  assert.ok(r.json.issues.some((i) => i.code === 'STRUCT_DATE'), JSON.stringify(r.json.issues));
});

test('缺落款必须被拦', () => {
  const text = GOOD.replace('××市人民政府\n\n', '');
  const r = check(write('no-sign.txt', text));
  assert.strictEqual(r.code, 1);
  assert.ok(r.json.issues.some((i) => i.code === 'STRUCT_SIGNATURE' || i.code === 'STRUCT_DATE'),
    JSON.stringify(r.json.issues));
});

test('缺主送机关必须被拦', () => {
  const text = GOOD.replace('各区县人民政府：\n\n', '');
  const r = check(write('no-recipient.txt', text));
  assert.strictEqual(r.code, 1);
  assert.ok(r.json.issues.some((i) => i.code === 'STRUCT_RECIPIENT'), JSON.stringify(r.json.issues));
});

test('首段无文种名必须被拦', () => {
  const text = GOOD.replace('关于做好汛期安全隐患排查工作的通知', '汛期安全隐患排查有关事项');
  const r = check(write('no-type.txt', text));
  assert.strictEqual(r.code, 1);
  assert.ok(r.json.issues.some((i) => i.code === 'STRUCT_TITLE'), JSON.stringify(r.json.issues));
});

test('只有几个字的稿子必须被拦', () => {
  const r = check(write('mini.txt', '通知\n\n一、甲\n'));
  assert.strictEqual(r.code, 1);
  assert.ok(r.json.issues.some((i) => i.code === 'STRUCT_TOO_SHORT'), JSON.stringify(r.json.issues));
});

test('--no-structure 可跳过结构检查（供片段补写用）', () => {
  const r = check(write('frag.txt', '通知\n\n一、甲\n'), ['--no-structure']);
  const structIssues = (r.json.issues || []).filter((i) => i.code.startsWith('STRUCT_'));
  assert.strictEqual(structIssues.length, 0, '仍报结构项：' + JSON.stringify(structIssues));
});

// ---------------------------------------------------------------- P0-3
test('「一.」式序数必须被识别（曾完全不报）', () => {
  const text = GOOD.replace('一、总体要求', '一.总体要求').replace('二、工作要求', '二.工作要求');
  const r = check(write('hanju.txt', text));
  assert.strictEqual(r.code, 1, '应 exit 1，实际 ' + r.code);
  assert.ok(r.json.issues.some((i) => i.code === 'SERIAL_HANJU'), JSON.stringify(r.json.issues));
});

test('「1、」与「（一）、」仍被识别', () => {
  const text = GOOD.replace('一、总体要求', '1、总体要求').replace('（一）压实责任', '（一）、压实责任');
  const r = check(write('dunhao.txt', text));
  assert.strictEqual(r.code, 1);
  const codes = r.json.issues.map((i) => i.code);
  assert.ok(codes.includes('SERIAL_DUNHAO'), codes.join(','));
  assert.ok(codes.includes('SERIAL_PAREN_PUNCT'), codes.join(','));
});

// ---------------------------------------------------------------- P0-4
test('Markdown 表格导出必须告警（曾静默降级）', () => {
  const md = write('tbl.md', '# 关于报送的通知\n\n各区县：\n\n| 项目 | 金额 |\n|---|---|\n| 甲 | 80万元 |\n\n特此通知。\n\n××局\n\n2026年11月5日\n');
  const out = path.join(TMP, 'tbl.docx');
  const r = spawnSync(process.execPath, [EXPORT, md, out, '--force'], { encoding: 'utf8' });
  assert.ok(/表格/.test(r.stderr), '未告警表格，stderr=' + (r.stderr || '(空)'));
});

test('无表格的稿子导出不告警', () => {
  const md = write('plain.md', GOOD);
  const out = path.join(TMP, 'plain.docx');
  const r = spawnSync(process.execPath, [EXPORT, md, out, '--force'], { encoding: 'utf8' });
  assert.ok(!/表格/.test(r.stderr), '误告警，stderr=' + r.stderr);
});

// ---------------------------------------------------------------- P0-2
test('12-redlines 必须被门禁文件引用（曾是孤儿）', () => {
  const must = ['SKILL.md', 'references/07-review.md'];
  const missing = must.filter((f) => {
    const t = fs.readFileSync(path.join(ROOT, f), 'utf8');
    return !t.includes('12-redlines');
  });
  assert.strictEqual(missing.length, 0, '未引用：' + missing.join(','));
});

test('交付前检查清单含红线提示', () => {
  const t = fs.readFileSync(path.join(ROOT, 'SKILL.md'), 'utf8');
  const chk = t.split('## 1.')[1].split('## 2.')[0];
  assert.ok(/12-redlines/.test(chk), '检查清单未提 12-redlines');
  assert.ok(/政治/.test(chk), '检查清单未提政治表述');
});

// --------------------------------------- v0.6.4 遗留项回归
test('跳级序数必须被拦（一、→1. 曾放行）', () => {
  // 标题行不能以句号结尾，否则会被判为正文段；本用例只测层级跳级
  const text = GOOD.replace('（一）压实责任。各区县于11月30日前完成排查。', '1.具体要求');
  const r = check(write('skiplevel.txt', text));
  assert.strictEqual(r.code, 1, '应 exit 1，实际 ' + r.code);
  assert.ok(r.json.issues.some((i) => i.code === 'SERIAL_SKIP_LEVEL'),
    JSON.stringify(r.json.issues.map((i) => i.code)));
});

test('逐层展开的序数不误报跳级', () => {
  const text = GOOD.replace('（一）压实责任。各区县于11月30日前完成排查。',
    '（一）具体要求\n\n1.各区县于11月30日前完成排查');
  const r = check(write('oklevel.txt', text));
  assert.ok(!r.json.issues.some((i) => i.code === 'SERIAL_SKIP_LEVEL'),
    JSON.stringify(r.json.issues.map((i) => i.code)));
});

test('同一对象金额前后不一必须报（曾完全放行）', () => {
  const text = GOOD.replace('为做好汛期安全工作，现就有关事项通知如下。',
    '本项目共需资金80万元。').replace('请认真贯彻执行。', '经复核，本项目共需资金50万元。');
  const r = check(write('amount.txt', text));
  assert.ok(r.json.issues.some((i) => i.code === 'CONSIST_AMOUNT'),
    JSON.stringify(r.json.issues.map((i) => i.code)));
});

test('总额与分项关系不误报（80万其中设备50万）', () => {
  const text = GOOD.replace('为做好汛期安全工作，现就有关事项通知如下。',
    '本项目共需资金80万元，其中设备购置50万元。');
  const r = check(write('partition.txt', text));
  assert.ok(!r.json.issues.some((i) => i.code === 'CONSIST_AMOUNT'),
    JSON.stringify(r.json.issues.map((i) => i.code)));
});

test('主送与正文受文范围矛盾必须被拦（曾完全放行）', () => {
  const text = GOOD.replace('请认真贯彻执行。', '请各市州于11月30日前报送材料。');
  const r = check(write('recip.txt', text));
  assert.strictEqual(r.code, 1, '应 exit 1，实际 ' + r.code);
  assert.ok(r.json.issues.some((i) => i.code === 'CONSIST_RECIPIENT'),
    JSON.stringify(r.json.issues.map((i) => i.code)));
});

test('主送与正文层级一致时不误报', () => {
  const text = GOOD.replace('请认真贯彻执行。', '请各区县于11月30日前报送材料。');
  const r = check(write('recip-ok.txt', text));
  assert.ok(!r.json.issues.some((i) => i.code === 'CONSIST_RECIPIENT'),
    JSON.stringify(r.json.issues.map((i) => i.code)));
});

// ------------------------------------------------------------------ 汇总
console.log('\n' + '='.repeat(56));
console.log('门禁有效性回归：通过 ' + passed + ' / 失败 ' + failed);
if (failed) failures.forEach((f) => console.log('  - ' + f));
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) { /* ignore */ }
process.exitCode = failed ? 1 : 0;
