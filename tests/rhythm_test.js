#!/usr/bin/env node
/**
 * 句式节奏检测回归（v0.7.0 新增）。
 *
 * 对应 06-language 的结构性缺失：原规则只给「句长超 50 字就拆」的上限，
 * 不管长短起伏与相邻句同构。本套用例的核心是证明**区分力**：
 * 正常公文零误报，机器味必须被抓到。
 *
 * 阈值按公文体标定（正常公文句长 CV 中位约 0.13），不采用网文基线 0.55。
 *
 * 运行：node tests/rhythm_test.js
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const SCRIPT = path.join(ROOT, 'scripts', 'check_rhythm.js');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'gw-rhythm-'));

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

function run(file, extra) {
  const r = spawnSync(process.execPath, [SCRIPT, file, '--json'].concat(extra || []),
    { encoding: 'utf8' });
  let json = null;
  try { json = JSON.parse(r.stdout); } catch (e) { /* keep null */ }
  return { code: r.status, json, stderr: r.stderr };
}

// 正常公文：句式有起伏、事项各有对象与时限
const NORMAL = [
  '为做好汛期安全防范工作，各区县要于6月10日前完成辖区内水库、堤防、地灾隐患点的全面排查，并将排查台账报市应急局。市气象局每日17时前发布预警信息，遇橙色以上预警立即启动响应。',
  '本项目共需资金80万元，其中设备购置50万元、人员培训20万元、运维10万元。资金分两批拨付，首批40万元于合同签订后10日内到账，余额验收合格后拨付。',
  '2026年前三季度，全市完成重点项目12个，投资完成率108%，同比增长18%。规上工业增加值增长6.2%，高于全省平均水平0.8个百分点。',
  '检查发现三类问题：一是部分企业应急预案未按期修订，涉及37家；二是危化品仓库监控存在盲区，涉及5处；三是特种作业人员证件过期未更新，涉及112人。',
  '请各区县于11月30日前报送整改情况，市住建局负责汇总，市应急局负责督办。对逾期未完成的，由市安委办约谈主要负责人。',
  '会议决定：一、同意调整年度安全生产考核指标；二、由市应急局牵头制定专项整治方案，8月底前报市政府；三、各区县对照方案开展自查，9月底前完成。',
].join('\n\n');

// 机器味公文：等长并列、纯顿号排比、二元套话、强行升华
const MACHINE = [
  '各单位要提高认识、强化担当、严明纪律，全力推进整治。各部门要压实责任、细化措施、狠抓落实，确保持续推进。各区县要明确目标、聚焦重点、压实任务，坚决守住底线。',
  '要坚持问题导向、坚持目标导向、坚持结果导向。要突出工作重点、突出关键环节、突出薄弱领域。要强化组织领导、强化督促检查、强化考核问责。',
  '通过不断优化流程、持续提升效能、切实加强管理，不仅有效提升了工作效率，而且显著优化了服务体验，更重要的是增强了群众的获得感和满意度。',
  '一是高度重视，强化组织领导，第一时间成立专项领导小组，建立健全工作机制。二是聚焦重点，狠抓落实，以钉钉子精神推动任务落地见效。三是加强宣传，营造氛围，充分利用各类载体广泛开展宣传引导。',
  '在上级部门的坚强领导和亲切关怀下，在全体同志的共同努力下，我们扎实推进各项工作，取得了显著成效，整体工作迈上了新的台阶。',
  '这不仅是一次能力的检验，更是一次作风的锤炼；不仅是一次思想的洗礼，更是一次行动的号角。让我们以更加饱满的热情、更加务实的作风、更加有力的举措，奋力谱写新篇章。',
].join('\n\n');

// ------------------------------------------------------------------ 区分力
test('正常公文零误报（区分力的核心）', () => {
  const r = run(write('normal.txt', NORMAL));
  assert.strictEqual(r.code, 0, '正常公文却报项：' +
    JSON.stringify((r.json && r.json.issues || []).map((i) => i.code)));
  assert.strictEqual(r.json.passed, true);
});

test('机器味公文必须被抓到', () => {
  const r = run(write('machine.txt', MACHINE));
  assert.strictEqual(r.code, 1, '机器味却放行');
  assert.ok(r.json.issues.length >= 3, '命中过少：' + r.json.issues.length);
});

test('三句同构必须被识别（含顿号并列型）', () => {
  const r = run(write('iso.txt', MACHINE));
  const codes = r.json.issues.map((i) => i.code);
  assert.ok(codes.includes('ISO_TRIPLE'),
    '未识别三句同构，实际：' + codes.join(','));
});

test('等长并列必须被识别', () => {
  const r = run(write('eq.txt', MACHINE));
  const codes = r.json.issues.map((i) => i.code);
  assert.ok(codes.includes('EQUAL_PARALLEL'), '未识别等长并列，实际：' + codes.join(','));
});

// ------------------------------------------------------------------ 豁免
test('「一是/二是/三是」规范列举不误报为同构', () => {
  const text = NORMAL; // 第 4 段正是序数列举
  const r = run(write('ordinal.txt', text));
  const bad = (r.json.issues || []).filter((i) =>
    /一是|二是|三是/.test(i.excerpt || ''));
  assert.strictEqual(bad.length, 0, '序数列举被误报：' + JSON.stringify(bad.map((b) => b.code)));
});

test('含「（一）（二）」层次标题不误报', () => {
  // 注：脚本对不足 100 汉字的输入按设计返回 2，故此处须补足长度
  const text = [
    '一、总体要求', '',
    '（一）压实责任。各区县于11月30日前完成辖区内水库、堤防、地灾隐患点的全面排查，市应急局负责汇总台账。',
    '', '（二）健全机制。市住建局牵头建立月度调度制度，每月5日前通报各区县进展，逾期未报的予以通报。',
    '', '（三）强化督办。市安委办对逾期未完成的单位约谈主要负责人，并将整改情况纳入年度安全生产考核。',
  ].join('\n');
  const r = run(write('headings.txt', text));
  const iso = (r.json.issues || []).filter((i) => i.code.startsWith('ISO_'));
  assert.strictEqual(iso.length, 0, '层次标题被误报：' + JSON.stringify(iso.map((i) => i.excerpt)));
});

// ------------------------------------------------------------------ 边界
test('文本过短时明确拒绝并返回 2', () => {
  const r = run(write('short.txt', '通知\n\n一、甲\n'));
  assert.strictEqual(r.code, 2, '过短文本应 exit 2，实际 ' + r.code);
  assert.ok(/不足|无意义/.test(r.stderr), '未给出明确原因：' + r.stderr);
});

test('--help 返回 0，缺参数返回 2', () => {
  const h = spawnSync(process.execPath, [SCRIPT, '--help'], { encoding: 'utf8' });
  assert.strictEqual(h.status, 0);
  const n = spawnSync(process.execPath, [SCRIPT], { encoding: 'utf8' });
  assert.strictEqual(n.status, 2);
});

test('输出的阈值与该脚本内置基线一致（防文档与代码漂移）', () => {
  const r = run(write('baseline.txt', NORMAL));
  assert.ok(r.json.baseline, '未输出 baseline');
  assert.strictEqual(typeof r.json.baseline.CV_MIN, 'number');
  // 公文基线必须显著低于网文基线 0.55，否则说明抄了通用阈值
  assert.ok(r.json.baseline.CV_MIN < 0.2,
    'CV_MIN=' + r.json.baseline.CV_MIN + ' 偏大，疑沿用网文阈值');
});

// ------------------------------------------------------------------ 汇总
console.log('\n' + '='.repeat(56));
console.log('句式节奏回归：通过 ' + passed + ' / 失败 ' + failed);
if (failed) failures.forEach((f) => console.log('  - ' + f));
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) { /* ignore */ }
process.exitCode = failed ? 1 : 0;
