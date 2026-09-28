'use strict';

/* ============================================================
   山梨阅读器 — 渲染层
   核心：一个字符级分页引擎 + 单行阅读模式
   ============================================================ */

const $ = (id) => document.getElementById(id);

const els = {
  frame: $('frame'),
  stage: $('stage'),
  viewport: $('viewport'),
  content: $('content'),
  empty: $('empty'),
  bar: $('bar'),
  hud: $('hud'),
  toast: $('toast'),
  jump: $('jump'),
  jumpInput: $('jumpInput'),
  jumpHint: $('jumpHint'),
  toc: $('toc'),
  tocList: $('tocList'),
};

/* 离屏量尺：分页引擎的唯一高度来源，排版规则与「正常分页」一致 */
const measureEl = $('measure');

/* ------------------------------------------------------------------ *
 *  状态（全部在内存，不落盘）
 * ------------------------------------------------------------------ */

const S = {
  // 书籍
  book: null,            // { title, format, chapters:[{title,text}], filePath, ... }
  toc: [],               // 章节扁平列表 [{title, chapterIndex, charStart}]
  flat: '',              // 全书拼接文本（用于精确分页）
  flatLine: '',          // 同 flat，但换行/制表符已 1:1 换成空格，供单行模式使用
  chapterOffsets: [],    // 每章在 flat 中的起始偏移

  // 阅读位置
  page: 0,
  pages: [],             // [{start, end, chapterIndex, chapterStart}] 按需生成
  pageCharStart: 0,      // 当前页字符起点（分页失效时用它恢复）

  // 外观
  // 默认：底色完全透明 + 米白文字（浮在桌面上），14px 字号
  bg: '#1e1e1e',
  bgAlpha: 0,
  fg: '#e8e4dc',
  fgIsAuto: false,
  fontSize: 14,
  lineHeight: 1.6,
  fontFamily: 'system',
  bold: false,
  frameOn: true,
  shadow: true,          // 文字投影：透明底时保证在任何壁纸上都读得清

  // 模式
  singleLine: false,
  lineFontSize: 14,      // 单行模式下的字号
  _fontBeforeSingle: null, // 进入单行前的正文字号，退出时还原

  // 单行行表（懒生成）
  lineStarts: null,
  lineWidth: 0,
  lineChars: 0,
  lineIndex: 0,
};

const FONT_STACKS = {
  system: 'system-ui, -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif',
  '"SimSun", "宋体", serif': '"SimSun", "宋体", serif',
  '"SimHei", "Microsoft YaHei", sans-serif': '"SimHei", "Microsoft YaHei", sans-serif',
  '"Microsoft YaHei", "微软雅黑", sans-serif': '"Microsoft YaHei", "微软雅黑", sans-serif',
  '"KaiTi", "楷体", serif': '"KaiTi", "楷体", serif',
  '"FangSong", "仿宋", serif': '"FangSong", "仿宋", serif',
  '"Source Han Serif SC", "Noto Serif SC", serif': '"Source Han Serif SC", "Noto Serif SC", serif',
};

/* ------------------------------------------------------------------ *
 *  底层：字符级分页引擎
 *  原理：二分查找「塞进当前可视高度需要的最大字符数」，
 *        再在附近找最近的段落/句子边界作为切点，避免断句难看。
 * ------------------------------------------------------------------ */

/**
 * 二分找出在给定高度内最多能放下多少字符。
 *
 * 量尺有一个不可忽略的「基线高度」（空内容时的 scrollHeight，含上下 padding），
 * 所以比较时必须用「内容实际占用的高度」= scrollHeight - baseline，
 * 否则窗口比一行还矮时会退化成「一页一个字」。
 *
 * @param {string} text       待测量文本
 * @param {number} boxHeight  可用总高度（含 padding）
 * @param {number} boxWidth   可用宽度
 */
function fitChars(text, boxHeight, boxWidth) {
  if (!text) return 0;
  if (boxHeight <= 0) return 1;

  const m = measureEl;
  m.style.width = Math.max(20, Math.round(boxWidth || els.viewport.clientWidth)) + 'px';
  m.style.height = 'auto';
  m.style.maxHeight = 'none';

  // 基线：空内容时的高度（padding 等）
  m.textContent = '';
  const baseline = m.scrollHeight;
  const usable = Math.max(1, boxHeight - baseline);

  const probe = (n) => {
    m.textContent = text.slice(0, n);
    return m.scrollHeight - baseline;
  };

  // 一个字符都放不下 → 至少返回 1，保证不会出现空页
  if (probe(1) > usable) return 1;

  let lo = 1;
  let hi = 1;
  const max = text.length;
  let overflow = false;
  while (hi < max) {
    hi = Math.min(max, hi * 2);
    if (probe(hi) > usable) { overflow = true; break; }
    lo = hi;
  }
  if (!overflow && probe(max) <= usable) return max;

  while (lo < hi) {
    const mid = Math.floor((lo + hi + 1) / 2);
    if (probe(mid) <= usable) lo = mid;
    else hi = mid - 1;
  }
  return Math.max(1, lo);
}

const SOFT_BREAK = /[。！？…；：""''）】」』!?;:.)\]]/;
const HARD_BREAK = /[\n]/;

/** 从 from 处向前找最近的「好切点」，最多退让 maxBack 个字符 */
function findBreak(text, from, maxBack, base) {
  base = base || 0;
  const lo = Math.max(base + 1, from - maxBack);
  // 优先段落边界
  for (let i = from - 1; i >= lo; i--) {
    if (text[i] === '\n') return i + 1;
  }
  // 其次句末标点（跳过其后紧跟的引号/括号）
  for (let i = from - 1; i >= lo; i--) {
    if (SOFT_BREAK.test(text[i])) {
      let j = i + 1;
      while (j < text.length && /[""'）】」』)]/.test(text[j])) j++;
      return j;
    }
  }
  return from;
}

/**
 * 分页。两种模式：
 *   paginate(null)        → 全书重新分页
 *   paginate(fromIndex)   → 从第 fromIndex 页继续往后补，保留之前的结果
 */
function paginate(fromIndex) {
  const h = pageBoxHeight();
  const w = pageBoxWidth();
  if (h <= 8 || w <= 24) return;

  // 窗口尺寸/字号变了，先同步量尺与内边距，再分页
  syncContentPadding();
  syncMeasure();  const text = S.flat;
  if (!text) return;

  let start;
  let limit;

  if (fromIndex == null) {
    S.pages = [];
    start = 0;
    limit = Infinity;
  } else {
    if (!S.pages.length) return paginate(null);
    const idx = Math.min(fromIndex, S.pages.length - 1);
    S.pages = S.pages.slice(0, idx + 1);
    start = S.pages[idx].end;
    limit = S.pages.length + 4; // 每次只多补几页，避免卡顿
  }

  let guard = 0;
  while (start < text.length) {
    if (S.pages.length >= limit) break;
    if (++guard > 30000) break;

    const rest = text.slice(start);
    let take = fitChars(rest, h, w);
    if (take >= rest.length) {
      // 剩下的全部放得下
      S.pages.push({ start, end: text.length, chapterIndex: chapterAt(start) });
      break;
    }
    // 被截断了 → 往前找更自然的断点
    take = findBreak(rest, take, Math.min(80, take - 1), 0);
    if (take <= 0) take = 1;
    S.pages.push({ start, end: start + take, chapterIndex: chapterAt(start) });
    start += take;
  }
}

/** 一直补页到总页数覆盖 whole book（用于百分比跳转 / 末尾） */
function paginateAll() {
  let guard = 0;
  while (
    S.pages.length &&
    S.pages[S.pages.length - 1].end < S.flat.length &&
    guard < 400
  ) {
    const before = S.pages.length;
    paginate(S.pages.length - 1);
    if (S.pages.length === before) break;
    guard++;
  }
  return S.pages.length;
}

function padX() {
  const v = getComputedStyle(els.content).paddingLeft;
  return parseFloat(v) || 0;
}

function padY() {
  const v = getComputedStyle(els.content).paddingTop;
  return parseFloat(v) || 0;
}

/**
 * 普通分页模式下，正文可用高度（含上下 padding，与 scrollHeight 同口径）。
 *
 * 窗口被压得比「一行 + 上下 padding」还矮时，需要动态收缩内边距，
 * 否则测出的可用高度不足一行，会退化成「一页一个字」。
 * 这里返回一个「保证至少能放下一行」的高度，实际渲染时同步收缩 padding。
 */
function pageBoxHeight() {
  const h = els.viewport.clientHeight;
  const lineH = contentLineHeight();
  const need = Math.ceil(lineH);           // 一行文字本身
  if (h >= need + 4) return h;
  // 窗口极矮：可用高度就是窗口高度本身（配合下面的 padding 收缩）
  return Math.max(need, h);
}

/** 根据窗口高度动态调整正文上下内边距，保证极小窗口也能正常分页 */
function syncContentPadding() {
  const h = els.viewport.clientHeight;
  const lineH = contentLineHeight();
  const padX = padXValue();
  // 目标：窗口高度至少要放得下「一行文字 + 上下留白」
  // 留白优先给 20px（舒适），放不下就一路压缩，最低给 2px
  // 单行模式窗口本来就只有一行高，上下不给留白（垂直居中交给 flex）
  const want = S.singleLine
    ? 0
    : Math.max(2, Math.min(20, Math.floor((h - lineH) / 2)));
  const p = String(want) + 'px';
  els.content.style.paddingTop = p;
  els.content.style.paddingBottom = p;
  els.content.style.paddingLeft = padX + 'px';
  els.content.style.paddingRight = padX + 'px';
  measureEl.style.paddingTop = p;
  measureEl.style.paddingBottom = p;
  measureEl.style.paddingLeft = padX + 'px';
  measureEl.style.paddingRight = padX + 'px';
}

/** 正文左右内边距：窗口很窄时同步收缩，避免正文宽度只剩几个字符 */
function padXValue() {
  const w = els.viewport.clientWidth;
  if (S.singleLine) {
    // 单行模式一行就是全部内容，留白越小、可读字符越多
    if (w < 160) return 4;
    if (w < 260) return 8;
    return 14;
  }
  if (w < 160) return 6;
  if (w < 260) return 12;
  return 26;
}

/** 当前正文实际的行高（px） */
function contentLineHeight() {
  const cs = getComputedStyle(measureEl);
  const lh = parseFloat(cs.lineHeight);
  if (lh > 0) return lh;
  const fs = parseFloat(cs.fontSize) || S.fontSize || 14;
  return fs * (S.lineHeight || 1.6);
}

/** 普通分页模式下，正文可用宽度（含左右 padding） */
function pageBoxWidth() {
  return els.viewport.clientWidth;
}

function chapterAt(charIndex) {
  const offs = S.chapterOffsets;
  if (!offs.length) return 0;
  // 偏移量单调递增，直接二分，边界行为明确
  let lo = 0;
  let hi = offs.length - 1;
  let ans = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (offs[mid] <= charIndex) {
      ans = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return ans;
}
/* ------------------------------------------------------------------ *
 *  渲染
 * ------------------------------------------------------------------ */

/* 翻页渲染：直接换字，不做任何过渡动画。
   （单行模式下每次滚轮只前进一行，任何位移/淡入都会被看成「文字在抖」，
     所以这里刻意不挂 class、不加 transition。） */
function renderPage() {
  if (!S.book || !S.pages.length) return;
  if (S.page >= S.pages.length) S.page = S.pages.length - 1;
  if (S.page < 0) S.page = 0;

  const p = S.pages[S.page];
  S.pageCharStart = p.start;

  if (S.singleLine) {
    // 单行模式：读 flatLine，且**不做任何空白折叠/裁剪**。
    // 与 measureLineChars 保持完全一致（同一份文本、同样的白空格规则），
    // 这样「量出来的那一行」和「渲染出来的那一行」是同一段文字。
    els.content.textContent = (S.flatLine || S.flat).slice(p.start, p.end);
  } else {
    els.content.textContent = S.flat.slice(p.start, p.end);
  }

  updateProgress();
  updateHud();
}

function updateProgress() {
  const total = Math.max(S.pages.length, 1);
  const pct = ((S.page + 1) / total) * 100;
  els.bar.style.width = pct.toFixed(2) + '%';
}

function updateHud() {
  if (!S.book) return;
  const chapter = S.book.chapters[S.pages[S.page]?.chapterIndex ?? 0];
  const total = S.pages.length;
  els.hud.textContent = `${S.page + 1} / ${total}`;
}

function showHud() {
  els.hud.classList.add('show');
  clearTimeout(showHud._t);
  showHud._t = setTimeout(() => els.hud.classList.remove('show'), 1200);
}

let toastTimer = null;
function toast(msg) {
  els.toast.textContent = msg;
  els.toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => els.toast.classList.remove('show'), 1500);
}

/* ------------------------------------------------------------------ *
 *  翻页
 * ------------------------------------------------------------------ */

function go(delta) {
  if (!S.book) {
    toast('先导入一本书：右键 →「导入书籍…」');
    return;
  }

  const total = S.pages.length;

  // 向前翻且已经接近已生成页末尾 → 先补页
  if (delta > 0 && S.page >= total - 2) {
    const before = S.pages.length;
    paginate(total - 1);
    if (S.pages.length === before && S.page >= S.pages.length - 1) {
      toast('已经是最后一页了');
      return;
    }
  }

  const next = Math.max(0, Math.min(S.page + delta, S.pages.length - 1));
  if (next === S.page) {
    toast(delta > 0 ? '已经是最后一页了' : '已经是第一页了');
    return;
  }
  S.page = next;

  // 翻到新末尾后再补一点，保证后续翻页顺滑
  if (S.page >= S.pages.length - 3) {
    paginate(S.pages.length - 1);
    if (S.page >= S.pages.length) S.page = S.pages.length - 1;
  }

  renderPage();
  showHud();
}

function goToPage(n) {
  if (!S.book) return;
  while (n > S.pages.length - 2 && S.pages[S.pages.length - 1].end < S.flat.length) {
    const before = S.pages.length;
    paginate(S.pages.length - 1);
    if (S.pages.length === before) break;
  }
  S.page = Math.max(0, Math.min(n, S.pages.length - 1));
  renderPage();
  showHud();
}

function goToChar(charIndex) {
  if (!S.book || !S.pages.length) return;
  const target = Math.max(0, Math.min(charIndex, S.flat.length - 1));

  // 找「包含 target 的那一页」：满足 page.start <= target < page.end
  let hit = -1;
  let guard = 0;
  while (guard++ < 500) {
    let lo = 0;
    let hi = S.pages.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (S.pages[mid].start <= target) { hit = mid; lo = mid + 1; }
      else hi = mid - 1;
    }
    // 上面的二分给出最后一个 start <= target 的页，再确认 target 落在其区间内
    if (hit >= 0 && target < S.pages[hit].end) break;

    if (S.pages[S.pages.length - 1].end >= S.flat.length) {
      hit = Math.max(0, Math.min(hit, S.pages.length - 1));
      break;
    }
    const before = S.pages.length;
    paginate(S.pages.length - 1);
    if (S.pages.length === before) break;
  }

  if (hit >= 0) {
    S.page = hit;
    S.pages[hit].chapterIndex = chapterAt(S.pages[hit].start);
    renderPage();
    showHud();
  }
}

/**
 * 跳到「从 charIndex 开始的新一页」。
 * 用于章节跳转 / 目录跳转，保证标题出现在页首，而不是被截在页中。
 */
function goToCharAtPageStart(charIndex) {
  if (!S.book || !S.pages.length) return;
  const target = Math.max(0, Math.min(charIndex, S.flat.length - 1));

  // 先确保这一页已生成
  goToChar(target);

  // 若当前页起点早于 target，把这一页从 target 处切开，让 target 成为页首
  const p = S.pages[S.page];
  if (p && p.start < target) {
    S.pages.splice(S.page, 1,
      { start: p.start, end: target, chapterIndex: chapterAt(p.start) },
      { start: target, end: p.end, chapterIndex: chapterAt(target) }
    );
    S.page = S.page + 1;
    renderPage();
    showHud();
  }
}

/* ------------------------------------------------------------------ *
 *  单行模式：逐行滚动
 *
 *  设计要点（解决「前进/后退不可逆」的漂移问题）：
 *  单行模式下不按「字符偏移 + N」来推算，而是把整本书在给定宽度下
 *  预切成一个**行起点数组** lineStarts[]。之后前进就是 index+1，
 *  后退就是 index-1，天然严格可逆，不会因为重新测量而漂移。
 *
 *  行起点数组按需懒生成：只切到当前阅读位置往后若干行，避免长书卡顿。
 * ------------------------------------------------------------------ */

S.lineStarts = null;     // 行起点（字符下标）数组
S.lineWidth = 0;         // 生成时的可用宽度，宽度变了要重建
S.lineChars = 0;         // 上一行量出来的字符数，作为下一行的测量预估
S.lineIndex = 0;         // 当前处于第几行

/** 单行模式下「一行文字」占据的高度 */
function singleLineLineHeight() {
  const fs = S.lineFontSize || S.fontSize || 14;
  return Math.round(fs * 1.4);
}

/**
 * 单行模式下的可用宽度。
 *
 * 必须**实测**正文元素的内容盒，不能写死「窗口宽 - 24」：
 * 正文的左右内边距是被 syncContentPadding 用内联样式写上去的（26px），
 * 内联样式优先级高于 CSS 里的 body.single .content{padding:0 12px}，
 * 所以「假设 12px」会让量出来的行宽比实际可视区宽 28px ——
 * 结果就是每一行末尾都被裁掉，读起来上一行和下一行接不上。
 */
function singleLineWidth() {
  const cs = getComputedStyle(els.content);
  const padL = parseFloat(cs.paddingLeft) || 0;
  const padR = parseFloat(cs.paddingRight) || 0;
  const box = els.content.clientWidth - padL - padR;
  if (box > 20) return Math.floor(box);
  // 极端情况（元素还没布局出来）退回按窗口估算
  return Math.max(40, Math.floor(els.viewport.clientWidth - 2 * padXValue()));
}

/**
 * 量出一行能容纳多少字符（从 fromChar 开始，按 nowrap 横向测量）。
 * 测量文本用 S.flatLine，与 renderPage 渲染时读的是同一份，逐字符对齐。
 */
function measureLineChars(fromChar) {
  const w = singleLineWidth();
  // 留 1px 余量：字体亚像素渲染可能让「刚好等于」变成溢出，宁可少放一个字
  const fitW = Math.max(20, w - 1);

  measureEl.classList.add('nowrap');
  measureEl.style.whiteSpace = 'pre';
  measureEl.style.textAlign = 'left';
  measureEl.style.width = fitW + 'px';
  measureEl.style.height = 'auto';
  measureEl.style.padding = '0px';

  const src = S.flatLine || S.flat;
  const text = src.slice(fromChar);
  const max = text.length;
  if (max <= 0) {
    measureEl.classList.remove('nowrap');
    measureEl.style.whiteSpace = '';
    measureEl.style.textAlign = '';
    measureEl.style.width = '';
    measureEl.style.padding = '';
    return 0;
  }

  const probe = (n) => {
    measureEl.textContent = text.slice(0, n);
    return measureEl.scrollWidth;
  };

  // 先用「上一行的字符数」当预估，通常两三次探测就收敛，
  // 避免每次都从 1 开始翻倍（长书跳转时会明显卡）
  const hint = Math.max(1, Math.min(max, Math.round(S.lineChars) || 1));

  let lo = 0;
  let hi = hint;
  let result = -1;

  if (probe(hi) <= fitW) {
    lo = hi;
    if (lo >= max) {
      result = max;
    } else {
      for (;;) {
        const nx = Math.min(max, hi * 2);
        if (probe(nx) > fitW) { hi = nx; break; }
        lo = nx;
        hi = nx;
        if (lo >= max) { result = max; break; }
      }
    }
  }

  if (result < 0) {
    // 不变量：probe(lo) <= fitW，probe(hi) > fitW，且 lo < hi
    while (lo < hi) {
      const mid = Math.floor((lo + hi + 1) / 2);
      if (probe(mid) <= fitW) lo = mid;
      else hi = mid - 1;
    }
    result = Math.max(1, lo);
  }

  measureEl.classList.remove('nowrap');
  measureEl.style.whiteSpace = '';
  measureEl.style.textAlign = '';
  measureEl.style.width = '';
  measureEl.style.padding = '';
  return result;
}

/**
 * 把书预切成行起点数组。
 *
 * 行表**必须覆盖到 upTo**（否则跳转过去会落在错误的行上）。
 * 这里保证循环到「当前行起点已经越过 upTo」为止 —— 也就是
 * 包含 upTo 的那一行连它的 end 都已经算出来。
 *
 * @param {number} upTo 至少覆盖到哪个字符位置
 */
function buildLineStarts(upTo) {
  const src = S.flatLine || S.flat;
  const w = singleLineWidth();

  // 宽度变了（或首次）→ 整体重建
  if (!S.lineStarts || S.lineWidth !== w) {
    S.lineStarts = [0];
    S.lineWidth = w;
    S.lineChars = 0;      // 行宽预估也要跟着失效
  }
  if (!src.length) {
    S.lineStarts = [0];
    return;
  }

  const goal = Math.max(0, Math.min(upTo, src.length - 1));
  let pos = S.lineStarts[S.lineStarts.length - 1];
  let guard = 0;

  while (pos <= goal && pos < src.length && guard++ < 300000) {
    const n = measureLineChars(pos);
    if (n <= 0) break;
    pos += n;
    if (pos >= src.length) {
      S.lineStarts.push(src.length);
      break;
    }
    S.lineStarts.push(pos);
    // 用刚量出来的行宽更新预估，下一次测量更快收敛
    S.lineChars = n;
  }
}

/** 二分找出「包含 charIndex 的那一行的行号」 */
function lineIndexAt(charIndex) {
  const a = S.lineStarts;
  if (!a || !a.length) return 0;
  let lo = 0;
  let hi = a.length - 1;
  let ans = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (a[mid] <= charIndex) { ans = mid; lo = mid + 1; }
    else hi = mid - 1;
  }
  return ans;
}

/** 单行模式下，把当前行同步到页面状态 */
function syncSinglePage() {
  const a = S.lineStarts;
  if (!a || !a.length) return;
  const src = S.flatLine || S.flat;
  const i = Math.max(0, Math.min(S.lineIndex, a.length - 1));
  S.lineIndex = i;
  const start = Math.min(a[i], Math.max(0, src.length - 1));
  // end 必须取「下一行的起点」。行表最后一项代表全书末尾，不是一行，
  // 只有它之后没有下一项时才允许兜底，否则会把整本书的剩余部分当成一行渲染。
  const end = i + 1 < a.length ? a[i + 1] : src.length;
  S.pages = [{ start, end: Math.max(start + 1, end), chapterIndex: chapterAt(start) }];
  S.page = 0;
  S.pageCharStart = start;
}

/**
 * 行表里「起点和终点都已知」的最大行号。
 *
 * 第 k 行 = [a[k], a[k+1])，要显示第 k 行就必须存在 a[k+1]，
 * 所以最大可导航行号恒为 a.length - 2（末尾那项若是全书长度，也只是个哨兵）。
 */
function lastNavigableLine() {
  const a = S.lineStarts;
  if (!a || a.length < 2) return -1;
  return a.length - 2;
}

/** 行表是否已经切到全书末尾 */
function linesComplete(srcLen) {
  const a = S.lineStarts;
  return !!a && a.length > 0 && a[a.length - 1] >= srcLen;
}

function rebuildSinglePages() {
  // 先定内边距（决定可用宽度），再建行表，顺序不能反
  syncContentPadding();
  singleLineReset();
  if (!S.book) return;
  const src = S.flatLine || S.flat;
  const start = Math.max(0, Math.min(S.pageCharStart, Math.max(0, src.length - 1)));
  buildLineStarts(start);
  S.lineIndex = lineIndexAt(start);
  syncSinglePage();
}

/** 单行状态复位（切换书籍、改字号、改宽度时调用） */
function singleLineReset() {
  S.lineStarts = null;
  S.lineWidth = 0;
  S.lineChars = 0;
  S.lineIndex = 0;
}

function singleLineStep(dir) {
  const src = S.flatLine || S.flat;
  if (!S.book || !src) return;

  // 窗口宽度/字号变了 → 行表失效（singleLineReset 会把 lineWidth 归零）
  if (!S.lineStarts || S.lineWidth !== singleLineWidth()) {
    rebuildSinglePages();
  }
  // 保证行表覆盖到当前位置，否则 lineIndexAt 会落到错误的行
  buildLineStarts(S.pageCharStart);
  if (!S.lineStarts.length) return;

  // 以「当前字符位置」为准反推行号，避免外部直接改 pageCharStart 导致不同步
  const cur = lineIndexAt(S.pageCharStart);
  S.lineIndex = cur;

  const next = cur + dir;

  if (next < 0) {
    toast('已经到开头了');
    return;
  }

  // 目标行必须已经是一行「完整」的记录（起点 + 终点都算出来了），
  // 否则 syncSinglePage 拿不到下一行的起点，会把全书剩余部分当成一行。
  // 这里只补需要的行数，不整本展开。
  let guard = 0;
  while (next > lastNavigableLine()) {
    if (linesComplete(src.length)) break;
    const before = S.lineStarts.length;
    buildLineStarts(S.lineStarts[before - 1]);   // 再补一行
    if (S.lineStarts.length === before) break;
    if (guard++ > 500) break;
  }

  if (next > lastNavigableLine()) {
    toast('已经读到末尾了');
    return;
  }

  S.lineIndex = next;
  syncSinglePage();
  renderPage();
  showHud();
}

function lineBoxHeight() {
  // 兼容旧调用点：单行模式下窗口高度应当等于一行文字的高度
  return singleLineLineHeight();
}

/* ------------------------------------------------------------------ *
 *  书载入
 * ------------------------------------------------------------------ */

/** 统一换行符：\r\n 与裸 \r 都归一成 \n，避免单行模式下凭空多出一个空格 */
function normEol(s) {
  return String(s).replace(/\r\n?/g, '\n');
}

function loadBook(book) {
  S.book = book;
  S.toc = [];

  // 拼全书 + 记录章节偏移
  S.flat = '';
  S.chapterOffsets = [];
  book.chapters.forEach((c, i) => {
    // 先记录本章起点，再追加内容（顺序不能反，否则每章偏移会差一段）
    S.chapterOffsets.push(S.flat.length);
    const head = c.title ? normEol(c.title) + '\n' : '';
    let body = normEol(c.text || '');
    // 去掉正文里重复的标题行
    if (c.title && body.trim().startsWith(c.title.trim())) {
      body = body.trim().slice(c.title.trim().length).replace(/^\s*\n/, '');
    }
    S.flat += head + body + '\n\n';
  });

  // 单行模式专用副本。
  // 关键：这里是**逐个字符 1:1** 替换（换行/制表符各变一个空格），
  // 不做「连续空白压成一个」。这样 S.flatLine 与 S.flat 长度、下标完全一致，
  // 章节偏移、跳转定位都能直接复用；同时保证
  // 「从某位置量宽度」的结果 = 「渲染该位置那一段」的宽度，
  // 否则行边界会随测量起点漂移，出现「上一行与下一行接不上」。
  S.flatLine = S.flat.replace(/[\n\t\f\v\u2028\u2029]/g, ' ');

  // 目录：epub 优先用 ncx，txt 用章节标题
  if (book.toc && book.toc.length) {
    // 把 toc 的 href 映射到章节索引
    const hrefMap = new Map();
    book.chapters.forEach((c, i) => {
      if (c.href) hrefMap.set(c.href, i);
    });
    book.toc.forEach((t) => {
      const ci = hrefMap.get(t.href);
      if (ci != null) {
        S.toc.push({
          title: t.title,
          chapterIndex: ci,
          charStart: S.chapterOffsets[ci],
        });
      }
    });
  }
  if (S.toc.length === 0) {
    book.chapters.forEach((c, i) => {
      const t = (c.title || '').trim();
      if (t) S.toc.push({ title: t, chapterIndex: i, charStart: S.chapterOffsets[i] });
    });
  }
  // 给无标题章节补个假目录，保证目录可用
  if (S.toc.length === 0) {
    book.chapters.forEach((c, i) => {
      S.toc.push({ title: `第 ${i + 1} 节`, chapterIndex: i, charStart: S.chapterOffsets[i] });
    });
  }

  els.empty.classList.add('hide');
  S.page = 0;
  S.pageCharStart = 0;

  if (S.singleLine) {
    rebuildSinglePages();
    renderPage();
  } else {
    paginate(null);
    renderPage();
  }

  const mins = ((Date.now() - (book._t0 || Date.now())) / 1000).toFixed(1);
  toast(`已载入《${book.title}》 · ${book.chapters.length} 章 · ${S.pages.length} 页`);
  updateTitle();
}

function updateTitle() {
  if (!S.book) {
    document.title = '山梨阅读器';
    return;
  }
  document.title = `${S.book.title} — 山梨阅读器`;
}

/* ------------------------------------------------------------------ *
 *  外观应用
 * ------------------------------------------------------------------ */

/* 文字投影：透明底 + 米白字时，靠它保证在任意壁纸上都能读清。
   近处一层压暗轮廓（浅色桌面上也能读），远处一层柔光（深色桌面上更厚实） */
const SHADOW_ON = '0 1px 2px rgba(0,0,0,.9), 0 0 5px rgba(0,0,0,.65)';
const SHADOW_OFF = 'none';

function applyTheme() {
  const root = document.documentElement.style;
  root.setProperty('--bg', S.bg);
  root.setProperty('--bg-alpha', String(S.bgAlpha));
  root.setProperty('--fg', S.fg);
  root.setProperty('--fs', S.fontSize + 'px');
  root.setProperty('--lh', String(S.lineHeight));
  root.setProperty('--shadow', S.shadow ? SHADOW_ON : SHADOW_OFF);

  const stack = FONT_STACKS[S.fontFamily] || S.fontFamily || FONT_STACKS.system;
  root.setProperty('--ff', stack);

  els.content.classList.toggle('bold', !!S.bold);
  measureEl.classList.toggle('bold', !!S.bold);
  els.frame.classList.toggle('no-frame', !S.frameOn);

  if (S.singleLine) {
    root.setProperty('--line-box', singleLineBoxPx() + 'px');
  }
  // 让量尺与正文同宽，分页结果才准确
  syncMeasure();
}

/** 量尺尺寸与正文可视区保持一致（分页精度的前提） */
function syncMeasure() {
  const w = Math.max(20, els.viewport.clientWidth);
  measureEl.style.width = w + 'px';
  measureEl.style.height = 'auto';
}

function singleLineBoxPx() {
  return singleLineLineHeight();
}

/** 相对亮度 0~1 */
function luminance(hex) {
  const c = String(hex || '').replace('#', '');
  const r = parseInt(c.slice(0, 2), 16) || 0;
  const g = parseInt(c.slice(2, 4), 16) || 0;
  const b = parseInt(c.slice(4, 6), 16) || 0;
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
}

/** 自动对比：底色深则用浅字，反之用深字 */
function autoTextColor() {
  S.fg = luminance(S.bg) < 0.5 ? '#eae6de' : '#1a1a1a';
}

/**
 * 底色变成不透明（或换底色）后，若文字与底色亮度太接近就自动反转。
 * 场景：默认是「透明底 + 米白字」，此时选「纯白」底色 → 米白字会看不见。
 * 完全透明时不干预（文字浮在桌面上，底色不参与）。
 */
function ensureReadable() {
  if (S.bgAlpha < 0.5) return false;
  if (Math.abs(luminance(S.bg) - luminance(S.fg)) >= 0.35) return false;
  autoTextColor();
  return true;
}

function reflow(keepChar) {
  // 默认锚定「当前页的起始字符」，这样重排后视觉位置不会漂移
  const at = keepChar != null ? keepChar : S.pageCharStart;
  if (!S.book) return;

  if (S.singleLine) {
    document.documentElement.style.setProperty('--line-box', singleLineBoxPx() + 'px');
    api.setSingleLine({ on: true, lineHeight: singleLineBoxPx() });
    S.pageCharStart = at;
    singleLineReset();       // 字号/行距变了，行表必须重建
    rebuildSinglePages();
    renderPage();
  } else {
    paginate(null);
    goToChar(at);
  }
  updateProgress();
}

/* ------------------------------------------------------------------ *
 *  右键菜单
 * ------------------------------------------------------------------ */

function menuContext() {
  return {
    hasBook: !!S.book,
    title: S.book ? S.book.title : '',
    chapterTitle: S.book && S.pages[S.page]
      ? (S.book.chapters[S.pages[S.page].chapterIndex]?.title || `第 ${S.pages[S.page].chapterIndex + 1} 章`)
      : '',
    percent: S.pages.length ? (S.page + 1) / S.pages.length : 0,
    page: S.page,
    pages: S.pages.length,
    bgColor: S.bg,
    bgAlpha: S.bgAlpha,
    textColor: S.fg,
    shadow: S.shadow,
    fontSize: S.fontSize,
    lineHeight: S.lineHeight,
    fontFamily: S.fontFamily,
    bold: S.bold,
    singleLine: S.singleLine,
    alwaysOnTop: false,
    frameOn: S.frameOn,
    hasSelection: !!String(window.getSelection() || '').trim(),
    toc: S.toc.map((t) => ({ title: t.title })),
    chapterIndex: S.pages[S.page]?.chapterIndex ?? 0,
  };
}

let aotState = false;
function showMenu() {
  api.win.isAlwaysOnTop().then((v) => {
    aotState = v;
    const ctx = menuContext();
    ctx.alwaysOnTop = v;
    api.showMenu(ctx);
  });
}

/* ------------------------------------------------------------------ *
 *  跳转
 * ------------------------------------------------------------------ */

function openJump(prefill) {
  if (!S.book) {
    toast('先导入一本书');
    return;
  }
  els.jump.classList.add('show');
  els.jumpInput.value = prefill || '';
  els.jumpHint.innerHTML =
    `当前：第 ${S.page + 1} / ${S.pages.length} 页　·　` +
    `共 ${S.book.chapters.length} 章　·　` +
    `进度 ${(((S.page + 1) / S.pages.length) * 100).toFixed(1)}%<br>` +
    `输入示例：<b>12</b>（第12章）　<b>480</b>（第480页）　<b>36%</b>（百分比）`;
  setTimeout(() => els.jumpInput.focus(), 30);
}

function closeJump() {
  els.jump.classList.remove('show');
}

function doJump(raw) {
  const s = String(raw || '').trim();
  if (!s) return;

  // 百分比
  const pm = s.match(/^(\d+(?:\.\d+)?)\s*%$/);
  if (pm) {
    const ratio = Math.min(1, Math.max(0, parseFloat(pm[1]) / 100));
    const target = Math.round(ratio * (countAllPages() - 1));
    goToPage(target);
    toast(`已跳转至 ${(ratio * 100).toFixed(1)}%`);
    return;
  }

  // 「第N章」
  const cm = s.match(/^第?\s*(\d+)\s*[章节回]$/);
  if (cm) {
    const n = parseInt(cm[1], 10);
    gotoChapter(n - 1);
    return;
  }

  // 纯数字：小于章节数按章，否则按页
  const nm = s.match(/^(\d+)$/);
  if (nm) {
    const n = parseInt(nm[1], 10);
    if (n <= S.book.chapters.length && n <= 200) {
      gotoChapter(n - 1);
    } else {
      goToPage(n - 1);
    }
    return;
  }

  // 文本匹配章节标题
  const hit = S.toc.findIndex((t) => t.title && t.title.includes(s));
  if (hit >= 0) {
    goToCharAtPageStart(S.toc[hit].charStart);
    toast(`已跳转到「${S.toc[hit].title}」`);
    return;
  }

  toast('没看懂这个输入，试试 12 / 480 / 36%');
}

function countAllPages() {
  // 确保分页完整（长书按需生成）
  let guard = 0;
  while (S.pages.length && S.pages[S.pages.length - 1].end < S.flat.length && guard < 500) {
    const before = S.pages.length;
    paginate(S.pages.length - 1);
    if (S.pages.length === before) break;
    guard++;
  }
  return S.pages.length;
}

function gotoChapter(i) {
  if (!S.book || i < 0 || i >= S.book.chapters.length) {
    toast('没有这一章');
    return;
  }

  // 让章节标题出现在页首，而不是被截在上一页的页尾
  goToCharAtPageStart(S.chapterOffsets[i]);

  const t = S.toc.find((x) => x.chapterIndex === i);
  toast(`第 ${i + 1} 章${t && t.title ? ' · ' + t.title : ''}`);
}

/* ------------------------------------------------------------------ *
 *  目录
 * ------------------------------------------------------------------ */

function openToc() {
  if (!S.book) return;
  els.tocList.innerHTML = '';
  const cur = S.pages[S.page]?.chapterIndex ?? 0;
  S.toc.forEach((t, i) => {
    const d = document.createElement('div');
    d.className = 'toc-item' + (t.chapterIndex === cur ? ' active' : '');
    d.innerHTML = `<span class="idx">${t.chapterIndex + 1}</span><span class="txt"></span>`;
    d.querySelector('.txt').textContent = t.title || '(无标题)';
    d.onclick = () => {
      goToCharAtPageStart(t.charStart);
      els.toc.classList.remove('show');
    };
    els.tocList.appendChild(d);
  });
  els.toc.classList.add('show');
}

/* ------------------------------------------------------------------ *
 *  输入事件
 * ------------------------------------------------------------------ */

/* ---- 滚轮 ---- */
let wheelAcc = 0;
let wheelLock = 0;

els.stage.addEventListener('wheel', (e) => {
  if (els.jump.classList.contains('show') || els.toc.classList.contains('show')) return;
  e.preventDefault();

  if (!S.book) return;

  if (S.singleLine) {
    // 单行模式：一格滚轮 = 前进/后退一行
    const now = Date.now();
    if (now < wheelLock) return;
    const dir = e.deltaY > 0 ? 1 : -1;
    wheelLock = now + 70;
    singleLineStep(dir);
    return;
  }

  // 普通模式：阈值累积，防止触控板过灵敏
  wheelAcc += e.deltaY;
  const now = Date.now();
  if (now < wheelLock) return;
  const TH = 30;
  if (Math.abs(wheelAcc) >= TH) {
    const dir = wheelAcc > 0 ? 1 : -1;
    wheelAcc = 0;
    wheelLock = now + 110;
    go(dir);
  }
}, { passive: false });

/* ---- 键盘 ---- */
document.addEventListener('keydown', (e) => {
  // 输入框里不拦截
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') {
    if (e.key === 'Enter' && e.target === els.jumpInput) {
      closeJump();
      doJump(els.jumpInput.value);
    }
    if (e.key === 'Escape') {
      closeJump();
      els.toc.classList.remove('show');
    }
    return;
  }

  const ctrl = e.ctrlKey || e.metaKey;

  if (ctrl && e.key === 'o') { e.preventDefault(); api.importBook(); return; }
  if (ctrl && e.key === 'g') { e.preventDefault(); openJump(); return; }
  if (ctrl && e.key === 't') { e.preventDefault(); openToc(); return; }
  if (ctrl && e.key === 'l') { e.preventDefault(); toggleSingleLine(); return; }
  if (ctrl && e.key === 'q') { e.preventDefault(); api.quit(); return; }
  if (ctrl && (e.key === '=' || e.key === '+')) {
    e.preventDefault();
    if (S.singleLine) lineFontStep(1); else fontStep(1);
    return;
  }
  if (ctrl && e.key === '-') {
    e.preventDefault();
    if (S.singleLine) lineFontStep(-1); else fontStep(-1);
    return;
  }
  if (ctrl && e.key === 'ArrowRight') { e.preventDefault(); nextChapter(); return; }
  if (ctrl && e.key === 'ArrowLeft') { e.preventDefault(); prevChapter(); return; }

  // 右键菜单键 / Shift+F10
  if (e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10')) {
    e.preventDefault();
    showMenu();
    return;
  }

  if (e.key === 'Escape') {
    els.toc.classList.remove('show');
    closeJump();
    if (S.singleLine) toggleSingleLine();
    return;
  }

  if (S.singleLine) {
    if (e.key === 'ArrowDown' || e.key === 'ArrowRight' || e.key === 'PageDown' || e.key === ' ') {
      e.preventDefault();
      singleLineStep(1);
    } else if (e.key === 'ArrowUp' || e.key === 'ArrowLeft' || e.key === 'PageUp') {
      e.preventDefault();
      singleLineStep(-1);
    }
    return;
  }

  switch (e.key) {
    case 'ArrowRight':
    case 'PageDown':
    case ' ':
      e.preventDefault();
      go(1);
      break;
    case 'ArrowLeft':
    case 'PageUp':
      e.preventDefault();
      go(-1);
      break;
    case 'ArrowDown':
      e.preventDefault();
      go(1);
      break;
    case 'ArrowUp':
      e.preventDefault();
      go(-1);
      break;
    case 'Home':
      e.preventDefault();
      goToPage(0);
      break;
    case 'End':
      e.preventDefault();
      goToPage(countAllPages() - 1);
      break;
  }
});

/* ---- 右键 ---- */
document.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  showMenu();
});

/* ---- 双击最大化 / 双击空白处 ---- */
els.stage.addEventListener('dblclick', async () => {
  const b = await api.win.getBounds();
  if (b && b.height > 400) {
    S._restore = b;
    api.win.setBounds({ height: 240 });
  } else if (S._restore) {
    api.win.setBounds(S._restore);
  }
});

/* ---- 边缘热区 ---- */
document.querySelectorAll('.edge').forEach((el) => {
  el.addEventListener('click', (e) => {
    e.stopPropagation();
    go(el.dataset.nav === 'next' ? 1 : -1);
  });
});

/* ---- 拖动窗口：空白处按住可拖 ---- */
let dragging = false;
els.stage.addEventListener('mousedown', (e) => {
  if (e.button !== 0) return;
  // 有选中文字时不拖
  if (String(window.getSelection() || '').trim()) return;
  if (e.detail === 2) return; // 双击交给最大化
  dragging = true;
  const start = { x: e.screenX, y: e.screenY, bounds: null };
  api.win.getBounds().then((b) => { start.bounds = b; });

  const onMove = async (ev) => {
    if (!dragging || !start.bounds) return;
    const dx = ev.screenX - start.x;
    const dy = ev.screenY - start.y;
    api.win.setBounds({
      x: start.bounds.x + dx,
      y: start.bounds.y + dy,
      width: start.bounds.width,
      height: start.bounds.height,
    });
  };
  const onUp = () => {
    dragging = false;
    window.removeEventListener('mousemove', onMove);
    window.removeEventListener('mouseup', onUp);
  };
  window.addEventListener('mousemove', onMove);
  window.addEventListener('mouseup', onUp);
});

/* ------------------------------------------------------------------ *
 *  模态交互
 * ------------------------------------------------------------------ */

$('jumpCancel').onclick = closeJump;
$('jumpOk').onclick = () => {
  closeJump();
  doJump(els.jumpInput.value);
};
$('tocClose').onclick = () => els.toc.classList.remove('show');

els.jump.addEventListener('mousedown', (e) => {
  if (e.target === els.jump) closeJump();
});
els.toc.addEventListener('mousedown', (e) => {
  if (e.target === els.toc) els.toc.classList.remove('show');
});

/* ------------------------------------------------------------------ *
 *  主进程指令
 * ------------------------------------------------------------------ */

function fontStep(d) {
  S.fontSize = Math.max(9, Math.min(60, S.fontSize + d));
  applyTheme();
  reflow(S.pageCharStart);
  toast(`字号 ${S.fontSize}`);
}

function lineFontStep(d) {
  S.lineFontSize = Math.max(10, Math.min(40, S.lineFontSize + d));
  S.fontSize = S.lineFontSize;
  applyTheme();
  reflow(S.pageCharStart);
  toast(`单行字号 ${S.lineFontSize}`);
}

function nextChapter() {
  if (!S.book) return;
  const cur = S.pages[S.page]?.chapterIndex ?? 0;
  gotoChapter(cur + 1);
}

function prevChapter() {
  if (!S.book) return;
  const cur = S.pages[S.page]?.chapterIndex ?? 0;
  gotoChapter(cur - 1);
}

function toggleSingleLine(force) {
  if (!S.book) {
    toast('先导入一本书');
    return;
  }
  const next = typeof force === 'boolean' ? force : !S.singleLine;
  if (next) {
    // 进入单行模式（记住正常模式的字号，退出时还原，避免来回切换把字号带跑）
    S._fontBeforeSingle = S.fontSize;
    S.singleLine = true;
    S.fontSize = S.lineFontSize;
    document.body.classList.add('single');
    applyTheme();
    api.setSingleLine({ on: true, lineHeight: singleLineBoxPx() });
    setTimeout(() => {
      rebuildSinglePages();
      renderPage();
    }, 60);
    toast('单行阅读：滚轮逐行翻动，Esc 退出');
  } else {
    S.singleLine = false;
    document.body.classList.remove('single');
    api.setSingleLine({ on: false });
    setTimeout(() => {
      S.fontSize = S._fontBeforeSingle || S.fontSize;
      applyTheme();
      paginate(null);
      goToChar(S.pageCharStart);
    }, 60);
    toast('已退出单行阅读');
  }
}

function registerCommands() {
  const map = {
    import: () => api.importBook(),
    openFolder: () => {
      if (S.book?.filePath) {
        api.clipboard.write(S.book.filePath);
        toast('文件路径已复制到剪贴板');
      }
    },
    toc: openToc,
    tocGoto: (i) => {
      const t = S.toc[i];
      if (t) {
        goToCharAtPageStart(t.charStart);
        toast(t.title || `第 ${t.chapterIndex + 1} 章`);
      }
    },
    jump: () => openJump(),
    jumpTo: (t) => doJump(t),
    chapterPrev: prevChapter,
    chapterNext: nextChapter,
    pagePrev: () => go(-1),
    pageNext: () => go(1),

    bg: (v) => {
      S.bg = v;
      S.fgIsAuto = false;
      const notes = [];
      // 当前底色是全透明的：选了实色却看不见，容易以为功能坏了 —— 顺手提亮
      if (S.bgAlpha === 0) {
        S.bgAlpha = 1;
        notes.push('不透明度 100%');
      }
      if (ensureReadable()) notes.push('文字已配成对比色');
      applyTheme();
      toast('底色已更换' + (notes.length ? ' · ' + notes.join(' · ') : ''));
    },
    bgPick: async () => {
      const r = await api.pickColor({ hex: S.bg, alpha: S.bgAlpha });
      if (r && r.ok && r.color) {
        S.bg = r.color;
        if (typeof r.alpha === 'number') S.bgAlpha = r.alpha;
        const flipped = ensureReadable();
        applyTheme();
        toast(
          `底色 ${r.color} · 不透明度 ${Math.round(S.bgAlpha * 100)}%` +
            (flipped ? ' · 文字已配成对比色' : '')
        );
      } else {
        toast('取色已取消');
      }
    },
    bgAlpha: (v) => {
      S.bgAlpha = v;
      const flipped = ensureReadable();
      applyTheme();
      toast(
        (v === 0 ? '底色已完全透明' : `底色不透明度 ${Math.round(v * 100)}%`) +
          (flipped ? ' · 文字已配成对比色' : '')
      );
    },
    textColor: (v) => {
      if (v === 'auto') {
        autoTextColor();
        toast('文字颜色已按底色自动反转');
      } else {
        S.fg = v;
      }
      applyTheme();
    },
    toggleShadow: () => {
      S.shadow = !S.shadow;
      applyTheme();
      toast(S.shadow ? '已开启文字投影' : '已关闭文字投影');
    },

    fontStep,
    lineHeight: (v) => {
      S.lineHeight = v;
      applyTheme();
      reflow(S.pageCharStart);
    },
    fontFamily: (v) => {
      S.fontFamily = v;
      applyTheme();
      reflow(S.pageCharStart);
    },
    toggleBold: () => {
      S.bold = !S.bold;
      applyTheme();
      reflow(S.pageCharStart);
    },

    singleLineToggle: () => toggleSingleLine(),
    lineFontStep,

    toggleFrame: () => {
      S.frameOn = !S.frameOn;
      applyTheme();
    },
    copySelection: () => {
      const t = String(window.getSelection() || '').trim();
      if (t) {
        api.clipboard.write(t);
        toast('已复制选中文字');
      }
    },
  };

  Object.keys(map).forEach((name) => {
    api.onCmd(name, (payload) => map[name](payload));
  });

  // 窗口尺寸预设
  window.addEventListener('message', () => {});

  api.onThemeApply((cfg) => {
    if (!cfg) return;
    if (cfg.bg) S.bg = cfg.bg;
    if (typeof cfg.bgAlpha === 'number') S.bgAlpha = cfg.bgAlpha;
    applyTheme();
  });

  api.onFontApply((cfg) => {
    if (!cfg) return;
    Object.assign(S, cfg);
    applyTheme();
    reflow(S.pageCharStart);
  });

  api.onModeChanged((m) => {
    if (m.singleLine && !S.singleLine) {
      S.singleLine = true;
      document.body.classList.add('single');
      applyTheme();
      setTimeout(() => { rebuildSinglePages(); renderPage(); }, 60);
    }
  });

  api.onBookLoaded((book) => {
    book._t0 = Date.now();
    loadBook(book);
  });
}

// 主进程的「窗口尺寸预设」走 setBounds，渲染层不需要额外处理
window.addEventListener('DOMContentLoaded', () => {
  registerCommands();
});

/* ---- 窗口尺寸变化：重排 ---- */
let resizeTimer = null;
window.addEventListener('resize', () => {
  document.body.classList.toggle('tiny', window.innerWidth < 300 || window.innerHeight < 160);
  if (!S.book) return;
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    if (S.singleLine) {
      const box = singleLineBoxPx();
      document.documentElement.style.setProperty('--line-box', box + 'px');
      // 注意：这里不上报 lineHeight ——「一行的高度」只由字号决定，
      // 用户手动拖高单行条子时不该被主进程拽回去
      api.setSingleLine({ on: true });
      singleLineReset();     // 宽度变了，行表重建
      const at = S.pageCharStart;
      S.pageCharStart = at;
      rebuildSinglePages();
      renderPage();
    } else {
      const at = S.pageCharStart;
      paginate(null);
      goToChar(at);
    }
  }, 160);
});

/* ---- 初始化 ---- */
(function init() {
  applyTheme();
  document.body.classList.toggle('tiny', window.innerWidth < 300 || window.innerHeight < 160);
  showMenu0();
  function showMenu0() {
    // 首次进入给个轻提示
    setTimeout(() => toast('在此处右键 →「导入书籍…」开始阅读'), 600);
  }
})();
