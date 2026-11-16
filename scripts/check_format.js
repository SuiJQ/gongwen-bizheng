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
  const result = { file: null, json: false, maxChars: null, help: false, error: '' };
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