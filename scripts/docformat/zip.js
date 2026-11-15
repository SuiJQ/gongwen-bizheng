#!/usr/bin/env node
/**
 * DOCX 包读写：纯 Node 内置模块实现 zip 解析与打包。
 *
 * 设计要点：
 * - 只依赖 zlib，不引入任何第三方包。
 * - 读取后按原顺序保留全部部件；未修改的部件按原始字节写回（不重新序列化），
 *   因此未知节点（媒体、域代码、修订痕迹）不会被破坏。
 * - 写入支持 store / deflate 两种方式，默认 deflate。
 *
 * 读取侧防护（v0.4.2 起）：
 * - 逐条目校验 CRC-32，损坏即报错，不再静默解出错误内容；
 * - 单条目解压上限，防止高压缩比构造导致内存耗尽；
 * - 显式识别 ZIP64 标记并给出可操作提示，而不是按 32 位错读。
 */
'use strict';

const zlib = require('zlib');

/** 单条目解压后上限：256 MB。常见公文 docx 远小于此值。 */
const DEFAULT_MAX_INFLATE_BYTES = 256 * 1024 * 1024;
/** ZIP64 在 32 位字段里留下的占位值 */
const ZIP64_MARK_16 = 0xffff;
const ZIP64_MARK_32 = 0xffffffff;

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[i] = c >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  let crc = 0xffffffff;
  for (let i = 0; i < buffer.length; i += 1) {
    crc = CRC_TABLE[(crc ^ buffer[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function inflateEntry(raw, name, maxBytes) {
  try {
    return zlib.inflateRawSync(raw, { maxOutputLength: maxBytes });
  } catch (error) {
    if (error && /maxOutputLength|buffer/i.test(String(error.code || '') + error.message)) {
      throw new Error('部件解压后超过上限 ' + Math.round(maxBytes / 1024 / 1024) +
        ' MB：' + name + '（疑似构造文件，已拒绝）');
    }
    throw new Error('部件解压失败：' + name + '（' + error.message + '）');
  }
}

/**
 * 解析 zip。
 * @param {Buffer} buffer
 * @param {object} [options] verifyCrc 默认 true；maxInflateBytes 默认 256MB
 * @returns {{order: string[], entries: Map<string, {data: Buffer, method: number, crc: number}>}}
 */
function readZip(buffer, options) {
  const opts = options || {};
  const verifyCrc = opts.verifyCrc !== false;
  const maxInflate = opts.maxInflateBytes || DEFAULT_MAX_INFLATE_BYTES;
  if (!Buffer.isBuffer(buffer)) throw new Error('readZip 需要 Buffer');
  // 定位 EOCD（结尾中央目录），从尾部向前找签名
  let eocd = -1;
  for (let i = buffer.length - 22; i >= 0 && i >= buffer.length - 65558; i -= 1) {
    if (buffer.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('不是有效的 zip/docx：未找到中央目录');

  const total = buffer.readUInt16LE(eocd + 10);
  const cdSize = buffer.readUInt32LE(eocd + 12);
  const cdOffset = buffer.readUInt32LE(eocd + 16);
  if (total === ZIP64_MARK_16 || cdSize === ZIP64_MARK_32 || cdOffset === ZIP64_MARK_32) {
    throw new Error('不支持 ZIP64 格式的 docx（条目数或偏移超出 32 位）：' +
      '请用 Word／WPS 另存为普通 docx 后重试');
  }

  const entries = new Map();
  const order = [];
  let p = cdOffset;

  for (let i = 0; i < total; i += 1) {
    if (p + 46 > buffer.length) throw new Error('中央目录被截断：第 ' + (i + 1) + ' 项');
    if (buffer.readUInt32LE(p) !== 0x02014b50) throw new Error('中央目录项签名错误');
    const method = buffer.readUInt16LE(p + 10);
    const crc = buffer.readUInt32LE(p + 16);
    const compSize = buffer.readUInt32LE(p + 20);
    const nameLen = buffer.readUInt16LE(p + 28);
    const extraLen = buffer.readUInt16LE(p + 30);
    const commentLen = buffer.readUInt16LE(p + 32);
    const localOffset = buffer.readUInt32LE(p + 42);
    const name = buffer.toString('utf8', p + 46, p + 46 + nameLen);

    if (localOffset + 30 > buffer.length) throw new Error('本地文件头越界：' + name);
    if (buffer.readUInt32LE(localOffset) !== 0x04034b50) throw new Error('本地文件头签名错误：' + name);
    const lNameLen = buffer.readUInt16LE(localOffset + 26);
    const lExtraLen = buffer.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + lNameLen + lExtraLen;
    const raw = buffer.subarray(dataStart, dataStart + compSize);
    let data;
    if (method === 0) data = Buffer.from(raw);
    else if (method === 8) data = inflateEntry(raw, name, maxInflate);
    else throw new Error('不支持的压缩方式 ' + method + '：' + name);

    if (verifyCrc) {
      const actual = crc32(data);
      if (actual !== crc) {
        throw new Error('部件 CRC 校验失败：' + name +
          '（记录 ' + crc.toString(16) + '，实际 ' + actual.toString(16) + '）；文件可能已损坏');
      }
    }

    entries.set(name, { data, method, crc });
    order.push(name);
    p += 46 + nameLen + extraLen + commentLen;
  }
  return { order, entries };
}

/** 打包 zip。entries 为 [{name, data:Buffer|string}]，按数组顺序写入。 */
function writeZip(list, options) {
  const opts = Object.assign({ deflate: true, date: new Date() }, options || {});
  const dosTime = ((opts.date.getHours() << 11) | (opts.date.getMinutes() << 5) |
    (Math.floor(opts.date.getSeconds() / 2))) & 0xffff;
  const dosDate = (((opts.date.getFullYear() - 1980) << 9) | ((opts.date.getMonth() + 1) << 5) |
    opts.date.getDate()) & 0xffff;

  const localChunks = [];
  const centralChunks = [];
  let offset = 0;

  list.forEach((entry) => {
    const nameBuf = Buffer.from(entry.name, 'utf8');
    const source = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(String(entry.data), 'utf8');
    const crc = crc32(source);
    let method = 0;
    let payload = source;
    if (opts.deflate && source.length > 0) {
      const deflated = zlib.deflateRawSync(source, { level: 9 });
      if (deflated.length < source.length) {
        method = 8;
        payload = deflated;
      }
    }

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // UTF-8 名称标志
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(dosTime, 10);
    local.writeUInt16LE(dosDate, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(payload.length, 18);
    local.writeUInt32LE(source.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    localChunks.push(local, nameBuf, payload);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(dosTime, 12);
    central.writeUInt16LE(dosDate, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(payload.length, 20);
    central.writeUInt32LE(source.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    centralChunks.push(central, nameBuf);

    offset += 30 + nameBuf.length + payload.length;
  });

  const centralStart = offset;
  const centralSize = centralChunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(list.length, 8);
  eocd.writeUInt16LE(list.length, 10);
  eocd.writeUInt32LE(centralSize, 12);
  eocd.writeUInt32LE(centralStart, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...localChunks, ...centralChunks, eocd]);
}

module.exports = { crc32, readZip, writeZip, DEFAULT_MAX_INFLATE_BYTES };
