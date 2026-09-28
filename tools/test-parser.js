'use strict';

/* 解析器自测：跑各种编码与格式，检查中文是否正常 */

const path = require('path');
const os = require('os');
const { parseBook } = require('../lib/book-parser');

const dir = path.join(os.tmpdir(), 'shanli-reader-test');
let pass = 0;
let fail = 0;

function check(name, cond, extra) {
  if (cond) {
    pass++;
    console.log(`  PASS  ${name}${extra ? '  ' + extra : ''}`);
  } else {
    fail++;
    console.log(`  FAIL  ${name}${extra ? '  ' + extra : ''}`);
  }
}

function hasGarbled(s) {
  const bad = (s.match(/[\uFFFD]/g) || []).length;
  return bad / Math.max(s.length, 1) > 0.005;
}

console.log('\n=== UTF-8 txt ===');
{
  const b = parseBook(path.join(dir, 'utf8-book.txt'));
  check('格式识别', b.format === 'txt');
  check('章节数 = 12', b.chapters.length === 12, `实际 ${b.chapters.length}`);
  check('首个章节标题', b.chapters[0].title === '第1章 测试章节标题1', `实际「${b.chapters[0].title}」`);
  check('正文含中文', b.chapters[0].text.includes('山梨阅读器'));
  check('无乱码', !hasGarbled(b.chapters[0].text));
  const total = b.chapters.reduce((n, c) => n + c.text.length, 0);
  check('总字数合理', total > 8000, `${total} 字`);
}

console.log('\n=== GBK txt（无 BOM）===');
{
  const b = parseBook(path.join(dir, 'gbk-book.txt'));
  check('章节数 = 12', b.chapters.length === 12, `实际 ${b.chapters.length}`);
  check('标题中文正确', b.chapters[0].title === '第1章 测试章节标题1', `实际「${b.chapters[0].title}」`);
  check('正文中文正确', b.chapters[0].text.includes('山梨阅读器GBK版'));
  check('无乱码', !hasGarbled(b.chapters[0].text));
  check('未误判为 UTF-8', !b.chapters[0].text.includes('æ'));
}

console.log('\n=== UTF-16LE BOM txt ===');
{
  const b = parseBook(path.join(dir, 'utf16-book.txt'));
  check('章节数 = 12', b.chapters.length === 12, `实际 ${b.chapters.length}`);
  check('标题正确', b.chapters[0].title === '第1章 测试章节标题1', `实际「${b.chapters[0].title}」`);
  check('无乱码', !hasGarbled(b.chapters[0].text));
}

console.log('\n=== 无章节标题 txt（自动分块）===');
{
  const b = parseBook(path.join(dir, 'plain.txt'));
  check('产生多个分块', b.chapters.length > 1, `${b.chapters.length} 块`);
  check('内容完整', b.chapters.map((c) => c.text).join('').includes('第299行'));
}

console.log('\n=== EPUB ===');
{
  const b = parseBook(path.join(dir, 'test-book.epub'));
  check('格式识别', b.format === 'epub');
  check('书目元数据标题', b.title === '测试电子书·山梨', `实际「${b.title}」`);
  check('章节数 = 6', b.chapters.length === 6, `实际 ${b.chapters.length}`);
  check('章节标题取自 h2', b.chapters[0].title === '第1章 EPUB标题', `实际「${b.chapters[0].title}」`);
  check('正文非空', b.chapters[0].text.length > 100, `${b.chapters[0].text.length} 字`);
  check('正文无 HTML 标签', !/<[a-z/]/i.test(b.chapters[0].text));
  check('无乱码', !hasGarbled(b.chapters[0].text));
  check('目录条目 = 6', b.toc.length === 6, `实际 ${b.toc.length}`);
  check('目录首项', b.toc[0].title === '第1章 EPUB标题', `实际「${b.toc[0].title}」`);
  check('目录 href 能映射到章节', b.toc[0].href === 'OEBPS/text/ch1.xhtml', `实际「${b.toc[0].href}」`);
}

console.log('\n=== 编码探测单测 ===');
{
  const { decodeBuffer } = require('../lib/book-parser');
  const fs = require('fs');
  check('GBK 流解码', decodeBuffer(fs.readFileSync(path.join(dir, 'gbk-book.txt'))).includes('中文'));
  check('UTF-8 流解码', decodeBuffer(Buffer.from('中文测试', 'utf8')) === '中文测试');
  check('空流', decodeBuffer(Buffer.alloc(0)) === '');
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败\n`);
process.exit(fail > 0 ? 1 : 0);
