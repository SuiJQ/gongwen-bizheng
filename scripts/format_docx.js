#!/usr/bin/env node
/**
 * 命令行入口。
 *
 * 用法：
 *   node scripts/format_docx.js smart   <输入.docx> <输出.docx>
 *   node scripts/format_docx.js format  <输入.docx> <输出.docx>
 *   node scripts/format_docx.js meta    <输入.docx> <输出.docx>
 *   node scripts/format_docx.js analyze <输入.docx> [--json]
 *
 * 退出码：0 成功；1 诊断存在 error 级问题；2 参数或读写错误。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const api = require('./docformat/index');
const { readText } = require('./docformat/textio');

const HELP = `公文 DOCX 版式修复与元数据清理（纯 Node，无第三方依赖）

用法:
  node scripts/format_docx.js <模式> <输入.docx> [输出.docx] [选项]

模式:
  smart     版式修复 + 元数据清理（推荐）
  format    仅版式修复
  meta      仅元数据清理
  analyze   只读诊断，仅输出报告

选项:
  --preset <name>              预设，默认 official
  --custom-settings <file>     覆盖预设参数的 JSON（可为 {"overrides":{...}} 或直接参数对象）
  --deep-clean                 先清除继承的字体色/下划线/底纹等再排版
  --no-structure               不补结构空行
  --no-dates                   不做日期规范化
  --no-media                   不做媒体段保护
  --no-page-number             不加页码
  --page-number-style <s>      dash（— 1 —）或 plain（1）
  --page-number-position <p>   outside | center | left | right
  --no-metadata                不做元数据清理
  --author <name>              清理后写入的作者名（默认留空）
  --application <name>         Application 字段（默认 Microsoft Office Word）
  --platform <p>               Application 平台判定口径：win32 | darwin | linux（默认跟随本机）
  --keep-thumbnail             保留 docProps/thumbnail.jpeg
  --split-headings             拆分"标题+正文"混排段落
  --json                       analyze 模式输出 JSON
  --force                      允许覆盖已存在的输出文件
  --dry-run                    只计算不写文件
  -h, --help                   显示本帮助

示例:
  node scripts/format_docx.js analyze 来文.docx --json
  node scripts/format_docx.js smart 来文.docx 来文_规范.docx --author 张三 --force
  node scripts/format_docx.js meta 报告.docx 报告_清理.docx --keep-thumbnail
`;

const PLATFORMS = ['win32', 'darwin', 'linux'];

const FLAGS = {
  '--deep-clean': ['deepClean', true],
  '--no-structure': ['structure', false],
  '--no-dates': ['dates', false],
  '--no-media': ['media', false],
  '--no-page-number': ['pageNumber', false],
  '--no-metadata': ['metadata', false],
  '--keep-thumbnail': ['keepThumbnail', true],
  '--split-headings': ['splitHeadings', true],
  '--json': ['json', true],
  '--force': ['force', true],
  '--dry-run': ['dryRun', true],
};

const VALUED = {
  '--preset': 'preset',
  '--custom-settings': 'customSettings',
  '--page-number-style': 'pageNumberStyle',
  '--page-number-position': 'pageNumberPosition',
  '--author': 'author',
  '--application': 'application',
  '--platform': 'platform',
};

function parseArgs(argv) {
  const args = { mode: null, input: null, output: null, help: false, errors: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '-h' || a === '--help') {
      args.help = true;
      continue;
    }
    if (FLAGS[a]) {
      args[FLAGS[a][0]] = FLAGS[a][1];
      continue;
    }
    if (VALUED[a]) {
      const v = argv[i + 1];
      if (v === undefined || v.startsWith('--')) {
        args.errors.push(a + ' 缺少取值');
        continue;
      }
      args[VALUED[a]] = v;
      i += 1;
      continue;
    }
    if (a.startsWith('-')) {
      args.errors.push('未知参数：' + a);
      continue;
    }
    if (!args.mode) args.mode = a;
    else if (!args.input) args.input = a;
    else if (!args.output) args.output = a;
    else args.errors.push('参数过多：' + a);
  }
  return args;
}

function buildOptions(args) {
  const options = {};
  ['deepClean', 'structure', 'dates', 'media', 'pageNumber', 'metadata',
    'keepThumbnail', 'splitHeadings', 'force', 'dryRun'].forEach((k) => {
    if (args[k] !== undefined) options[k] = args[k];
  });
  if (args.preset) options.preset = args.preset;
  if (args.customSettings) {
    // Windows 编辑器另存 JSON 常带 BOM，JSON.parse 会直接抛错，故走统一解码
    const raw = readText(args.customSettings);
    const parsed = JSON.parse(raw);
    options.overrides = parsed.overrides || parsed;
  }
  if (args.pageNumberStyle || args.pageNumberPosition || args.author || args.application) {
    options.metadataOptions = {};
    if (args.author !== undefined) options.metadataOptions.author = args.author;
    if (args.application) options.metadataOptions.application = args.application;
    options.overrides = options.overrides || {};
    options.overrides.pageNumber = options.overrides.pageNumber || {};
    if (args.pageNumberStyle) options.overrides.pageNumber.style = args.pageNumberStyle;
    if (args.pageNumberPosition) options.overrides.pageNumber.position = args.pageNumberPosition;
  }
  if (args.platform) {
    // 平台口径显式化：默认跟随宿主，显式传入时用于复现/回归（不影响本机实际行为）
    if (!PLATFORMS.includes(args.platform)) {
      throw new Error('--platform 只接受 ' + PLATFORMS.join(' / ') + '，收到：' + args.platform);
    }
    options.platform = args.platform;
    options.metadataOptions = options.metadataOptions || {};
    options.metadataOptions.platform = args.platform;
  }
  return options;
}

function printReport(report) {
  const lines = [];
  lines.push('文件：' + report.file);
  lines.push('段落数：' + report.paragraphs);
  if (report.geometry) {
    lines.push('页边距：上 ' + report.geometry.top.toFixed(2) + ' / 下 ' + report.geometry.bottom.toFixed(2) +
      ' / 左 ' + report.geometry.left.toFixed(2) + ' / 右 ' + report.geometry.right.toFixed(2) + ' cm');
  }
  lines.push('段落类型：' + Object.keys(report.typeCounts).map((k) => k + '=' + report.typeCounts[k]).join(' '));
  lines.push('');
  const order = { error: 0, warn: 1, info: 2 };
  const label = { error: '[错误]', warn: '[提醒]', info: '[信息]' };
  report.issues
    .slice()
    .sort((a, b) => order[a.level] - order[b.level])
    .forEach((i) => {
      lines.push(label[i.level] + ' ' + i.code + ' ' + (i.location ? i.location + '：' : '') + i.message);
      if (i.evidence) lines.push('        ' + i.evidence);
    });
  lines.push('');
  lines.push('合计：错误 ' + report.summary.error + ' / 提醒 ' + report.summary.warn + ' / 信息 ' + report.summary.info +
    (report.pass ? '  => 未发现阻断性问题' : '  => 存在需处理的问题'));
  process.stdout.write(lines.join('\n') + '\n');
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  // --help/-h 显式请求帮助返回 0；无参调用属"缺参数"，与另两个脚本统一返回 2
  if (args.help) {
    process.stdout.write(HELP);
    return 0;
  }
  if (!args.mode && process.argv.length <= 2) {
    process.stderr.write(HELP);
    return 2;
  }
  if (args.errors.length) {
    process.stderr.write(args.errors.join('\n') + '\n');
    return 2;
  }
  const modes = ['smart', 'format', 'meta', 'analyze'];
  if (!modes.includes(args.mode)) {
    process.stderr.write('未知模式：' + args.mode + '（可用：' + modes.join(' / ') + '）\n');
    return 2;
  }
  if (!args.input) {
    process.stderr.write('缺少输入文件。使用 --help 查看用法。\n');
    return 2;
  }
  if (!fs.existsSync(args.input)) {
    process.stderr.write('输入文件不存在：' + args.input + '\n');
    return 2;
  }
  if (args.mode !== 'analyze' && !args.output) {
    process.stderr.write('缺少输出文件。使用 --help 查看用法。\n');
    return 2;
  }

  let options;
  try {
    options = buildOptions(args);
  } catch (e) {
    process.stderr.write('选项解析失败：' + e.message + '\n');
    return 2;
  }

  try {
    if (args.mode === 'analyze') {
      const report = api.analyzeFile(args.input, options);
      if (args.json) process.stdout.write(JSON.stringify(report, null, 2) + '\n');
      else printReport(report);
      return report.pass ? 0 : 1;
    }
    if (args.mode === 'meta') {
      const res = api.cleanMetadataFile(args.input, args.output, options);
      printMetaResult(res, args.json);
      return 0;
    }
    const res = api.processFile(args.input, args.output, options);
    printFormatResult(res, args.json, args.mode);
    return 0;
  } catch (error) {
    if (error.code === 'EEXIST_OUTPUT' || error.code === 'ESAME_PATH') {
      process.stderr.write(error.message + '\n');
      return 2;
    }
    process.stderr.write('处理失败：' + error.message + '\n');
    if (process.env.DOCFORMAT_DEBUG) process.stderr.write(error.stack + '\n');
    return 2;
  }
}

function printFormatResult(res, asJson, mode) {
  if (asJson) {
    process.stdout.write(JSON.stringify({
      output: res.output, bytes: res.bytes, dryRun: !!res.dryRun, steps: res.steps,
    }, null, 2) + '\n');
    return;
  }
  if (res.dryRun) {
    process.stdout.write('dry-run：未写入文件。\n');
  } else {
    process.stdout.write('已生成：' + res.output + '（' + res.bytes + ' 字节）\n');
  }
  if (res.steps.paragraphs) {
    const s = res.steps.paragraphs.stats;
    process.stdout.write('段落类型：' + Object.keys(s).map((k) => k + '=' + s[k]).join(' ') + '\n');
  }
  if (res.steps.structure) process.stdout.write('结构空行：补 ' + res.steps.structure.inserted + ' 处\n');
  if (res.steps.dates) process.stdout.write('日期规范化：' + res.steps.dates.count + ' 处\n');
  if (res.steps.media) process.stdout.write('媒体段保护：' + res.steps.media.protected + ' 段\n');
  if (mode === 'smart' && res.steps.metadata) {
    const m = res.steps.metadata;
    process.stdout.write('元数据清理：' + m.changes.length + ' 项\n');
    m.changes.forEach((c) => process.stdout.write('  - [' + c.action + '] ' + c.part + '：' + c.detail + '\n'));
  }
}

function printMetaResult(res, asJson) {
  if (asJson) {
    process.stdout.write(JSON.stringify(res, null, 2) + '\n');
    return;
  }
  if (res.dryRun) {
    process.stdout.write('dry-run：未写入文件。\n');
  } else {
    process.stdout.write('已生成：' + res.output + '\n');
  }
  const m = res.metadata;
  process.stdout.write('元数据清理：' + m.changes.length + ' 项\n');
  m.changes.forEach((c) => process.stdout.write('  - [' + c.action + '] ' + c.part + '：' + c.detail + '\n'));
  if (m.removedParts.length) process.stdout.write('删除部件：' + m.removedParts.join(', ') + '\n');
}

try {
  process.exitCode = main();
} catch (error) {
  process.stderr.write('未捕获异常：' + error.message + '\n');
  process.exitCode = 2;
}
