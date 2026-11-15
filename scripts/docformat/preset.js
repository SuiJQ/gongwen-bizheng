#!/usr/bin/env node
/**
 * 版式预设。
 *
 * 参数依据 GB/T 9704-2012《党政机关公文格式》与公文排版通例独立整理，
 * 不复制任何第三方项目的常量表。
 *
 * 长度单位：cm（页面几何）/ 半磅（字号）/ twips（缩进、行距、段前后）。
 */
'use strict';

const A4 = { width: 11906, height: 16838 }; // twips，210mm × 297mm

/**
 * 页码垂直位置（GB/T 9704-2012 7.3.6）：一字线上距版心下边缘 7mm。
 * `w:footer` 的语义是「页脚底边距纸张下边缘」，版心下边缘距纸张下边缘 35mm，
 * 故页脚底边距纸边 = 35 - 7 = 28mm = 2.8cm。
 * v0.4.1 起由这里统一推导，export_docx 与 format_docx 共用同一数值。
 */
const BOTTOM_MARGIN_CM = 3.5;
const PAGE_NUMBER_OFFSET_MM = 7;
const FOOTER_DISTANCE_CM = BOTTOM_MARGIN_CM - PAGE_NUMBER_OFFSET_MM / 10; // 2.8

function para(fontCn, sizePt, opts) {
  return Object.assign({
    fontCn,
    fontEn: 'Times New Roman',
    sizeHalfPt: sizePt * 2,
    bold: false,
    align: 'both',
    firstLineChars: 0, // 100 = 1 字符
    leftChars: 0,
    rightChars: 0,
    spaceBefore: 0,
    spaceAfter: 0,
    keepNext: false,
  }, opts || {});
}

/** 公文格式（默认预设） */
const official = {
  name: '公文格式',
  page: {
    width: A4.width,
    height: A4.height,
    orientation: 'portrait',
    top: 3.7,
    bottom: BOTTOM_MARGIN_CM,
    left: 2.8,
    right: 2.6,
    header: 1.5,
    footer: FOOTER_DISTANCE_CM,
    gutter: 0,
  },
  lineSpacing: { value: 560, rule: 'exact' }, // 28 磅
  emptyLineSpacing: { value: 560, rule: 'exact' },
  pageNumber: {
    enabled: true,
    font: '宋体',
    sizeHalfPt: 28, // 四号
    style: 'dash', // dash: — 1 —；plain: 1
    position: 'outside', // outside / center / left / right
    // 垂直位置不在此处配置：由 page.footer（见 FOOTER_DISTANCE_CM）统一决定，
    // 避免出现「声明了 7mm 但无人读取」的死参数（v0.4.0 曾在此处声明过一个 7mm 参数）。
    replaceExisting: true,
    protectOtherFooterContent: true,
  },
  types: {
    title: para('方正小标宋简体', 22, { align: 'center', spaceAfter: 0 }),
    docNumber: para('仿宋_GB2312', 16, { align: 'center' }),
    recipient: para('仿宋_GB2312', 16, { align: 'left', firstLineChars: 0 }),
    heading1: para('黑体', 16, { align: 'left', firstLineChars: 200 }),
    heading2: para('楷体_GB2312', 16, { align: 'left', firstLineChars: 200 }),
    heading3: para('仿宋_GB2312', 16, { align: 'left', firstLineChars: 200 }),
    heading4: para('仿宋_GB2312', 16, { align: 'left', firstLineChars: 200 }),
    body: para('仿宋_GB2312', 16, { align: 'both', firstLineChars: 200 }),
    closing: para('仿宋_GB2312', 16, { align: 'both', firstLineChars: 200 }),
    signature: para('仿宋_GB2312', 16, { align: 'right', rightChars: 200 }),
    date: para('仿宋_GB2312', 16, { align: 'right', rightChars: 400 }),
    attachment: para('仿宋_GB2312', 16, { align: 'left', hangingChars: 300 }),
    attachmentTitle: para('仿宋_GB2312', 16, { align: 'left' }),
    cc: para('仿宋_GB2312', 16, { align: 'left' }),
    sourceNote: para('仿宋_GB2312', 16, { align: 'both', firstLineChars: 200 }),
    // 无法判定时按正文处理
    unknown: para('仿宋_GB2312', 16, { align: 'both', firstLineChars: 200 }),
  },
  // 结构空行：标题后一个空段；落款前一个空段
  structuralBlank: { afterTitle: true, beforeSignature: true },
};

const PRESETS = { official };

function getPreset(name) {
  const key = name || 'official';
  if (!PRESETS[key]) {
    throw new Error('未知预设：' + key + '（可用：' + Object.keys(PRESETS).join(', ') + '）');
  }
  return PRESETS[key];
}

/** 深合并覆盖项（用户 JSON 可用 _overrides 局部改参数） */
function mergePreset(base, overrides) {
  if (!overrides) return base;
  const out = JSON.parse(JSON.stringify(base));
  const walk = (target, patch) => {
    Object.keys(patch || {}).forEach((k) => {
      const v = patch[k];
      if (v && typeof v === 'object' && !Array.isArray(v) && target[k] && typeof target[k] === 'object') {
        walk(target[k], v);
      } else {
        target[k] = v;
      }
    });
  };
  walk(out, overrides);
  return out;
}

module.exports = { A4, PRESETS, getPreset, mergePreset, para };
