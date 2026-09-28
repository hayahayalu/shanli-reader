'use strict';

const fs = require('fs');
const path = require('path');
const AdmZip = require('adm-zip');

/* ------------------------------------------------------------------ *
 *  编码检测 & 文本解码
 * ------------------------------------------------------------------ */

const BOMS = [
  { bytes: [0xef, 0xbb, 0xbf], enc: 'utf8' },
  { bytes: [0xff, 0xfe, 0x00, 0x00], enc: 'utf32le' },
  { bytes: [0x00, 0x00, 0xfe, 0xff], enc: 'utf32be' },
  { bytes: [0xff, 0xfe], enc: 'utf16le' },
  { bytes: [0xfe, 0xff], enc: 'utf16be' },
];

function detectBom(buf) {
  for (const b of BOMS) {
    if (buf.length >= b.bytes.length && b.bytes.every((v, i) => buf[i] === v)) {
      return { enc: b.enc, skip: b.bytes.length };
    }
  }
  return null;
}

/**
 * UTF-16 无 BOM 的启发式判断：
 * 中文文本里会出现大量 0x00（ASCII 字符的高位），或者 CJK 区间的规律分布。
 */
function looksLikeUtf16WithoutBom(buf) {
  const n = Math.min(buf.length, 4096);
  if (n < 8) return null;
  let evenZero = 0;
  let oddZero = 0;
  for (let i = 0; i < n; i++) {
    if (buf[i] === 0x00) {
      if (i % 2 === 0) evenZero++;
      else oddZero++;
    }
  }
  const ratio = Math.max(evenZero, oddZero) / n;
  if (ratio > 0.25) return evenZero < oddZero ? 'utf16be' : 'utf16le';
  return null;
}

/**
 * 用严格 UTF-8 解码验证，失败返回 null。
 */
function tryStrictUtf8(buf) {
  try {
    const dec = new TextDecoder('utf-8', { fatal: true });
    return dec.decode(buf);
  } catch {
    return null;
  }
}

/* ---- GBK / GB18030 ---- */

let gbkTable = null;

function loadGbkTable() {
  if (gbkTable) return gbkTable;
  const candidates = [
    path.join(process.resourcesPath || '', 'lib', 'gbk.json'),
    path.join(__dirname, 'gbk.json'),
  ];
  for (const p of candidates) {
    try {
      if (fs.existsSync(p)) {
        const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
        gbkTable = new Map();
        for (const [cp, ch] of raw) {
          const hi = parseInt(cp.slice(0, 2), 16);
          const lo = parseInt(cp.slice(2, 4), 16);
          gbkTable.set(hi * 256 + lo, ch);
        }
        return gbkTable;
      }
    } catch {
      /* 继续尝试下一个 */
    }
  }
  return null;
}

/**
 * 纯 JS 的 GB18030 解码（覆盖 GBK 常用区间 + 单字节 ASCII）。
 * 表来自 Unicode 官方 GB18030 映射，节选到 lib/gbk.json。
 */
function decodeGbk(buf) {
  const table = loadGbkTable();
  let out = '';
  let i = 0;
  while (i < buf.length) {
    const b = buf[i];
    if (b < 0x80) {
      out += String.fromCharCode(b);
      i += 1;
      continue;
    }
    if (i + 1 < buf.length) {
      const code = (b << 8) | buf[i + 1];
      if (table && table.has(code)) {
        out += table.get(code);
        i += 2;
        continue;
      }
      // 4 字节 GB18030 区间，退化为替换符（罕见）
      if (b >= 0x81 && b <= 0xfe && buf[i + 1] >= 0x30 && buf[i + 1] <= 0x39) {
        const cp4 = String.fromCharCode(buf[i + 2], buf[i + 3]);
        const key = 'u' + cp4.charCodeAt(0).toString(16).padStart(2, '0');
        const r = GB18030_FOUR[buf[i + 2] - 0x30];
        void key;
        if (r) {
          out += r;
        } else {
          out += '\uFFFD';
        }
        i += 4;
        continue;
      }
    }
    out += '\uFFFD';
    i += 1;
  }
  return out;
}

// 占位：4 字节补全区（极少出现在中文小说里，用简单映射兜底）
const GB18030_FOUR = [];

/**
 * 智能解码任意字节流为文本。
 */
function decodeBuffer(buffer) {
  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
  if (buf.length === 0) return '';
  if (buf.length > 200 * 1024 * 1024) throw new Error('文件过大（>200MB）');

  const bom = detectBom(buf);
  if (bom) {
    if (bom.enc === 'utf32le') return utf32ToString(buf.subarray(bom.skip), true);
    if (bom.enc === 'utf32be') return utf32ToString(buf.subarray(bom.skip), false);
    if (bom.enc === 'utf16le') return buf.subarray(bom.skip).toString('utf16le');
    if (bom.enc === 'utf16be') return swap16(buf.subarray(bom.skip)).toString('utf16le');
    return new TextDecoder('utf-8').decode(buf.subarray(bom.skip));
  }

  const utf16 = looksLikeUtf16WithoutBom(buf);
  if (utf16 === 'utf16le') return buf.toString('utf16le');
  if (utf16 === 'utf16be') return swap16(buf).toString('utf16le');

  const strict = tryStrictUtf8(buf);
  if (strict !== null) return strict;

  // 不是合法 UTF-8 → 大概率是 GBK / GB18030 中文字体文件
  const gbk = decodeGbk(buf);
  // 用替换符数量做个简单校验
  const bad = (gbk.match(/\uFFFD/g) || []).length;
  if (bad / Math.max(gbk.length, 1) < 0.02) return gbk;

  // 兜底：宽松 UTF-8
  return new TextDecoder('utf-8', { fatal: false }).decode(buf);
}

function swap16(buf) {
  const copy = Buffer.from(buf);
  if (copy.length % 2 !== 0) {
    return copy.subarray(0, copy.length - 1).swap16();
  }
  return copy.swap16();
}

function utf32ToString(buf, le) {
  let out = '';
  for (let i = 0; i + 3 < buf.length; i += 4) {
    const cp = le
      ? buf.readUInt32LE(i)
      : buf.readUInt32BE(i);
    if (cp === 0) continue;
    out += String.fromCodePoint(cp > 0x10ffff ? 0xfffd : cp);
  }
  return out;
}

/* ------------------------------------------------------------------ *
 *  纯文本 -> 章节划分
 * ------------------------------------------------------------------ */

// 常见章节标题形态
const CHAPTER_PATTERNS = [
  /^\s{0,6}第\s*[0-9零一二三四五六七八九十百千万两〇]+\s*[章回节篇卷部集]\s*[^\n]{0,40}$/,
  /^\s{0,6}(?:Chapter|CHAPTER|Chap\.?)\s*[0-9IVXLCDM]+\s*[^\n]{0,40}$/,
  /^\s{0,6}(?:序章|序言|序|前言|引言|楔子|引子|尾声|后记|番外|终章|大结局|正文)\s*[^\n]{0,30}$/,
  /^\s{0,6}[（(【\[]?\s*(?:第)?[0-9]{1,4}\s*[)）】\]]\s*[^\n]{0,40}$/,
  /^\s{0,6}[0-9]{1,4}[、.．]\s*[^\n]{2,40}$/,
];

function isChapterTitle(line) {
  const s = line.trim();
  if (!s || s.length > 50) return false;
  return CHAPTER_PATTERNS.some((re) => re.test(line));
}

/**
 * 把长文本切成 { title, text } 段落数组。
 * 没有章节标题时，按固定长度切块，标题用“第 N 节”。
 */
function splitIntoChapters(rawText, fallbackChunk = 3000) {
  const text = rawText
    .replace(/\r\n?/g, '\n')
    .replace(/\u3000/g, ' ')          // 全角空格 -> 普通空格（保留可读性）
    .replace(/[ \t]+\n/g, '\n');

  const lines = text.split('\n');
  const chapters = [];
  let current = null;

  for (const line of lines) {
    if (isChapterTitle(line)) {
      if (current && current.text.trim()) chapters.push(current);
      current = { title: line.trim(), text: '' };
    } else {
      if (!current) current = { title: '', text: '' };
      current.text += (current.text ? '\n' : '') + line;
    }
  }
  if (current && current.text.trim()) chapters.push(current);

  // 整本书一个标题都没有 → 按字数分块
  if (chapters.length <= 1) {
    const body = text.trim();
    const out = [];
    const paras = body.split(/\n+/).filter(Boolean);
    let buf = [];
    let len = 0;
    for (const p of paras) {
      buf.push(p);
      len += p.length;
      if (len >= fallbackChunk) {
        out.push({ title: '', text: buf.join('\n') });
        buf = [];
        len = 0;
      }
    }
    if (buf.length) out.push({ title: '', text: buf.join('\n') });
    return out.length ? out : [{ title: '', text: body }];
  }

  return chapters;
}

const MAX_TEXT_LENGTH = 4 * 1024 * 1024; // 单本书载入上限约 400 万字

function parseTxt(filePath) {
  const buf = fs.readFileSync(filePath);
  let text = decodeBuffer(buf);
  if (text.length > MAX_TEXT_LENGTH) text = text.slice(0, MAX_TEXT_LENGTH);
  const chapters = splitIntoChapters(text);
  return {
    chapters,
    bytes: buf.length,
  };
}

/* ------------------------------------------------------------------ *
 *  EPUB 解析
 * ------------------------------------------------------------------ */

const XML_ENTITIES = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&apos;': "'",
  '&nbsp;': ' ',
  '&#160;': ' ',
  '&mdash;': '—',
  '&ldquo;': '“',
  '&rdquo;': '”',
  '&lsquo;': '‘',
  '&rsquo;': '’',
  '&hellip;': '…',
};

function decodeEntities(s) {
  if (!s) return '';
  let out = s.replace(/&[a-zA-Z#0-9]+;/g, (m) => {
    if (XML_ENTITIES[m]) return XML_ENTITIES[m];
    const num = m.match(/^&#(x?)([0-9a-fA-F]+);$/);
    if (num) {
      const cp = parseInt(num[2], num[1] ? 16 : 10);
      if (cp > 0 && cp <= 0x10ffff) return String.fromCodePoint(cp);
    }
    return ' ';
  });
  return out;
}

function stripTags(html) {
  if (!html) return '';
  let s = html;
  s = s.replace(/<(script|style|head)[\s\S]*?<\/\1>/gi, '');
  s = s.replace(/<\s*br\s*\/?\s*>/gi, '\n');
  s = s.replace(/<\/\s*(p|div|h[1-6]|li|tr|section|article|blockquote)\s*>/gi, '\n\n');
  s = s.replace(/<[^>]+>/g, '');
  s = decodeEntities(s);
  s = s
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]*\n[ \t]*/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/\u00a0/g, ' ');
  return s.trim();
}

/** 从 HTML 里抽取第一个标题 */
function extractHeading(html) {
  const m = html.match(/<h[1-4][^>]*>([\s\S]*?)<\/h[1-4]>/i);
  if (m) {
    const t = stripTags(m[1]).replace(/\n+/g, ' ').trim();
    if (t) return t;
  }
  const t = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (t) {
    const v = decodeEntities(t[1]).trim();
    if (v) return v;
  }
  return '';
}

function dirname(p) {
  const i = p.lastIndexOf('/');
  return i === -1 ? '' : p.slice(0, i);
}

function normalizePath(base, rel) {
  let p = rel;
  if (!p) return '';
  p = p.replace(/^\.\//, '');
  if (base) p = base + '/' + p;
  const parts = [];
  for (const seg of p.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') parts.pop();
    else parts.push(seg);
  }
  return parts.join('/');
}

function parseTocEntries(xml, base) {
  const entries = [];
  const re = /<navPoint\b[\s\S]*?<\/navPoint>/gi;
  const labelRe = /<text[^>]*>([\s\S]*?)<\/text>/i;
  const srcRe = /<content[^>]*?src=["']([^"']+)["']/i;
  for (const m of xml.match(re) || []) {
    const lb = m.match(labelRe);
    const sc = m.match(srcRe);
    if (!lb) continue;
    entries.push({
      title: decodeEntities(lb[1]).replace(/\s+/g, ' ').trim(),
      href: sc ? normalizePath(base, sc[1].split('#')[0]) : '',
    });
  }
  return entries;
}

function parseEpub(filePath) {
  const zip = new AdmZip(filePath);
  const entries = zip.getEntries();
  const byName = new Map();
  for (const e of entries) {
    if (!e.isDirectory) byName.set(e.entryName.replace(/\\/g, '/'), e);
  }

  // 1. container.xml -> opf 路径
  let opfPath = '';
  const containerEntry = byName.get('META-INF/container.xml');
  if (containerEntry) {
    const xml = containerEntry.getData().toString('utf8');
    const m = xml.match(/full-path\s*=\s*["']([^"']+)["']/i);
    if (m) opfPath = m[1].replace(/\\/g, '/');
  }
  if (!opfPath) {
    const guess = [...byName.keys()].find((k) => /\.opf$/i.test(k));
    if (guess) opfPath = guess;
  }
  if (!opfPath || !byName.has(opfPath)) {
    throw new Error('不是有效的 EPUB：找不到 OPF 清单文件');
  }

  const opfBase = dirname(opfPath);
  const opf = byName.get(opfPath).getData().toString('utf8');

  // 2. manifest: id -> href
  const manifest = new Map();
  const itemRe = /<item\b[^>]*>/gi;
  for (const tag of opf.match(itemRe) || []) {
    const id = (tag.match(/\bid\s*=\s*["']([^"']+)["']/i) || [])[1];
    const href = (tag.match(/\bhref\s*=\s*["']([^"']+)["']/i) || [])[1];
    const media = (tag.match(/media-type\s*=\s*["']([^"']+)["']/i) || [])[1] || '';
    if (id && href) {
      manifest.set(id, {
        href: normalizePath(opfBase, href.split('#')[0]),
        media,
      });
    }
  }

  // 3. spine 顺序
  const spineIds = [];
  const spineMatch = opf.match(/<spine\b[\s\S]*?<\/spine>/i);
  if (spineMatch) {
    for (const tag of spineMatch[0].match(/<itemref\b[^>]*>/gi) || []) {
      const idref = (tag.match(/\bidref\s*=\s*["']([^"']+)["']/i) || [])[1];
      if (idref) spineIds.push(idref);
    }
  }
  let order = spineIds
    .map((id) => manifest.get(id))
    .filter(Boolean)
    .map((it) => it.href);

  // 兜底：manifest 里所有 html 文档
  if (order.length === 0) {
    order = [...manifest.values()]
      .filter((it) => /\.x?html?$/i.test(it.href) || /xhtml/.test(it.media))
      .map((it) => it.href);
  }
  order = [...new Set(order)].filter((h) => byName.has(h));

  // 4. 目录：toc.ncx / nav.xhtml
  let tocEntries = [];
  const ncx = [...manifest.values()].find((it) => /ncx$/i.test(it.href));
  if (ncx && byName.has(ncx.href)) {
    tocEntries = parseTocEntries(
      byName.get(ncx.href).getData().toString('utf8'),
      dirname(ncx.href)
    );
  }
  if (tocEntries.length === 0) {
    const nav = [...manifest.values()].find(
      (it) => it.href && /nav\.x?html?$/i.test(it.href)
    );
    if (nav && byName.has(nav.href)) {
      tocEntries = parseTocEntries(
        byName.get(nav.href).getData().toString('utf8'),
        dirname(nav.href)
      );
    }
  }

  // 5. 抽正文
  const chapters = [];
  let totalChars = 0;
  for (const href of order) {
    if (totalChars > MAX_TEXT_LENGTH) break;
    let html;
    try {
      const data = byName.get(href).getData();
      html = decodeBuffer(data);
    } catch {
      continue;
    }
    const text = stripTags(html);
    if (!text || text.length < 2) continue;
    totalChars += text.length;
    chapters.push({ title: extractHeading(html), text, href });
  }

  if (chapters.length === 0) throw new Error('EPUB 中没有可读文本内容');

  return { chapters, toc: tocEntries };
}

/* ------------------------------------------------------------------ *
 *  统一入口
 * ------------------------------------------------------------------ */

function parseBook(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const base = path.basename(filePath);
  const started = Date.now();

  if (ext === '.txt') {
    const r = parseTxt(filePath);
    return {
      title: base.replace(/\.txt$/i, ''),
      format: 'txt',
      chapters: r.chapters,
      toc: [],
      elapsed: Date.now() - started,
    };
  }

  if (ext === '.epub') {
    const r = parseEpub(filePath);
    // epub 标题：优先书名元数据
    let title = base.replace(/\.epub$/i, '');
    try {
      const zip = new AdmZip(filePath);
      const opf = zip
        .getEntries()
        .find((e) => /\.opf$/i.test(e.entryName));
      if (opf) {
        const xml = opf.getData().toString('utf8');
        const t = xml.match(/<dc:title[^>]*>([\s\S]*?)<\/dc:title>/i);
        if (t) {
          const v = decodeEntities(t[1]).trim();
          if (v) title = v;
        }
      }
    } catch {
      /* 忽略 */
    }
    return {
      title,
      format: 'epub',
      chapters: r.chapters,
      toc: r.toc,
      elapsed: Date.now() - started,
    };
  }

  throw new Error('暂不支持的格式：' + ext);
}

module.exports = { parseBook, decodeBuffer, splitIntoChapters, stripTags };
