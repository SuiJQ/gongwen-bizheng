#!/usr/bin/env node
/**
 * DOCX 包容器：在 zip 之上提供部件读写、关系表与内容类型表的最小维护能力。
 *
 * 只有被显式改写的部件才会重新序列化；其余部件按原字节写回。
 */
'use strict';

const { readZip, writeZip } = require('./zip');
const { escapeAttr, XML_DECL } = require('./xml');

const REL_NS = 'http://schemas.openxmlformats.org/package/2006/relationships';
const CT_NS = 'http://schemas.openxmlformats.org/package/2006/content-types';

function relsPathOf(partName) {
  if (!partName || partName === '/') return '_rels/.rels';
  const idx = partName.lastIndexOf('/');
  const dir = idx < 0 ? '' : partName.slice(0, idx + 1);
  const base = idx < 0 ? partName : partName.slice(idx + 1);
  return dir + '_rels/' + base + '.rels';
}

class DocxPackage {
  constructor(buffer) {
    const zip = readZip(buffer);
    this.order = zip.order.slice();
    this.parts = new Map();
    for (const name of zip.order) {
      this.parts.set(name, zip.entries.get(name).data);
    }
    this.dirty = new Set();
  }

  has(name) {
    return this.parts.has(name);
  }

  getBuffer(name) {
    return this.parts.get(name) || null;
  }

  getText(name) {
    const buf = this.parts.get(name);
    return buf ? buf.toString('utf8') : null;
  }

  setText(name, text) {
    if (!this.parts.has(name)) this.order.push(name);
    this.parts.set(name, Buffer.from(text, 'utf8'));
    this.dirty.add(name);
  }

  setBuffer(name, buf) {
    if (!this.parts.has(name)) this.order.push(name);
    this.parts.set(name, buf);
    this.dirty.add(name);
  }

  remove(name) {
    if (!this.parts.has(name)) return false;
    this.parts.delete(name);
    this.order = this.order.filter((n) => n !== name);
    this.dirty.add(name);
    return true;
  }

  /** 读取某部件的关系表 */
  getRels(ownerPart) {
    const path = relsPathOf(ownerPart);
    const text = this.getText(path);
    if (!text) return [];
    const rels = [];
    const re = /<Relationship\b([^>]*)\/?>/g;
    let m = re.exec(text);
    while (m) {
      const attrs = {};
      const ra = /([A-Za-z0-9]+)="([^"]*)"/g;
      let a = ra.exec(m[1]);
      while (a) {
        attrs[a[1]] = a[2];
        a = ra.exec(m[1]);
      }
      rels.push(attrs);
      m = re.exec(text);
    }
    return rels;
  }

  /** 确保关系存在，返回关系 Id */
  ensureRel(ownerPart, type, target, preferredId) {
    const path = relsPathOf(ownerPart);
    const rels = this.getRels(ownerPart);
    const existing = rels.find((r) => r.Type === type && r.Target === target);
    if (existing) return existing.Id;

    let id = preferredId;
    if (!id) {
      let n = rels.length + 1;
      while (rels.some((r) => r.Id === 'rId' + n)) n += 1;
      id = 'rId' + n;
    }
    const text = this.getText(path);
    if (!text) {
      const body = XML_DECL + '<Relationships xmlns="' + REL_NS + '">' +
        '<Relationship Id="' + id + '" Type="' + escapeAttr(type) + '" Target="' + escapeAttr(target) + '"/>' +
        '</Relationships>';
      this.setText(path, body);
      return id;
    }
    const injected = text.replace('</Relationships>',
      '<Relationship Id="' + id + '" Type="' + escapeAttr(type) + '" Target="' + escapeAttr(target) + '"/></Relationships>');
    this.setText(path, injected);
    return id;
  }

  /** 删除指向某目标的关系 */
  removeRelsByTarget(ownerPart, target) {
    const path = relsPathOf(ownerPart);
    const text = this.getText(path);
    if (!text) return 0;
    let count = 0;
    const out = text.replace(/<Relationship\b[^>]*\/>/g, (tag) => {
      const tm = /Target="([^"]*)"/.exec(tag);
      if (tm && tm[1] === target) {
        count += 1;
        return '';
      }
      return tag;
    });
    if (count) this.setText(path, out);
    return count;
  }

  ensureContentTypeDefault(ext, contentType) {
    const text = this.getText('[Content_Types].xml');
    if (!text) return;
    if (new RegExp('<Default[^>]*Extension="' + ext + '"', 'i').test(text)) return;
    this.setText('[Content_Types].xml',
      text.replace('</Types>', '<Default Extension="' + ext + '" ContentType="' + escapeAttr(contentType) + '"/></Types>'));
  }

  ensureContentTypeOverride(partName, contentType) {
    const text = this.getText('[Content_Types].xml');
    if (!text) return;
    const pn = '/' + partName.replace(/^\//, '');
    if (new RegExp('PartName="' + pn.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '"', 'i').test(text)) return;
    this.setText('[Content_Types].xml',
      text.replace('</Types>', '<Override PartName="' + escapeAttr(pn) + '" ContentType="' + escapeAttr(contentType) + '"/></Types>'));
  }

  /** 删除部件的 Override 声明（Default 保留） */
  removeContentTypeOverride(partName) {
    const text = this.getText('[Content_Types].xml');
    if (!text) return;
    const pn = '/' + partName.replace(/^\//, '');
    const out = text.replace(/<Override\b[^>]*\/>/g, (tag) => {
      const m = /PartName="([^"]*)"/.exec(tag);
      return m && m[1] === pn ? '' : tag;
    });
    this.setText('[Content_Types].xml', out);
  }

  get mainDocumentName() {
    const rels = this.getRels('');
    const main = rels.find((r) => /officeDocument$/.test(r.Type || ''));
    return main ? main.Target.replace(/^\//, '') : 'word/document.xml';
  }

  save(options) {
    const list = this.order.map((name) => ({ name, data: this.parts.get(name) }));
    return writeZip(list, options);
  }
}

module.exports = { DocxPackage, relsPathOf, REL_NS, CT_NS };
