'use strict';

/* 生成测试用的 txt / epub，并验证解析结果 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const out = path.join(os.tmpdir(), 'shanli-reader-test');
fs.mkdirSync(out, { recursive: true });

/* ---------- 1. UTF-8 txt（有章节标题） ---------- */
const CHAPTERS = 12;
let utf8 = '';
for (let i = 1; i <= CHAPTERS; i++) {
  utf8 += `第${i}章 测试章节标题${i}\n\n`;
  for (let j = 0; j < 14; j++) {
    utf8 += `　　这是第${i}章的第${j + 1}段正文。山梨阅读器需要正确处理中文标点、换行与段落缩进，` +
      `并且在做字符级分页时不能让句子断在奇怪的地方。测试文本长度需要足够，以便分页引擎能算出多页。\n`;
  }
  utf8 += '\n';
}
fs.writeFileSync(path.join(out, 'utf8-book.txt'), utf8, 'utf8');

/* ---------- 2. GBK txt（无 BOM，中文） ----------
   Node 不内置 GBK 编码，这里用 lib/gbk.json（双字节 -> Unicode）反查表自己编码，
   这样测试数据生成完全不依赖外部工具，换台机器也能一键复现。 */
const gbkText = utf8.replace('山梨阅读器', '山梨阅读器GBK版');
const gbkPairs = require('../lib/gbk.json');
const toGbk = (() => {
  const rev = new Map();
  for (const [hex, ch] of gbkPairs) {
    if (!rev.has(ch)) rev.set(ch, Buffer.from([parseInt(hex.slice(0, 2), 16), parseInt(hex.slice(2, 4), 16)]));
  }
  return (s) => {
    const chunks = [];
    for (const ch of s) {
      const cp = ch.codePointAt(0);
      if (cp < 0x80) chunks.push(Buffer.from([cp]));
      else if (rev.has(ch)) chunks.push(rev.get(ch));
      else chunks.push(Buffer.from([0x3f])); // 表里没有 -> '?'
    }
    return Buffer.concat(chunks);
  };
})();
fs.writeFileSync(path.join(out, 'gbk-book.txt'), toGbk(gbkText));

/* ---------- 3. UTF-16LE BOM txt ---------- */
const utf16buf = Buffer.concat([
  Buffer.from([0xff, 0xfe]),
  Buffer.from(utf8, 'utf16le'),
]);
fs.writeFileSync(path.join(out, 'utf16-book.txt'), utf16buf);

/* ---------- 4. 无章节标题的 txt ---------- */
let plain = '';
for (let i = 0; i < 300; i++) {
  plain += `第${i}行，这是一段没有章节标题的连续文本，用来测试按字数自动切块的分支逻辑。\n`;
}
fs.writeFileSync(path.join(out, 'plain.txt'), plain, 'utf8');

/* ---------- 5. 极小 epub ---------- */
const AdmZip = require(path.join(__dirname, '..', 'node_modules', 'adm-zip'));
const zip = new AdmZip();

zip.addFile('mimetype', Buffer.from('application/epub+zip', 'utf8'));
zip.addFile(
  'META-INF/container.xml',
  Buffer.from(
    `<?xml version="1.0"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>`,
    'utf8'
  )
);

let opfItems = '';
let opfSpine = '';
let navPoints = '';
for (let i = 1; i <= 6; i++) {
  opfItems += `<item id="c${i}" href="text/ch${i}.xhtml" media-type="application/xhtml+xml"/>\n`;
  opfSpine += `<itemref idref="c${i}"/>\n`;
  navPoints += `<navPoint id="n${i}" playOrder="${i}">
    <navLabel><text>第${i}章 EPUB标题</text></navLabel>
    <content src="text/ch${i}.xhtml"/>
  </navPoint>\n`;

  let body = '';
  for (let j = 0; j < 10; j++) {
    body += `<p>这是 EPUB 第 ${i} 章的第 ${j + 1} 段。段落里包含中英文混排与标点，用于验证 XHTML 转纯文本的质量。</p>\n`;
  }
  zip.addFile(
    `OEBPS/text/ch${i}.xhtml`,
    Buffer.from(
      `<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml"><head><title>第${i}章</title></head>
<body><h2>第${i}章 EPUB标题</h2>${body}</body></html>`,
      'utf8'
    )
  );
}

zip.addFile(
  'OEBPS/content.opf',
  Buffer.from(
    `<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="2.0" unique-identifier="bid">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:title>测试电子书·山梨</dc:title>
    <dc:creator>测试作者</dc:creator>
    <dc:identifier id="bid">urn:uuid:test-0001</dc:identifier>
    <dc:language>zh-CN</dc:language>
  </metadata>
  <manifest>
    ${opfItems}
    <item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>
  </manifest>
  <spine toc="ncx">
    ${opfSpine}
  </spine>
</package>`,
    'utf8'
  )
);

zip.addFile(
  'OEBPS/toc.ncx',
  Buffer.from(
    `<?xml version="1.0" encoding="utf-8"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">
  <head><meta name="dtb:uid" content="urn:uuid:test-0001"/></head>
  <docTitle><text>测试电子书·山梨</text></docTitle>
  <navMap>${navPoints}</navMap>
</ncx>`,
    'utf8'
  )
);

zip.addFile('mimetype', Buffer.from('application/epub+zip', 'utf8'));
const epubPath = path.join(out, 'test-book.epub');
zip.writeZip(epubPath);

/* ---------- 6. 收尾 ---------- */
// 清掉历史遗留的中间文件（早期版本靠 Python 转码时留下的）
for (const stale of ['gbk-raw.bin', 'utf8-source.txt']) {
  const p = path.join(out, stale);
  if (fs.existsSync(p)) fs.unlinkSync(p);
}

console.log('测试文件目录:', out);
console.log(fs.readdirSync(out).join('\n'));
