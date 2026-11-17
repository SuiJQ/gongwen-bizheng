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
 *   4. 无 BOM 的 GBK / GB18030（v0.8.2）—— 老 OA 导出、Excel 另存、
 *      Windows 记事本"ANSI"。此前一律按 utf8 解码，非法字节被静默替换成
 *      U+FFFD：机检会报"缺标题/缺日期"（其实是因为乱码），导出会产出乱码 docx
 *      并 exit 0。现改为严格 UTF-8 → GB18030 回落，并把编码结论交给调用方。
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

/** 严格 UTF-8 解码：非法字节抛错，不静默替换成 U+FFFD。不可用则返回 null。 */
function decodeUtf8Strict(buf) {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch (e) {
    return null;
  }
}

/** 按标签解码，失败返回 null（Node 无对应 ICU 数据时同样返回 null） */
function decodeWith(label, buf) {
  try {
    return new TextDecoder(label, { fatal: true }).decode(buf);
  } catch (e) {
    return null;
  }
}

/** U+FFFD 占比超过 1‰ 视为解码失败（GB18030 也有非映射字节） */
function tooLossy(text) {
  if (!text) return false;
  let bad = 0;
  for (let i = 0; i < text.length; i += 1) if (text.charCodeAt(i) === 0xfffd) bad += 1;
  return bad / text.length > 0.001;
}

/**
 * Buffer -> { text, encoding }。encoding ∈ utf-8 | utf-8-bom | utf-16le |
 * utf-16be | gb18030 | unknown。
 *
 * 判定顺序：BOM → 严格 UTF-8 → GB18030。GB18030 是 GBK 的超集，中文公文
 * 的"ANSI"编码基本落在其中；两者都不成立则记 unknown，由调用方决定报错。
 */
function decodeBufferWithMeta(buf) {
  let text;
  let encoding;
  if (startsWith(buf, BOM_UTF16_LE)) {
    text = buf.subarray(2).toString('utf16le');
    encoding = 'utf-16le';
  } else if (startsWith(buf, BOM_UTF16_BE)) {
    const body = Buffer.from(buf.subarray(2));
    // 奇数字节必为截断，丢掉尾字节再按 utf16le 解码（swap16 要求偶数长度）
    text = (body.length % 2 === 1 ? body.subarray(0, body.length - 1) : body)
      .swap16().toString('utf16le');
    encoding = 'utf-16be';
  } else if (startsWith(buf, BOM_UTF8)) {
    text = buf.subarray(3).toString('utf8');
    encoding = 'utf-8-bom';
  } else {
    text = decodeUtf8Strict(buf);
    if (text !== null) {
      encoding = 'utf-8';
    } else {
      const gbk = decodeWith('gb18030', buf);
      if (gbk !== null && !tooLossy(gbk)) {
        text = gbk;
        encoding = 'gb18030';
      } else {
        // 两种都不成立：给出尽力而为的文本，但明确标记 unknown
        text = buf.toString('utf8');
        encoding = 'unknown';
      }
    }
  }
  // 双重 BOM（BOM 之上再用 U+FEFF 开头的文本）只保留一层剥离后的内容
  if (text && text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  return { text: normalizeNewlines(text || ''), encoding };
}

/**
 * Buffer -> 字符串（兼容旧签名）。编码判定见 decodeBufferWithMeta。
 * @param {Buffer} buf
 * @returns {string}
 */
function decodeBuffer(buf) {
  return decodeBufferWithMeta(buf).text;
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

/** 读文本并带回编码结论：{ text, encoding }，供入口决定是否提示/报错 */
function readTextWithMeta(file) {
  return decodeBufferWithMeta(fs.readFileSync(file));
}

module.exports = {
  readText, readTextWithMeta, decodeBuffer, decodeBufferWithMeta, normalizeNewlines,
};