#!/usr/bin/env node
/**
 * 语言节奏检测（v0.7.0 新增）。
 *
 * 补的是 06-language 的一个结构性缺失：现有规则只给「句长超 50 字就拆」的上限，
 * 完全不管长短起伏与相邻句同构。而公文最常见的机器味形态恰恰是
 * 「各单位要×、要×、要×」式的等长并列三连。
 *
 * 本文件的阈值**按公文体重新标定**，不采用通用网文/科技评论基线：
 * 实测合格公文句长 CV 中位约 0.13，若沿用网文阈值 0.55，会把每一份合格公文
 * 都判成"节奏均匀"。同理，公文层次标题多、顿号密，不做小标题密度与顿号密度检查。
 *
 * 判定三态：hit（命中，须处理）/ note（提示，人工判断）/ clean（未命中）。
 * 本脚本只报告，不改写——改写归 S3/S4 与人工。
 *
 * 用法：
 *   node scripts/check_rhythm.js <文件.md|txt> [--json]
 * 退出码：0 未命中 / 1 有命中 / 2 参数或读取错误
 */
'use strict';

const { readTextWithMeta } = require('./docformat/textio');

const HELP = `用法: node check_rhythm.js <文件.md|txt> [--json]

检测项:
  句长CV        全篇句长的离散系数（公文基线 ≈0.13，低于 0.08 判节奏过匀）
  相邻句同构    连续 2–3 句句法骨架相同（公文最常见机器味形态）
  等长并列      连续 3 句长度几乎相等且各含顿号并列（口号排比的前兆）

选项:
  --json        输出 JSON
  -h, --help    显示本帮助

退出码: 0 未命中；1 有命中；2 参数或读取错误。
说明: 本脚本只检测不改写。阈值按公文体标定，不适用于网文/新闻。`;

/** 公文基线（由 references 与 tests 语料实测标定，见 CHANGELOG 0.7.0） */
const BASELINE = {
  /** 合格公文句长 CV 中位实测 0.127；低于此值视为节奏过匀 */
  CV_MIN: 0.08,
  /** 判"等长"的句长容忍差（汉字数） */
  EQUAL_LEN_TOL: 2,
  /** 参与统计的最短句（汉字数），过短句不参与同构判定 */
  MIN_SENT_HANZI: 8,
};

function hanzi(s) {
  const m = s.match(/[\u4e00-\u9fff]/g);
  return m ? m.length : 0;
}

/** 分句：按公文句末标点切，保留含 4 个以上汉字的片段 */
function splitSentences(paragraph) {
  return paragraph
    .split(/[。！？；]/)
    .map((s) => s.trim())
    .filter((s) => hanzi(s) >= 4);
}

/**
 * 句法骨架签名。
 * 用「逗号数 + 是否含冒号 + 是否含括号 + 长度档」四个维度近似句法结构，
 * 与原研究同构（该组合经两轮实测确认有区分力）；不同处在于长度档按
 * 公文句长分布取 12 而非 15，公文中短句更多。
 */
function signature(sentence) {
  const commas = (sentence.match(/，/g) || []).length;
  // 顿号数必须计入：公文机器味最典型形态是「要X、要Y、要Z」纯顿号并列，
  // 只数逗号会把这类三连同构全部漏掉（v0.7.0 标定时实测发现）。
  const dunhao = (sentence.match(/、/g) || []).length;
  const hasColon = /[：:]/.test(sentence);
  const hasParen = /（|\(/.test(sentence);
  const lenBand = Math.floor(sentence.length / 12);
  return [commas, Math.min(dunhao, 4), hasColon ? 1 : 0, hasParen ? 1 : 0, lenBand].join('|');
}

/**
 * 是否为规范性序数列举。公文里「一是…二是…三是…」是规范写法，
 * 不是机器味（原研究的 X 级清单亦指出序数词人类更常用）。
 */
function isOrdinalItem(sentence) {
  return /^\s*(?:[一二三四五六七八九十]+是|[①②③④⑤⑥⑦⑧⑨⑩]|[（(]\s*[一二三四五六七八九十\d]+\s*[)）])/.test(sentence);
}

function cv(values) {
  if (values.length < 2) return null;
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  if (mean === 0) return null;
  const variance = values.reduce((a, b) => a + (b - mean) ** 2, 0) / values.length;
  return Math.sqrt(variance) / mean;
}

/** 拆段：按空行切，去掉标题/表格/列表/代码/引用等非散文块 */
function splitParagraphs(text) {
  const lines = text.split(/\r?\n/);
  const blocks = [];
  let buf = [];
  let startLine = 0;
  let inFence = false;

  const flush = (endLine) => {
    if (!buf.length) return;
    const body = buf.join('');
    if (hanzi(body) >= 20) blocks.push({ body, startLine, endLine });
    buf = [];
  };

  lines.forEach((raw, i) => {
    const line = raw.trim();
    if (/^```/.test(line)) {
      inFence = !inFence;
      flush(i);
      return;
    }
    if (inFence) return;
    const isProse = line
      && !/^\|/.test(line)
      && !/^#{1,6}\s/.test(line)
      && !/^>/.test(line)
      && !/^[-*+]\s/.test(line)
      && !/^\d+[.、)）]\s/.test(line)
      && !/^【/.test(line)
      && !/^\*\*[^*]{2,40}\*\*$/.test(line);
    if (!isProse) {
      flush(i);
      return;
    }
    if (!buf.length) startLine = i + 1;
    buf.push(line);
  });
  flush(lines.length);
  return blocks;
}

function analyze(text) {
  const blocks = splitParagraphs(text);
  const issues = [];
  const sentLens = [];
  let iso2 = 0;
  let iso3 = 0;
  let equalRuns = 0;

  blocks.forEach((blk) => {
    const sents = splitSentences(blk.body);
    const lens = sents.map(hanzi);
    lens.forEach((l) => sentLens.push(l));

    const usable = sents.filter((s) => hanzi(s) >= BASELINE.MIN_SENT_HANZI);

    // 相邻句同构（2 连与 3 连）
    for (let n = 2; n <= 3; n += 1) {
      for (let i = 0; i <= usable.length - n; i += 1) {
        const group = usable.slice(i, i + n);
        // 全是「一是／二是／（一）」式规范列举 → 豁免，不算机器味
        if (group.every(isOrdinalItem)) continue;
        const sigs = group.map(signature);
        const same = sigs.every((s) => s === sigs[0]);
        if (!same) continue;
        // 至少含 1 个逗号或 2 个顿号才算"有骨架"，避免把极短句误判
        const parts = sigs[0].split('|');
        if ((parts[0] - 0) < 1 && (parts[1] - 0) < 2) continue;
        if (n === 2) iso2 += 1; else iso3 += 1;
        issues.push({
          code: n === 3 ? 'ISO_TRIPLE' : 'ISO_PAIR',
          severity: n === 3 ? 'error' : 'warn',
          line: blk.startLine,
          excerpt: usable.slice(i, i + n).join('／').slice(0, 90),
          message: n === 3
            ? '连续三句句法骨架相同，是公文最典型的机器味形态；打散其中一句（合并、拆分、换语序），不动信息'
            : '连续两句句法骨架相同，建议改其一的结构',
        });
      }
    }

    // 等长并列：连续 3 句长度几乎相等且各含顿号
    for (let i = 0; i <= lens.length - 3; i += 1) {
      const win = lens.slice(i, i + 3);
      const segs = sents.slice(i, i + 3);
      const equal = Math.max(...win) - Math.min(...win) <= BASELINE.EQUAL_LEN_TOL;
      const allDunhao = segs.every((s) => (s.match(/、/g) || []).length >= 2);
      if (segs.every(isOrdinalItem)) continue;
      if (equal && allDunhao && win[0] >= 12) {
        equalRuns += 1;
        issues.push({
          code: 'EQUAL_PARALLEL',
          severity: 'warn',
          line: blk.startLine,
          excerpt: segs.join('／').slice(0, 90),
          message: '连续三句长度几乎相等且各含顿号并列，是口号排比前兆；每句须落到不同主责、时限或对象',
        });
        break; // 同段只报一次，避免刷屏
      }
    }
  });

  const sentCv = cv(sentLens);
  if (sentCv !== null && sentCv < BASELINE.CV_MIN && sentLens.length >= 8) {
    issues.push({
      code: 'SENT_CV_LOW',
      severity: 'warn',
      line: 0,
      excerpt: '句长CV=' + sentCv.toFixed(3),
      message: '全篇句长离散度偏低（公文基线约 0.13，本值 ' + sentCv.toFixed(3) +
        '），句式偏均匀；建议将部分长句拆分、部分短句合并，但不得为"制造参差"而硬改',
    });
  }

  return {
    paragraphs: blocks.length,
    sentences: sentLens.length,
    hanzi: sentLens.reduce((a, b) => a + b, 0),
    metrics: {
      sentCv: sentCv === null ? null : Number(sentCv.toFixed(3)),
      iso2,
      iso3,
      equalRuns,
    },
    baseline: BASELINE,
    issues,
  };
}

function parseArgs(argv) {
  const args = { file: null, json: false, help: false, error: '' };
  argv.forEach((a) => {
    if (a === '-h' || a === '--help') args.help = true;
    else if (a === '--json') args.json = true;
    else if (a.startsWith('-')) args.error = '未知参数：' + a;
    else if (!args.file) args.file = a;
    else args.error = '参数过多：' + a;
  });
  return args;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(HELP + '\n');
    return 0;
  }
  if (args.error) {
    process.stderr.write(args.error + '\n');
    return 2;
  }
  if (!args.file) {
    process.stderr.write('缺少输入文件。使用 --help 查看用法。\n');
    return 2;
  }
  let text;
  try {
    const read = readTextWithMeta(args.file);
    if (read.encoding === 'unknown') {
      process.stderr.write('无法识别文件编码：既不是 UTF-8，也不是 GB18030。请转存为 UTF-8 后重试。\n');
      return 2;
    }
    if (read.encoding === 'gb18030') {
      process.stderr.write('提示：输入不是 UTF-8 编码（已按 GB18030 解码）。\n');
    }
    text = read.text;
  } catch (e) {
    process.stderr.write('读取失败：' + e.message + '\n');
    return 2;
  }
  if (hanzi(text) < 100) {
    process.stderr.write('汉字数不足 100，节奏检测无意义（片段请人工判断）。\n');
    return 2;
  }

  const report = analyze(text);
  report.file = args.file;
  report.passed = report.issues.length === 0;

  if (args.json) {
    process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  } else {
    const m = report.metrics;
    process.stdout.write('文件：' + report.file + '\n');
    process.stdout.write('规模：' + report.paragraphs + ' 段 / ' + report.sentences +
      ' 句 / ' + report.hanzi + ' 汉字\n');
    process.stdout.write('指标：句长CV=' + (m.sentCv === null ? '—' : m.sentCv) +
      '（公文基线 ' + BASELINE.CV_MIN + '）｜两句同构=' + m.iso2 +
      '｜三句同构=' + m.iso3 + '｜等长并列=' + m.equalRuns + '\n');
    if (report.passed) {
      process.stdout.write('节奏检测：通过\n');
    } else {
      process.stdout.write('\n');
      report.issues.forEach((i) => {
        process.stdout.write('[' + (i.severity === 'error' ? '错误' : '提醒') + '] ' +
          i.code + ' L' + i.line + '：' + i.message + '\n');
        if (i.excerpt) process.stdout.write('    ' + i.excerpt + '\n');
      });
      process.stdout.write('\n节奏检测：' + report.issues.length + ' 项待处理\n');
    }
    process.stdout.write('注意：本脚本只检测不改写；阈值按公文体标定，不适用于网文。\n');
  }
  return report.passed ? 0 : 1;
}

try {
  process.exitCode = main();
} catch (error) {
  process.stderr.write('检测失败：' + error.message + '\n');
  process.exitCode = 2;
}