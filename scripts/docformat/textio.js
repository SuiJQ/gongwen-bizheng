#!/usr/bin/env node
/**
 * 文本输入读取：跨平台容错（v0.7.2 新增）。
 *
 * 三个纯文本入口（check_format.js、check_rhythm.js、export_docx.js）统一走这里，
 * 避免同一类缺陷三处各修一遍。
 *
 * 处理三件事，都是 Windows / 旧环境编辑器留下的常见形态：
 *   1. UTF-8 BOM —— 记事本、Excel 导出、PowerShell `Out-File` 默认会写。
 *      BOM 会粘在首行，让标题/文种识别与逐行正则全部错位一个字符。
 *   2. UTF-16LE / BE —— 记事本「Unicode」「Unicode big endian」另存的结果。
 *      按 utf8 读会得到夹着 NUL 的乱码，检查会静默给出错误结论。
 *   3. CRLF 与单独的 CR —— 旧版 Mac 文本、部分导出器。
 *      行切分错位会让逐行检查失效（整篇被当成一行）。
 *
 * 只做解码与换行归一，不改动任何字符内容；调用方仍按 `split('\n')` 或
 * `split(/\r?\n/)` 切行，两种写法在归一后结果相同。
 */
'use strict';

const fs = require('fs');

const BOM_UTF8 = Buffer.from([0xef, 0xbb, 0xbf]);
const BOM_UTF16_LE = Buffer.from([0xff, 0xfe]);
const BOM_UTF16_BE = Buffer.from([0xfe, 0xff]);

function startsWith(buf, bom) {
  return buf.length >= bom.length && buf.subarray(0, bom.length).equals(bom);
}

/**
 * Buffer -> 字符串。按 BOM 判定编码并剥离 BOM；无 BOM 时按 UTF-8 处理。
 * @param {Buffer} buf
 * @returns {string}
 */
function decodeBuffer(buf) {
  let text;
  if (startsWith(buf, BOM_UTF16_LE)) {
    text = buf.subarray(2).toString('utf16le');
  } else if (startsWith(buf, BOM_UTF16_BE)) {
    const body = Buffer.from(buf.subarray(2));
    // 奇数字节必为截断，丢掉尾字节再按 utf16le 解码（swap16 要求偶数长度）
    if (body.length % 2 === 1) return normalizeNewlines(body.subarray(0, body.length - 1).swap16().toString('utf16le'));
    text = body.swap16().toString('utf16le');
  } else if (startsWith(buf, BOM_UTF8)) {
    text = buf.subarray(3).toString('utf8');
  } else {
    text = buf.toString('utf8');
  }
  // 双重 BOM（BOM 之上再用 U+FEFF 开头的文本）只保留一层剥离后的内容
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  return normalizeNewlines(text);
}

/** 换行归一：CRLF 与单独的 CR 都变成 \n，行号口径随之稳定 */
function normalizeNewlines(text) {
  return String(text).replace(/\r\n?/g, '\n');
}

/**
 * 读文本文件并归一换行。读取失败直接抛出，由调用方按各自退出码约定处理。
 * @param {string} file
 * @returns {string}
 */
function readText(file) {
  return decodeBuffer(fs.readFileSync(file));
}

module.exports = { readText, decodeBuffer, normalizeNewlines };