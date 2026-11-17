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

// ------------------------------------------------- v0.8.0 占位符判据（G4a）
// 历史缺陷：结构检查只认 `YYYY年M月D日` 数字形态，而报错文案却要求"未提供时用
// 【待补：成文日期】占位"——照做反而被判 STRUCT_DATE 不通过。以下用例锁住闭环。

test('日期用【待补：成文日期】占位时不判缺项（曾报 STRUCT_DATE）', () => {
  const text = GOOD.replace('2026年11月15日', '【待补：成文日期】');
  const r = check(write('ph-date.txt', text));
  assert.strictEqual(r.json.issues.filter((i) => i.code === 'STRUCT_DATE').length, 0,
    JSON.stringify(r.json.issues));
});

test('【待核：成文日期】与【待补】同等待遇', () => {
  const text = GOOD.replace('2026年11月15日', '【待核：成文日期】');
  const r = check(write('ph-date-check.txt', text));
  assert.strictEqual(r.json.issues.filter((i) => i.code === 'STRUCT_DATE').length, 0,
    JSON.stringify(r.json.issues));
});

test('署名用【待补：发文机关署名】占位时不判"不像署名"', () => {
  const text = GOOD.replace('××市人民政府', '【待补：发文机关署名】');
  const r = check(write('ph-sig.txt', text));
  assert.strictEqual(r.json.issues.filter((i) => i.code === 'STRUCT_SIGNATURE').length, 0,
    JSON.stringify(r.json.issues));
});

test('主送用【待补：主送机关】占位（不带冒号）时不判缺项', () => {
  const text = GOOD.replace('各区县人民政府：', '【待补：主送机关】');
  const r = check(write('ph-rec.txt', text));
  assert.strictEqual(r.json.issues.filter((i) => i.code === 'STRUCT_RECIPIENT').length, 0,
    JSON.stringify(r.json.issues));
});

test('署名与日期同为占位、且顺序颠倒时仍不判缺项', () => {
  const text = GOOD.replace('××市人民政府\n\n2026年11月15日',
    '【待补：成文日期】\n\n【待补：发文机关署名】');
  const r = check(write('ph-both.txt', text));
  const structs = r.json.issues.filter((i) => i.code === 'STRUCT_DATE' || i.code === 'STRUCT_SIGNATURE');
  assert.strictEqual(structs.length, 0, JSON.stringify(r.json.issues));
});

test('占位不等于通过：占位稿仍 exit 1 并报 PLACEHOLDER', () => {
  const text = GOOD.replace('2026年11月15日', '【待补：成文日期】');
  const r = check(write('ph-still-pending.txt', text));
  assert.strictEqual(r.code, 1, '占位稿应仍为待处理');
  assert.ok(r.json.issues.some((i) => i.code === 'PLACEHOLDER'), JSON.stringify(r.json.issues));
});

test('与正文混排的占位不享受豁免（仍判缺项）', () => {
  const text = GOOD.replace('2026年11月15日', '为做好工作。【待补：成文日期】');
  const r = check(write('ph-inline.txt', text));
  assert.ok(r.json.issues.some((i) => i.code === 'STRUCT_DATE'), JSON.stringify(r.json.issues));
});

test('导语「如下：」不得顶替主送机关（曾漏报 STRUCT_RECIPIENT）', () => {
  const text = GOOD.replace('各区县人民政府：\n\n', '')
    .replace('现就有关事项通知如下。', '现就有关事项通知如下：');
  const r = check(write('lead-colon.txt', text));
  assert.ok(r.json.issues.some((i) => i.code === 'STRUCT_RECIPIENT'), JSON.stringify(r.json.issues));
});

test('DOCX 侧：日期占位不报 ELEMENT_DATE/ELEMENT_SIGNATURE，改报 ELEMENT_PENDING', () => {
  const text = GOOD.replace('2026年11月15日', '【待补：成文日期】');
  const src = write('ph-export.txt', text);
  const out = path.join(TMP, 'ph-export.docx');
  const ex = spawnSync(process.execPath, [EXPORT, src, out], { encoding: 'utf8' });
  assert.strictEqual(ex.status, 0, 'export 失败：' + ex.stderr);
  const an = spawnSync(process.execPath,
    [path.join(ROOT, 'scripts', 'format_docx.js'), 'analyze', out, '--json'], { encoding: 'utf8' });
  let j = null;
  try { j = JSON.parse(an.stdout); } catch (e) { /* ignore */ }
  assert.ok(j, 'analyze 未输出 JSON：' + an.stderr);
  const codes = j.issues.map((i) => i.code);
  assert.ok(!codes.includes('ELEMENT_DATE'), '仍报 ELEMENT_DATE：' + JSON.stringify(codes));
  assert.ok(!codes.includes('ELEMENT_SIGNATURE'), '仍报 ELEMENT_SIGNATURE：' + JSON.stringify(codes));
  assert.ok(codes.includes('ELEMENT_PENDING'), '未报 ELEMENT_PENDING：' + JSON.stringify(codes));
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

// --------------------------------------- v0.7.0 X 级清单与节奏检测
test('X 级已否决清单存在且被 G6 引用（防孤儿）', () => {
  const lang = fs.readFileSync(path.join(ROOT, 'references', '06-language.md'), 'utf8');
  const review = fs.readFileSync(path.join(ROOT, 'references', '07-review.md'), 'utf8');
  assert.ok(/## 十二、X 级已否决/.test(lang), '06-language 缺 X 级章节');
  assert.ok(/X 级已否决/.test(review), '07-review 未引用 X 级（会成为孤儿）');
});

test('X 级清单覆盖四类不该删的写法', () => {
  const lang = fs.readFileSync(path.join(ROOT, 'references', '06-language.md'), 'utf8');
  const sec = lang.split('## 十二、X 级已否决')[1] || '';
  ['总评句', '表态句', '序数', '结语'].forEach((k) => {
    assert.ok(sec.includes(k), 'X 级清单缺「' + k + '」');
  });
});

test('check_rhythm.js 已被资源索引登记', () => {
  const skill = fs.readFileSync(path.join(ROOT, 'SKILL.md'), 'utf8');
  assert.ok(/check_rhythm\.js/.test(skill), 'SKILL 资源索引未登记 check_rhythm.js');
});

test('节奏检测阈值不沿用网文基线（CV_MIN 须 <0.2）', () => {
  const { spawnSync } = require('child_process');
  const tmp = path.join(TMP, 'cv.txt');
  // GOOD 仅约 110 汉字，节奏脚本要求 >=100 才跑；这里用足量文本确保进入分析分支
  fs.writeFileSync(tmp, [GOOD, GOOD, GOOD].join('\n\n'), 'utf8');
  const r = spawnSync(process.execPath,
    [path.join(ROOT, 'scripts', 'check_rhythm.js'), tmp, '--json'], { encoding: 'utf8' });
  let j = null;
  try { j = JSON.parse(r.stdout); } catch (e) { /* ignore */ }
  assert.ok(j && j.baseline, '未输出 baseline');
  assert.ok(j.baseline.CV_MIN < 0.2,
    'CV_MIN=' + j.baseline.CV_MIN + ' 偏大，疑沿用网文阈值 0.55');
});

// ------------------------------------------------- v0.8.0 排版工序 / 梦境（文档判据）
// 这两条是流程规则，没有运行时钩子；用文档一致性用例锁住，防止下一版又把口子开回去。

test('S5 排版为固定工序，顺序为 export → smart', () => {
  const skill = fs.readFileSync(path.join(ROOT, 'SKILL.md'), 'utf8');
  const stages = fs.readFileSync(path.join(ROOT, 'references', '00-stages.md'), 'utf8');
  assert.ok(/S5 固定工序/.test(skill), 'SKILL 未把排版写成 S5 固定工序');
  assert.ok(/不再征求同意/.test(skill), 'SKILL 未声明不再征求同意');
  const s5 = stages.slice(stages.indexOf('## S5 交付'), stages.indexOf('## S6'));
  const iExport = s5.indexOf('export_docx.js');
  const iSmart = s5.indexOf('format_docx.js smart');
  assert.ok(iExport > 0 && iSmart > 0, 'S5 未同时包含 export 与 smart：' + [iExport, iSmart]);
  assert.ok(iExport < iSmart, 'S5 顺序错误：应先导出再排版');
});

test('旧的「问一句等同意」话术已移除', () => {
  const skill = fs.readFileSync(path.join(ROOT, 'SKILL.md'), 'utf8');
  assert.ok(!/回一句「排版」即可/.test(skill), '仍保留"回一句排版即可"话术');
  assert.ok(!/用户未同意前不得执行/.test(skill), '仍保留"未同意前不得执行"的禁令');
});

test('梦境不得留「或」字逃生口', () => {
  const skill = fs.readFileSync(path.join(ROOT, 'SKILL.md'), 'utf8');
  assert.ok(!/或已写明哪一问未过/.test(skill), '检查清单仍可"说明一句"就免除写入');
  assert.ok(/不得只写/.test(skill), '检查清单未禁止"无可沉淀"式结案');
});

test('入库四问已替代「非孤例」门槛', () => {
  const exp = fs.readFileSync(path.join(ROOT, 'references', '13-experience.md'), 'utf8');
  assert.ok(/非抄书/.test(exp), '四问未改为 可脱离/可判定/有出处/非抄书');
  assert.ok(!/非孤例/.test(exp), '仍保留"非孤例"门槛（首次经验无法入库）');
  assert.ok(/首次即可入库|首次出现/.test(exp), '未声明首次即可入库');
});

test('经验写入不等用户确认，记忆文件仍须确认', () => {
  const stages = fs.readFileSync(path.join(ROOT, 'references', '00-stages.md'), 'utf8');
  const s6 = stages.slice(stages.indexOf('## S6 记忆沉淀'));
  assert.ok(/不等用户确认/.test(s6), 'S6 未写明经验条目不等待确认');
  assert.ok(/记忆文件/.test(s6) && /请用户确认/.test(s6), 'S6 未区分记忆文件仍需确认');
});

// ------------------------------------------------- v0.8.1 文种分流（P0）
// 旧实现把所有文体都按"通知形态"判：公告/通告/公报/决议/纪要/命令无主送被判 error，
// 8 类事务材料因标题不含法定文种名被判 STRUCT_TITLE error。23 类里 13 类被误判阻断。

test('13 类曾被误判阻断的文体必须通过结构检查', () => {
  const cases = [
    ['公告', '关于公布清理结果的公告\n\n根据安排，现将结果公布如下：\n\n一、继续有效\n共120件。\n\nXX市人民政府\n2026年11月15日\n'],
    ['通告', '关于开展道路施工的通告\n\n为保障施工，现将有关事项通告如下：\n\n一、施工时间\n2026年11月20日至12月20日。\n\nXX市人民政府\n2026年11月15日\n'],
    ['公报', '中国共产党XX市第八届委员会第五次全体会议公报\n\n2026年11月15日\n\n全会审议通过了有关决定。\n'],
    ['决议', '关于批准2026年预算的决议\n\nXX市第十六届人民代表大会第四次会议审议了预算草案。\n\n会议决定批准该预算。\n\nXX市人民代表大会\n2026年11月15日\n'],
    ['纪要', '全市安全生产工作会议纪要\n\n2026年11月15日，市政府召开全市安全生产工作会议。\n\n一、会议认为\n形势总体平稳。\n'],
    ['命令', 'XX市人民政府令\n\n第15号\n\n《XX市安全生产管理办法》现予公布。\n\n市长：XXX\n2026年11月15日\n'],
    ['总结', 'XX市应急管理局2026年安全生产工作总结\n\n2026年，我局认真落实上级部署。\n\n一、主要做法\n逐级签订责任书。\n\nXX市应急管理局\n2026年11月15日\n'],
    ['讲话', '在全市安全生产工作会议上的讲话\n\n同志们：\n\n今天召开这次会议，主要任务是分析形势、部署工作。\n\n一、认清形势\n总体平稳。\n'],
    ['方案', '关于开展专项整治三年行动的工作方案\n\n为落实上级部署，制定本方案。\n\n一、总体要求\n坚持问题导向。\n\nXX市应急管理局\n2026年11月15日\n'],
    ['述职', '2026年度抓基层党建工作述职报告\n\n一、履职情况\n认真履行第一责任人职责。\n\nXX市应急管理局党组书记 XXX\n2026年11月15日\n'],
    ['经验材料', '坚持三个聚焦 推动形势持续向好\n——XX市应急管理局经验做法\n\n一、聚焦责任落实\n逐级签订责任书。\n'],
    ['汇报', '关于第三季度安全生产工作情况的汇报\n\n为落实上级部署，现将有关情况汇报如下：\n\n一、主要工作\n开展专项整治。\n\nXX市应急管理局\n2026年11月15日\n'],
    ['会议材料', '全市安全生产工作会议议题说明\n\n一、议题背景\n当前形势需要专题研究。\n\n二、建议事项\n请会议审议。\n'],
  ];
  cases.forEach(([name, text]) => {
    const r = check(write('genre-' + name + '.txt', text));
    const bad = (r.json.issues || []).filter((i) => i.severity === 'error');
    assert.strictEqual(bad.length, 0, name + ' 仍报 error：' + JSON.stringify(bad));
  });
});

test('事务材料可用 --type 显式声明（标题不含文种名时）', () => {
  const text = '几个不规范的标题\n\n一、甲\n认真组织。\n\n二、乙\n抓好落实。\n';
  const inferred = check(write('affair-infer.txt', text));
  assert.ok(inferred.json.issues.some((i) => i.code === 'STRUCT_TITLE'), '未加 --type 时应从严');
  const declared = check(write('affair-declared.txt', text), ['--type', '总结']);
  assert.ok(!declared.json.issues.some((i) => i.code === 'STRUCT_TITLE'), '--type 总结 后不应再判标题');
});

test('--type 非法值返回 2', () => {
  const r = check(write('badtype.txt', GOOD), ['--type', '火星文']);
  assert.strictEqual(r.code, 2, '非法文体应 exit 2，实际 ' + r.code);
});

test('主送机关半角冒号必须被拦（曾 0 issues 通过）', () => {
  const text = GOOD.replace('各区县人民政府：', '各区县人民政府:');
  const r = check(write('half-colon.txt', text));
  assert.ok(r.json.issues.some((i) => i.code === 'RECIPIENT_COLON_HALF'), JSON.stringify(r.json.issues));
});

test('结语判据文本层与版式层同口径（特此函达／以上请示，请批示／以上意见请批转）', () => {
  const variants = [
    ['函', '关于商请协助的函\n\n市交通运输局：\n\n因工作需要，请贵局协助。\n\n特此函达。\n\nXX市应急管理局\n2026年11月15日\n'],
    ['请示', '关于申请经费的请示\n\n市财政局：\n\n拟申请经费50万元。\n\n以上请示，请批示。\n\nXX市应急管理局\n2026年11月15日\n'],
    ['意见', '关于加强工作的意见\n\n各区县人民政府：\n\n现提出如下意见。\n\n以上意见，如无不妥，请批转执行。\n\nXX市应急管理局\n2026年11月15日\n'],
  ];
  variants.forEach(([name, text]) => {
    const r = check(write('closing-' + name + '.txt', text));
    assert.ok(!r.json.issues.some((i) => i.code === 'STRUCT_CLOSING'),
      name + ' 仍误报缺结语：' + JSON.stringify(r.json.issues));
  });
});

test('事务材料的 DOCX 不再误报 ELEMENT_DATE／ELEMENT_SIGNATURE', () => {
  const text = '在全市安全生产工作会议上的讲话\n\n同志们：\n\n今天召开这次会议，主要任务是分析形势、部署工作。\n\n一、认清形势\n总体平稳。\n';
  const src = write('affair-docx.txt', text);
  const out = path.join(TMP, 'affair.docx');
  const ex = spawnSync(process.execPath, [EXPORT, src, out], { encoding: 'utf8' });
  assert.strictEqual(ex.status, 0, 'export 失败：' + ex.stderr);
  const an = spawnSync(process.execPath,
    [path.join(ROOT, 'scripts', 'format_docx.js'), 'analyze', out, '--json'], { encoding: 'utf8' });
  let j = null;
  try { j = JSON.parse(an.stdout); } catch (e) { /* ignore */ }
  assert.ok(j, 'analyze 未输出 JSON：' + an.stderr);
  const codes = j.issues.map((i) => i.code);
  assert.ok(!codes.includes('ELEMENT_DATE'), '仍报 ELEMENT_DATE：' + codes);
  assert.ok(!codes.includes('ELEMENT_SIGNATURE'), '仍报 ELEMENT_SIGNATURE：' + codes);
});

// ------------------------------------------------- v0.8.1 机检码覆盖（补 45 个零断言码）
test('check_format 各检查码按预期触发（表驱动）', () => {
  const cases = [
    ['DATE_CN_YEAR', (t) => t.replace('2026年11月15日', '二〇二六年十一月十五日')],
    ['DATE_ZERO_MONTH', (t) => t.replace('2026年11月15日', '2026年01月15日')],
    ['DATE_ZERO_DAY', (t) => t.replace('2026年11月15日', '2026年11月05日')],
    ['DATE_HAO', (t) => t.replace('2026年11月15日', '2026年11月15号')],
    ['DATE_SEPARATOR', (t) => t.replace('2026年11月15日', '2026.11.15')],
    ['DOC_NO_BRACKET', () => '关于开展检查的通知\n\n（2026）1号\n\n各区县人民政府：\n\n为做好工作，现通知如下：\n\n一、要求\n认真组织。\n\n特此通知。\n\nXX市人民政府\n2026年11月15日\n'],
    ['DOC_NO_DI', () => '关于开展检查的通知\n\nXX〔2026〕第1号\n\n各区县人民政府：\n\n为做好工作，现通知如下：\n\n特此通知。\n\nXX市人民政府\n2026年11月15日\n'],
    ['DOC_NO_ZERO', () => '关于开展检查的通知\n\nXX〔2026〕01号\n\n各区县人民政府：\n\n为做好工作，现通知如下：\n\n特此通知。\n\nXX市人民政府\n2026年11月15日\n'],
    ['PUNCT_EXCLAIM', (t) => t.replace('请认真贯彻执行。', '请认真贯彻执行！')],
    ['PUNCT_REPEAT', (t) => t.replace('特此通知。', '特此通知。。')],
    ['RANGE_TILDE', (t) => t.replace('请认真贯彻执行。', '11月20~21日完成整改。')],
    ['THEME_WORD', (t) => t.replace('特此通知。', '主题词：安全 检查')],
    ['NO_BODY_TEXT', (t) => t.replace('特此通知。', '（此页无正文）')],
    ['DOC_TYPE_MIX', (t) => t.replace('关于做好汛期安全隐患排查工作的通知', '关于汛期排查的请示报告')],
    ['COPY_REPORT', (t) => t.replace('特此通知。', '抄报：市政府。')],
    ['ATTACH_COLON_HALF', (t) => t.replace('特此通知。', '附件:1.检查表')],
    ['SERIAL_HANJU', (t) => t.replace('一、总体要求', '一.总体要求')],
    ['SERIAL_HALF_PAREN', (t) => t.replace('（一）压实责任。', '(一)压实责任。')],
    ['REPORT_ENDING', () => '关于工作情况的报告\n\n市人民政府：\n\n现将情况报告如下：\n\n一、总体情况\n平稳。\n\n妥否，请批示。\n\nXX市应急管理局\n2026年11月15日\n'],
    ['HEADING_START', () => '关于开展检查的通知\n\n各区县人民政府：\n\n为做好工作，现通知如下：\n\n（一）具体要求\n认真组织。\n\n特此通知。\n\nXX市人民政府\n2026年11月15日\n'],
  ];
  cases.forEach(([code, mutate]) => {
    const text = mutate(GOOD);
    const r = check(write('cov-' + code + '.txt', text));
    const codes = (r.json && r.json.issues || []).map((i) => i.code);
    assert.ok(codes.includes(code), code + ' 未触发，实际：' + JSON.stringify(codes));
  });
  const max = check(write('cov-max.txt', GOOD), ['--max-chars', '10']);
  assert.ok((max.json.issues || []).some((i) => i.code === 'MAX_CHARS'), 'MAX_CHARS 未触发');
  const empty = check(write('cov-empty.txt', '\n\n'));
  assert.ok((empty.json.issues || []).some((i) => i.code === 'STRUCT_EMPTY'), 'STRUCT_EMPTY 未触发');
});

// ------------------------------------------------------------------ 汇总
console.log('\n' + '='.repeat(56));
console.log('门禁有效性回归：通过 ' + passed + ' / 失败 ' + failed);
if (failed) failures.forEach((f) => console.log('  - ' + f));
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) { /* ignore */ }
process.exitCode = failed ? 1 : 0;
