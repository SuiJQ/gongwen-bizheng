#!/usr/bin/env node
/**
 * 公文文本层格式机检（可选，零第三方依赖）。
 *
 * 支持输入：.txt / .md / .docx（DOCX 由 docformat/zip 读取，与 format_docx 同一套防护：
 * CRC-32 校验、ZIP64 拒绝、单条目解压上限）。
 * 只检查可从纯文本判定的项目；字体、字号、页边距、印章位置需 DOCX 或人工核对。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { readZip } = require('./docformat/zip');

const HELP = `用法: node check_format.js <文件> [--json] [--max-chars N]

文件格式: .txt / .md / .docx（.docx 自动解包 word/document.xml）
选项:
  --json          输出 JSON 到 stdout
  --max-chars N   非空白字符数上限（注意：不是 Word“字数”）
  --no-structure  跳过结构要素检查（标题/主送/日期/落款/结语）
  -h, --help      显示本帮助

退出码: 0 通过；1 有待处理项；2 参数或读取错误。
字数口径: 非空白字符数（汉字、字母、数字、标点各计 1），不等于 Word 字数。
`;

const PLACEHOLDERS = [
  '【待补', '【待核', '【待核对原文', '【未知', '【版式未核',
  '[已核', '[假设', '[未知', '[未核', '[待核', '[待向', '[版式未核',
  'TODO', 'TBD',
];

const LINE_CHECKS = [
  { code: 'SERIAL_DUNHAO', re: /^\s*\d+、/, msg: '层级序数应为“1.”（下脚点），不是“1、”' },
  { code: 'SERIAL_HANJU', re: /^\s*[一二三四五六七八九十]+[.．]/, msg: '第一层序数应为“一、”（顿号），不是“一.”或“一．”' },
  { code: 'SERIAL_PAREN_PUNCT', re: /^\s*（[一二三四五六七八九十]+）[、.．]/, msg: '“（一）”后不应加顿号或点' },
  { code: 'SERIAL_HALF_PAREN', re: /^\s*\([一二三四五六七八九十]+\)/, msg: '序号括号应为全角“（一）”' },
  { code: 'DATE_CN_YEAR', re: /[〇零一二三四五六七八九]{4}年/, msg: '成文日期应用阿拉伯数字，不用汉字年份' },
  { code: 'DATE_ZERO_MONTH', re: /20\d{2}年0\d月/, msg: '成文日期月份不编虚位（如 1 月，不写 01 月）' },
  { code: 'DATE_ZERO_DAY', re: /月0\d日/, msg: '成文日期日不编虚位（如 5 日，不写 05 日）' },
  { code: 'DATE_HAO', re: /20\d{2}年\d{1,2}月\d{1,2}号/, msg: '成文日期用“日”，不用“号”' },
  { code: 'DATE_SEPARATOR', re: /20\d{2}[./]\d{1,2}[./]\d{1,2}/, msg: '成文日期应写为“2026年11月15日”' },
  { code: 'DOC_NO_BRACKET', re: /[\[【（(]\s*20\d{2}\s*[\]】）)]\s*\d+号/, msg: '发文字号年份应使用六角括号〔〕' },
  { code: 'DOC_NO_DI', re: /〔20\d{2}〕第\d+号/, msg: '发文字号顺序号不加“第”' },
  { code: 'DOC_NO_ZERO', re: /〔20\d{2}〕0\d+号/, msg: '发文字号顺序号不编虚位' },
  { code: 'PUNCT_EXCLAIM', re: /[！？]/, msg: '公文中避免感叹号与反问号' },
  { code: 'PUNCT_REPEAT', re: /[，。；：]{2,}/, msg: '存在重复标点' },
  { code: 'RANGE_TILDE', re: /\d\s*~\s*\d/, msg: '数值范围建议用“至”、一字线或“～”，不要用半角“~”' },
  { code: 'THEME_WORD', re: /主题词/, msg: '2012 版已取消主题词' },
  { code: 'NO_BODY_TEXT', re: /此页无正文/, msg: '2012 版不再标注“此页无正文”，应调整行距字距' },
  { code: 'DOC_TYPE_MIX', re: /请示报告/, msg: '“请示报告”不是合法文种，应拆分' },
  { code: 'COPY_REPORT', re: /抄报/, msg: '统一使用“抄送”，不用“抄报”' },
  { code: 'ATTACH_COLON_HALF', re: /^附件\s*:/, msg: '附件说明应使用全角冒号“附件：”' },
];

const CN_DIGITS = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };

function decodeXml(text) {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

function docxToText(file) {
  // 统一使用 docformat/zip 的读取器：带 CRC-32 校验、ZIP64 拒绝、解压上限，
  // 避免与 format_docx 出现两套读取行为（v0.4.4 前 check_format 自带一套无校验实现）。
  const { entries } = readZip(fs.readFileSync(file));
  const part = entries.get('word/document.xml');
  if (!part) throw new Error('DOCX 中未找到 word/document.xml');
  return decodeXml(
    part.data.toString('utf8')
      .replace(/<w:tab[^>]*\/>/g, '\t')
      .replace(/<w:br[^>]*\/>/g, '\n')
      .replace(/<\/w:p>/g, '\n')
      .replace(/<\/w:tc>/g, '\t')
      .replace(/<[^>]+>/g, '')
  );
}

function headingLevel(line) {
  if (/^[一二三四五六七八九十]+、/.test(line)) return 1;
  if (/^（[一二三四五六七八九十]+）/.test(line)) return 2;
  if (/^\d+\.(?!\d)/.test(line)) return 3;
  if (/^（\d+）/.test(line)) return 4;
  return 0;
}

function headingValue(line, level) {
  let match;
  if (level === 1) {
    match = line.match(/^([一二三四五六七八九十]+)、/);
    return match ? cnToInt(match[1]) : 0;
  }
  if (level === 2) {
    match = line.match(/^（([一二三四五六七八九十]+)）/);
    return match ? cnToInt(match[1]) : 0;
  }
  if (level === 3) {
    match = line.match(/^(\d+)\.(?!\d)/);
    return match ? Number.parseInt(match[1], 10) : 0;
  }
  if (level === 4) {
    match = line.match(/^（(\d+)）/);
    return match ? Number.parseInt(match[1], 10) : 0;
  }
  return 0;
}

function cnToInt(token) {
  if (/^\d+$/.test(token)) return Number.parseInt(token, 10);
  if (token === '十') return 10;
  if (token.includes('十')) {
    const parts = token.split('十');
    const tens = parts[0] ? CN_DIGITS[parts[0]] : 1;
    const ones = parts[1] ? CN_DIGITS[parts[1]] : 0;
    return tens * 10 + ones;
  }
  return CN_DIGITS[token] || 0;
}

function plausibleHeading(line) {
  return line.length <= 40 && !/[。；，]$/.test(line);
}

function parseArgs(argv) {
  const result = { file: null, json: false, maxChars: null, noStructure: false, help: false, error: '' };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '-h' || arg === '--help') {
      result.help = true;
      continue;
    }
    if (arg === '--json') {
      result.json = true;
      continue;
    }
    if (arg === '--no-structure') {
      result.noStructure = true;
      continue;
    }
    if (arg === '--max-chars') {
      const value = argv[i + 1];
      i += 1;
      if (value === undefined || !/^\d+$/.test(value) || Number(value) <= 0) {
        result.error = '--max-chars 需要一个正整数';
        continue;
      }
      result.maxChars = Number.parseInt(value, 10);
      continue;
    }
    if (arg.startsWith('-')) {
      result.error = '未知参数：' + arg;
      continue;
    }
    if (!result.file) result.file = arg;
  }
  return result;
}

function scanLines(text, isMarkdown) {
  const issues = [];
  const lines = text.split(/\r?\n/);
  const firstContent = lines.find((line) => line.trim()) || '';
  const isReport = /报告/.test(firstContent);
  const lastValue = [0, 0, 0, 0, 0];
  let firstHeadingSeen = false;

  lines.forEach((raw, index) => {
    let line = raw;
    if (isMarkdown) line = line.replace(/^#{1,6}\s+/, '');
    line = line.trim();
    if (!line) return;
    const lineno = index + 1;

    PLACEHOLDERS.forEach((marker) => {
      if (line.includes(marker)) {
        issues.push({ line: lineno, code: 'PLACEHOLDER', severity: 'warn', message: '存在占位符或未处理标注：' + marker });
      }
    });

    LINE_CHECKS.forEach((checkItem) => {
      if (checkItem.re.test(line)) {
        issues.push({ line: lineno, code: checkItem.code, severity: 'error', message: checkItem.msg });
      }
    });

    if (isReport && /请(批示|批复)/.test(line)) {
      issues.push({ line: lineno, code: 'REPORT_ENDING', severity: 'error', message: '报告结尾不得使用请示结语，应改“特此报告”' });
    }

    const level = headingLevel(line);
    if (level > 0 && plausibleHeading(line)) {
      const value = headingValue(line, level);
      if (!firstHeadingSeen && level > 1) {
        issues.push({ line: lineno, code: 'HEADING_START', severity: 'warn', message: '首个层级序数为第 ' + level + ' 层，建议从“一、”开始或确认是否为片段' });
      }
      firstHeadingSeen = true;

      if (lastValue[level] > 0 && value > 0 && value !== lastValue[level] + 1) {
        issues.push({
          line: lineno,
          code: 'SERIAL_GAP',
          severity: 'warn',
          message: '第 ' + level + ' 层级序号不连续：上一项为 ' + lastValue[level] + '，本项为 ' + value,
        });
      }
      if (value > 0) lastValue[level] = value;
      for (let deeper = level + 1; deeper <= 4; deeper += 1) lastValue[deeper] = 0;
    }
  });

  return { issues, chars: text.replace(/\s/g, '').length };
}

/**
 * 结构要素存在性检查（v0.6.3 新增）。
 *
 * 动因：v0.6.2 及以前，一份「无落款、无日期」的通知甚至只有五个字的稿子
 * 都能通过 check_format（passed:true, exit 0）。而 SKILL.md 检查清单把
 * 「退出码 0」直接写成「G4a 通过」——于是「自述已核对」在制度层面被合法化。
 * 本函数补上「要素在不在」的底线判断，让 exit 0 真正意味着有东西可查。
 *
 * 判定口径：
 * - 只查"在不在"，不查"写得对不对"（后者归 G4a 内容层与人工）；
 * - 片段补写任务不应直接跑本脚本（S5 已规定），故不设"片段豁免"开关；
 * - 缺项一律 error 级，因为 G4a 是阻断门禁。
 */
function checkStructure(text, isMarkdown) {
  const issues = [];
  const lines = text.split(/\r?\n/).map((l) => (isMarkdown ? l.replace(/^#{1,6}\s+/, '') : l).trim());
  const body = lines.filter(Boolean);
  const chars = text.replace(/\s/g, '').length;

  if (!body.length) {
    issues.push({ line: 0, code: 'STRUCT_EMPTY', severity: 'error', message: '正文为空，无法做任何格式判定' });
    return issues;
  }
  if (chars < 30) {
    issues.push({
      line: 0, code: 'STRUCT_TOO_SHORT', severity: 'error',
      message: '非空白字符仅 ' + chars + ' 个，不足以构成一份公文；请确认是否为片段（片段不适用本脚本）',
    });
  }

  // 1) 标题：首段须含法定文种名
  const legalTypes = ['决议', '决定', '命令', '公报', '公告', '通告', '意见', '通知', '通报',
    '报告', '请示', '批复', '议案', '函', '纪要'];
  const first = body[0] || '';
  const hasType = legalTypes.some((t) => first.endsWith(t) || first.includes(t));
  if (!hasType) {
    issues.push({
      line: 1, code: 'STRUCT_TITLE', severity: 'error',
      message: '首段未含 15 个法定文种名之一，标题三要素（发文机关＋事由＋文种）不成立',
    });
  }

  // 2) 主送机关：须有一段以冒号结尾且不含句末标点
  const hasRecipient = body.some((l, i) => i > 0 && /[：:]\s*$/.test(l) && l.length <= 60 && !/[。！？；]/.test(l));
  if (!hasRecipient) {
    issues.push({
      line: 0, code: 'STRUCT_RECIPIENT', severity: 'error',
      message: '未找到主送机关（应为独立一段、以全角冒号结尾）；公布性文种确实无主送时请人工确认',
    });
  }

  // 3) 成文日期：须有 YYYY年M月D日 形态
  const dateRe = /(19|20)\d{2}\s*年\s*\d{1,2}\s*月\s*\d{1,2}\s*日/;
  const dateLine = body.findIndex((l) => dateRe.test(l));
  if (dateLine < 0) {
    issues.push({
      line: 0, code: 'STRUCT_DATE', severity: 'error',
      message: '未找到成文日期（应形如 2026年11月15日，月日不编虚位）；未提供时应用【待补：成文日期】占位',
    });
  }

  // 4) 落款：日期之前须有一段短语作发文机关署名
  if (dateLine > 0) {
    const prev = body[dateLine - 1];
    const looksSignature = prev && prev.length <= 30 && !/[。；，：！？]$/.test(prev)
      && !/^[（(]/.test(prev) && !/^【/.test(prev);
    if (!looksSignature) {
      issues.push({
        line: 0, code: 'STRUCT_SIGNATURE', severity: 'error',
        message: '成文日期前一段不像发文机关署名（应为短语、无句末标点）',
      });
    }
  }

  // 5) 结语：法定文种通常须有结语（特此通知／妥否请批示／特此报告等）
  const closingRe = /(特此(通知|报告|批复|函告|公告|通告|通报|说明)|此复|妥否[，,]\s*请批示|当否[，,]\s*请批复|请予批复|以上报告[，,]\s*请审阅)/;
  if (!closingRe.test(text)) {
    issues.push({
      line: 0, code: 'STRUCT_CLOSING', severity: 'warn',
      message: '未找到结语（如“特此通知”“妥否，请批示”“特此报告”），请确认与文种匹配',
    });
  }

  return issues;
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
  if (!args.file) {
    process.stderr.write('缺少输入文件。使用 --help 查看用法。\n');
    return 2;
  }

  let text;
  let source = 'text';
  const isDocx = path.extname(args.file).toLowerCase() === '.docx';
  const isMarkdown = /\.(md|markdown)$/i.test(args.file);

  try {
    if (isDocx) {
      text = docxToText(args.file);
      source = 'docx';
    } else {
      text = fs.readFileSync(args.file, 'utf8');
    }
  } catch (error) {
    process.stderr.write('读取失败：' + error.message + '\n');
    return 2;
  }

  const { issues, chars } = scanLines(text, isMarkdown);
  if (!args.noStructure) {
    checkStructure(text, isMarkdown).forEach((i) => issues.push(i));
  }

  if (args.maxChars && chars > args.maxChars) {
    issues.push({
      line: 0,
      code: 'MAX_CHARS',
      severity: 'error',
      message: '非空白字符数 ' + chars + ' 超出上限 ' + args.maxChars,
    });
  }

  issues.sort((a, b) => a.line - b.line);
  const passed = issues.length === 0;

  if (args.json) {
    process.stdout.write(JSON.stringify({ file: args.file, source, chars, passed, issues }, null, 2) + '\n');
  } else {
    process.stdout.write('来源：' + source + '；非空白字符数：' + chars + '\n');
    if (passed) {
      process.stdout.write('文本层格式检查：通过\n');
    } else {
      issues.slice(0, 20).forEach((issue) => {
        process.stdout.write('L' + issue.line + ' [' + issue.code + '][' + issue.severity + ']：' + issue.message + '\n');
      });
      if (issues.length > 20) process.stdout.write('……其余 ' + (issues.length - 20) + ' 项省略\n');
      process.stdout.write('文本层格式检查：' + issues.length + ' 项待处理\n');
    }
    process.stdout.write('注意：G4a 内容层机检不覆盖字体、字号、页边距、印章（G4b），需 DOCX 或人工核对。\n');
  }

  return passed ? 0 : 1;
}

try {
  process.exitCode = main();
} catch (error) {
  process.stderr.write('检查失败：' + error.message + '\n');
  process.exitCode = 2;
}