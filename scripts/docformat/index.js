#!/usr/bin/env node
/**
 * 编排层：把各环节串成对外 API。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { DocxPackage } = require('./docpkg');
const { getPreset, mergePreset } = require('./preset');
const { applyPage, formatParagraphs, stripPageNumberParagraphs } = require('./format');
const { applyStructuralBlanks, splitHeadings, protectMediaParagraphs } = require('./structure');
const { normalizeDates, cleanStyles, documentStats } = require('./clean');
const { cleanMetadata } = require('./meta');
const { diagnose } = require('./diagnose');

const DEFAULT_RUN_OPTIONS = {
  preset: 'official',
  overrides: null,
  deepClean: false,
  structure: true,
  splitHeadings: false,
  dates: true,
  media: true,
  pageNumber: true,
  stripStyles: true,
  metadata: true,
  metadataOptions: null,
  keepThumbnail: false,
};

function resolvePreset(options) {
  const preset = getPreset(options.preset || 'official');
  const merged = mergePreset(preset, options.overrides);
  if (options.pageNumber === false) merged.pageNumber = Object.assign({}, merged.pageNumber, { enabled: false });
  return merged;
}

function openPackage(inputPath) {
  const buf = fs.readFileSync(inputPath);
  const pkg = new DocxPackage(buf);
  if (!pkg.getText(pkg.mainDocumentName)) {
    throw new Error('不是有效的 docx：缺少正文部件');
  }
  return pkg;
}

/**
 * 版式修复（不改文字内容，只改属性与结构）。
 */
function formatDocument(pkg, options, fileMtime) {
  const opts = Object.assign({}, DEFAULT_RUN_OPTIONS, options || {});
  const preset = resolvePreset(opts);
  const steps = {};

  if (opts.dates) steps.dates = normalizeDates(pkg);
  if (opts.structure) steps.structure = applyStructuralBlanks(pkg, preset, {});
  if (opts.splitHeadings) steps.split = splitHeadings(pkg, preset, {});

  steps.page = applyPage(pkg, preset, {});
  steps.paragraphs = formatParagraphs(pkg, preset, {
    deepClean: opts.deepClean,
    stripStyles: opts.stripStyles,
  });
  if (opts.media) steps.media = protectMediaParagraphs(pkg, preset);
  if (opts.stripStyles) steps.styles = cleanStyles(pkg);

  if (opts.metadata) {
    const metaOpts = Object.assign({ dropThumbnail: !opts.keepThumbnail }, opts.metadataOptions || {});
    steps.metadata = cleanMetadata(pkg, metaOpts, fileMtime);
  }
  return { steps, preset, stats: documentStats(pkg) };
}

function writeOutput(pkg, outputPath, options) {
  const opts = options || {};
  if (fs.existsSync(outputPath) && !opts.force) {
    const error = new Error('输出文件已存在：' + outputPath + '（使用 --force 覆盖）');
    error.code = 'EEXIST_OUTPUT';
    throw error;
  }
  fs.writeFileSync(outputPath, pkg.save());
}

/**
 * 拒绝「输出路径 = 输入文件」。--force 只应对已存在的**另一个**文件生效；
 * 若两者同一文件，--force 会先读后写把源文件顶掉（v0.4.1 及以前无提示）。
 */
function assertDistinctPaths(inputPath, outputPath) {
  if (!inputPath || !outputPath) return;
  const shrink = (p) => (process.platform === 'win32' ? p.toLowerCase() : p);
  let a = shrink(path.resolve(inputPath));
  let b = shrink(path.resolve(outputPath));
  if (a !== b) {
    try {
      a = shrink(fs.realpathSync(path.resolve(inputPath)));
      b = shrink(fs.realpathSync(path.resolve(outputPath)));
    } catch (e) {
      // 输出尚不存在时 realpath 会抛错，此时用 resolve 结果比较即可
    }
  }
  if (a === b) {
    const error = new Error('输出路径与输入文件相同：' + outputPath +
      '；请指定不同的输出路径（避免原地覆盖源文件）');
    error.code = 'ESAME_PATH';
    throw error;
  }
}

/** 一站式：读入 -> 修复 -> 写出 */
function processFile(inputPath, outputPath, options) {
  const opts = Object.assign({}, DEFAULT_RUN_OPTIONS, options || {});
  assertDistinctPaths(inputPath, outputPath);
  const mtime = fs.statSync(inputPath).mtime;
  const pkg = openPackage(inputPath);
  const result = formatDocument(pkg, opts, mtime);
  if (opts.dryRun) return Object.assign({ dryRun: true }, result);
  writeOutput(pkg, outputPath, opts);
  return Object.assign({ output: outputPath, bytes: fs.statSync(outputPath).size }, result);
}

/** 仅元数据清理 */
function cleanMetadataFile(inputPath, outputPath, options) {
  const opts = options || {};
  assertDistinctPaths(inputPath, outputPath);
  const mtime = fs.statSync(inputPath).mtime;
  const pkg = openPackage(inputPath);
  const result = cleanMetadata(pkg, Object.assign({ dropThumbnail: !opts.keepThumbnail },
    opts.metadataOptions || {}), mtime);
  if (opts.dryRun) return { dryRun: true, metadata: result };
  writeOutput(pkg, outputPath, opts);
  return { output: outputPath, metadata: result };
}

/** 只读诊断 */
function analyzeFile(inputPath, options) {
  const opts = Object.assign({ preset: 'official', overrides: null }, options || {});
  const preset = resolvePreset(opts);
  const pkg = openPackage(inputPath);
  const report = diagnose(pkg, preset, opts);
  report.file = path.basename(inputPath);
  return report;
}

module.exports = {
  processFile, cleanMetadataFile, analyzeFile, formatDocument,
  DEFAULT_RUN_OPTIONS, openPackage, resolvePreset, assertDistinctPaths,
  stripPageNumberParagraphs,
};
