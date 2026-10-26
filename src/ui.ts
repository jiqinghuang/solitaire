/* 纸牌接龙 · 界面（源码 src/ui.ts → 编译产物 dist/ui.js）
   浏览器由 index.html 依次加载 dist/engine.js（挂载全局 Solitaire）与本文件；
   uitest.ts 用最小 DOM stub 真正执行同一份 dist/ui.js 做接线测试。

   交互模型：
   - 指针按下在可拖牌上 → 进入「待定」；移动超过阈值才真正开始拖动（避免点按误拖）
   - 拖动中实时高亮合法落点；松手落在合法目标即执行移动
   - 没有拖动时是点按：点牌选中、点目标放下；双击顶牌送收牌区；点牌库翻牌
   - 触屏走同一套 pointer 事件（pointerdown/move/up） */

/* ---- 运行时入口（dist/engine.js 挂载的全局） ---- */
const ENGINE = Solitaire.Solitaire;
const SUITS = Solitaire.SUITS;
const isRed = Solitaire.isRed;
const rankLabel = Solitaire.rankLabel;
const suitLabel = Solitaire.suitLabel;
const sameLocation = Solitaire.sameLocation;

type Source = { loc: PileRef; count: number };

const $ = (s: string): any => document.querySelector(s);
const $$ = (s: string, root?: any): any[] => (root ?? document).querySelectorAll(s);

/* ---- 花色符号（纯文本字符，避免引入字体/图片） ---- */
const SUIT_CHAR: Record<Suit, string> = { S: '♠', H: '♥', D: '♦', C: '♣' };
const FOUND_HINT: Record<Suit, string> = { S: '♠', H: '♥', D: '♦', C: '♣' };

/* ---- 七段 LED（与扫雷同款；显示步数与用时） ---- */
const SEG_ON = '#f00', SEG_OFF = '#3d0000';
const SEG_POS: Record<string, string> = {
  a: 'left:23.0769%;top:0;width:53.8462%;height:8.6957%',   d: 'left:23.0769%;top:91.3043%;width:53.8462%;height:8.6957%',
  g: 'left:23.0769%;top:45.6522%;width:53.8462%;height:8.6957%',
  f: 'left:0;top:8.6957%;width:15.3846%;height:36.9565%',   b: 'left:84.6154%;top:8.6957%;width:15.3846%;height:36.9565%',
  e: 'left:0;top:54.3478%;width:15.3846%;height:36.9565%',  c: 'left:84.6154%;top:54.3478%;width:15.3846%;height:36.9565%',
};
const SEG_MAP: Record<string, string> = {
  '0': 'abcdef', '1': 'bc', '2': 'abged', '3': 'abgcd', '4': 'fgbc', '5': 'afgcd',
  '6': 'afgedc', '7': 'abc', '8': 'abcdefg', '9': 'abfgcd', '-': 'g', ' ': '',
};

interface Led { el: any; segs: any[][]; set(v: number): void }

function makeLed(el: any): Led {
  const digits: any[] = [], segs: any[][] = [];
  for (let d = 0; d < 3; d++) {
    const dig = document.createElement('div');
    dig.className = 'led-digit';
    const row: any[] = [];
    for (const s of 'abcdefg') {
      const seg = document.createElement('div');
      seg.className = 'seg';
      seg.style.cssText = SEG_POS[s];
      dig.appendChild(seg);
      row.push(seg);
    }
    el.appendChild(dig);
    digits.push(dig);
    segs.push(row);
  }
  const set = (v: number): void => {
    const clean = Math.max(-99, Math.min(999, Math.floor(Number(v) || 0)));
    const neg = clean < 0;
    const text = (neg ? '-' : '') + String(Math.abs(clean)).padStart(neg ? 2 : 3, '0');
    const shown = text.slice(-3);
    for (let d = 0; d < 3; d++) {
      const ch = shown[d] ?? ' ';
      const on = SEG_MAP[ch] ?? '';
      const row = segs[d];
      for (let i = 0; i < row.length; i++) row[i].style.background = on.includes('abcdefg'[i]) ? SEG_ON : SEG_OFF;
    }
  };
  return { el, segs, set };
}

/* ---- 牌元素 ---- */

/** 中央花色的排布（百分比坐标；y 为 0–100 的相对位置，flip=倒置） */
const PIP_LAYOUT: Record<number, Array<[number, number]>> = {
  2: [[50, 22], [50, 78]],
  3: [[50, 20], [50, 50], [50, 80]],
  4: [[30, 22], [70, 22], [30, 78], [70, 78]],
  5: [[30, 22], [70, 22], [50, 50], [30, 78], [70, 78]],
  6: [[30, 20], [70, 20], [30, 50], [70, 50], [30, 80], [70, 80]],
  7: [[30, 20], [70, 20], [50, 35], [30, 50], [70, 50], [30, 80], [70, 80]],
  8: [[30, 20], [70, 20], [50, 35], [30, 50], [70, 50], [50, 65], [30, 80], [70, 80]],
  9: [[30, 18], [70, 18], [30, 36], [70, 36], [50, 50], [30, 64], [70, 64], [30, 82], [70, 82]],
  10: [[30, 16], [70, 16], [50, 28], [30, 40], [70, 40], [30, 60], [70, 60], [50, 72], [30, 84], [70, 84]],
};

function cardInner(card: Card): string {
  const r = rankLabel(card.rank);
  const sym = SUIT_CHAR[card.suit];
  const corners = '<div class="corner tl"><span class="r">' + r + '</span><span class="s">' + sym + '</span></div>'
    + '<div class="corner br"><span class="r">' + r + '</span><span class="s">' + sym + '</span></div>';
  if (card.rank >= 11) {
    // J / Q / K：中央画框 + 字母 + 花色（无人物图，保持零资源）
    return corners + '<div class="court"><span class="letter">' + r + '</span><span class="suit">' + sym + '</span></div>';
  }
  if (card.rank === 1) return corners + '<div class="pip ace" style="left:50%;top:52%">' + sym + '</div>';
  const layout = PIP_LAYOUT[card.rank];
  if (!layout) return corners + '<div class="pip big" style="left:50%;top:52%">' + sym + '</div>';
  let pips = '';
  for (const [x, y] of layout) {
    pips += '<div class="pip' + (y > 50 ? ' flip' : '') + '" style="left:' + x + '%;top:' + y + '%">' + sym + '</div>';
  }
  return corners + pips;
}

function cardEl(card: Card, extraClass = ''): any {
  const el = document.createElement('div');
  el.className = 'card ' + (card.faceUp ? 'face-up ' + (isRed(card) ? 'red' : 'black') : 'back') + (extraClass ? ' ' + extraClass : '');
  el.innerHTML = card.faceUp ? cardInner(card) : '<div class="back-inner"></div>';
  return el;
}

/* ---- 应用状态 ---- */
let engine: SolitaireInstance;
let ledScore: Led, ledTime: Led;
let selected: Source | null = null;
let drag: {
  source: Source;
  el: any;
  startX: number; startY: number;
  offsetX: number; offsetY: number;
  moved: boolean;
  cardW: number; cardH: number;
} | null = null;
let pendingClick: { source: Source; x: number; y: number } | null = null;
let lastClick: { loc: PileRef; at: number } | null = null;
let hintTimer: any = null;
let winTimer: any = null;
let clockTimer: any = null;
let toastTimer: any = null;
let passCount: PassCount = 1;
let menuOpen: any = null;

const tableEl = (): any => $('#table');
const dragLayer = (): any => $('#dragLayer');
const tableauEl = (): any => $('#tableau');

/* ---- 尺寸：牌宽来自 --card-w，可叠区高度来自 --fan-ratio * 牌高 ---- */
function metrics(): { w: number; h: number; fan: number; gap: number } {
  const cs = typeof getComputedStyle === 'function' ? getComputedStyle(document.documentElement) : null;
  const read = (name: string, fallback: number): number => {
    const v = parseFloat(String(cs?.getPropertyValue?.(name) ?? ''));
    return Number.isFinite(v) ? v : fallback;
  };
  const w = read('--card-w', 79);
  const h = read('--card-h', Math.round(w * 1.4));
  const ratio = read('--fan-ratio', 0.22);
  const fan = Math.round(h * ratio);
  const gap = read('--gap', 8);
  return { w, h, fan, gap };
}

/* ---- 渲染 ---- */

function render(): void {
  renderStock();
  renderWaste();
  renderFoundations();
  renderTableau();
  renderStatus();
  syncMenuChecks();
  syncButtons();
  if (selected) markSelected();
}

function renderStock(): void {
  const el = $('#stock');
  el.innerHTML = '';
  const empty = engine.stockCount === 0;
  el.classList.toggle('empty', empty);
  el.classList.toggle('recycle', empty && engine.wasteCount > 0);
  el.title = empty ? (engine.wasteCount ? '回收废牌堆（点击重翻）' : '牌库已空') : '牌库（点击翻牌）';
  if (engine.stockCount) {
    const back = document.createElement('div');
    back.className = 'stock-back';
    el.appendChild(back);
    const n = document.createElement('span');
    n.className = 'stock-count';
    n.textContent = String(engine.stockCount);
    el.appendChild(n);
  } else if (engine.wasteCount) {
    const n = document.createElement('span');
    n.className = 'stock-count';
    n.textContent = String(engine.wasteCount);
    el.appendChild(n);
  }
}

function renderWaste(): void {
  const el = $('#waste');
  el.innerHTML = '';
  const cards = engine.cardsAt({ kind: 'waste' });
  const start = Math.max(0, cards.length - 3);
  for (let i = start; i < cards.length; i++) {
    const c = cards[i];
    const offset = cards.length - 1 - i;            // 0 = 最上面
    const cls = engine.passCount === 3 && offset > 0 ? 'w' + (offset + 1) : '';
    const ce = cardEl(c, cls);
    ce.dataset.pile = 'waste';
    ce.dataset.index = String(i);
    ce.style.zIndex = String(i - start + 1);
    if (i === cards.length - 1) ce.dataset.top = '1';
    el.appendChild(ce);
  }
}

function renderFoundations(): void {
  for (const s of SUITS) {
    const el = $('#found' + s);
    el.innerHTML = '';
    el.dataset.hint = FOUND_HINT[s];
    const cards = engine.cardsAt({ kind: 'foundation', suit: s });
    if (cards.length) {
      const ce = cardEl(cards[cards.length - 1]);
      ce.dataset.pile = 'foundation';
      ce.dataset.suit = s;
      ce.dataset.top = '1';
      el.appendChild(ce);
    }
  }
}

function renderTableau(): void {
  const root = tableauEl();
  root.innerHTML = '';
  const { w, h, fan } = metrics();
  for (let i = 0; i < 7; i++) {
    const col = document.createElement('div');
    col.className = 'col';
    col.dataset.col = String(i);
    const slot = document.createElement('div');
    slot.className = 'col-slot';
    col.appendChild(slot);
    const cards = engine.cardsAt({ kind: 'tableau', index: i });
    let y = 0;
    for (let k = 0; k < cards.length; k++) {
      const c = cards[k];
      const ce = cardEl(c);
      ce.style.top = y + 'px';
      ce.dataset.pile = 'tableau';
      ce.dataset.col = String(i);
      ce.dataset.index = String(k);
      if (k === cards.length - 1) ce.dataset.top = '1';
      col.appendChild(ce);
      y += c.faceUp ? fan : Math.round(fan * 0.55);
    }
    // 列高随牌数增长：给父容器撑开滚动/布局高度
    const last = cards.length ? y : 0;
    col.style.height = Math.max(h, last + h) + 'px';
    col.style.minHeight = Math.max(h, last + h) + 'px';
    root.appendChild(col);
  }
}

function renderStatus(): void {
  ledScore.set(engine.moves);
  ledTime.set(engine.elapsed());
}

function syncButtons(): void {
  const undoBtn = $('#btnUndo');
  const hintBtn = $('#btnHint');
  const autoBtn = $('#btnAuto');
  if (undoBtn) undoBtn.disabled = engine.phase === 'won';
  if (hintBtn) hintBtn.disabled = engine.phase === 'won';
  if (autoBtn) autoBtn.disabled = !engine.canAutoFinish();
}

function syncMenuChecks(): void {
  const d1 = $('[data-act="draw1"]');
  const d3 = $('[data-act="draw3"]');
  const setChk = (el: any, on: boolean): void => {
    const chk = el?.querySelector?.('.chk');
    if (chk) chk.textContent = on ? '●' : ' ';
  };
  setChk(d1, engine.passCount === 1);
  setChk(d3, engine.passCount === 3);
}

function markSelected(): void {
  clearSelectionMarks();
  if (!selected) return;
  const { loc, count } = selected;
  const cards = topCardsOf(loc, count);
  for (const ce of cards) ce.classList.add('selected');
}

function clearSelectionMarks(): void {
  for (const ce of $$('.card.selected')) ce.classList.remove('selected');
}

function topCardsOf(loc: PileRef, count: number): any[] {
  if (loc.kind === 'tableau') {
    const col = tableauEl().children[loc.index];
    if (!col) return [];
    const cards = Array.from(col.querySelectorAll('.card')) as any[];
    return cards.slice(Math.max(0, cards.length - count));
  }
  if (loc.kind === 'waste') {
    const cards = Array.from($('#waste').querySelectorAll('.card')) as any[];
    return cards.slice(Math.max(0, cards.length - count));
  }
  if (loc.kind === 'foundation') {
    const el = $('#found' + loc.suit);
    const card = el?.querySelector('.card');
    return card ? [card] : [];
  }
  return [];
}

/* ---- 选中与移动 ---- */

function selectSource(src: Source | null): void {
  selected = src;
  markSelected();
}

function clearTransient(): void {
  clearHint();
  hideToast();
  clearSelectionMarks();
  selected = null;
  $$('.drop-ok').forEach((n: any) => n.classList.remove('drop-ok'));
}

function tryMove(src: Source, dst: PileRef): boolean {
  const res = engine.move(src.loc, src.count, dst);
  if (!res.ok) { toast(res.reason, 1400); return false; }
  clearTransient();
  render();
  checkAutoFinishPrompt();
  if (engine.phase === 'won') winSequence();
  return true;
}

/** 元素 → 所属牌堆。
    牌元素自身带 data-pile；空槽/整列元素靠 class 与 data-suit / data-col 识别。
    两者都要支持：点空白列、点收牌区空位都是常见操作。 */
function pileFromElement(el: any): PileRef | null {
  if (!el) return null;
  // 从最近的「牌」或「槽/列」节点取语义
  const host: any = el.closest?.('.card, .slot, .col') ?? el;
  const kind = host.dataset?.pile;
  if (kind === 'stock' || host.classList?.contains('stock')) return { kind: 'stock' };
  if (kind === 'waste' || host.classList?.contains('waste')) return { kind: 'waste' };
  if (kind === 'foundation' || host.classList?.contains('foundation')) {
    const suit = host.dataset?.suit;
    return suit ? { kind: 'foundation', suit: suit as Suit } : null;
  }
  if (kind === 'tableau' || host.classList?.contains('card') || host.classList?.contains('col')) {
    // 牌元素本身带 data-col；空槽/整列靠祖先 .col 的 data-col
    const colEl: any = host.dataset?.col !== undefined ? host : host.closest?.('.col');
    const idx = colEl?.dataset?.col;
    return idx === undefined ? null : { kind: 'tableau', index: Number(idx) };
  }
  return null;
}

/** 从事件目标回溯出「被按住的那张牌」以及可移动的牌组 */
function sourceAt(target: any, clientX: number, clientY: number): Source | null {
  const card = target?.closest?.('.card');
  if (card) {
    const pile = card.dataset.pile;
    if (pile === 'stock') return null;
    if (pile === 'waste') {
      if (card.dataset.top !== '1') return null;
      return { loc: { kind: 'waste' }, count: 1 };
    }
    if (pile === 'foundation') {
      return { loc: { kind: 'foundation', suit: card.dataset.suit as Suit }, count: 1 };
    }
    if (pile === 'tableau') {
      const col = Number(card.dataset.col);
      const idx = Number(card.dataset.index);
      const cards = engine.cardsAt({ kind: 'tableau', index: col });
      if (!cards[idx]?.faceUp) return null;
      const count = cards.length - idx;
      if (!engine.canMove({ kind: 'tableau', index: col }, count, { kind: 'tableau', index: col })) {
        // canMove 对同一位置恒为 false，只能检查明牌段
      }
      for (let k = idx; k < cards.length; k++) if (!cards[k].faceUp) return null;
      return { loc: { kind: 'tableau', index: col }, count };
    }
  }
  // 点空白列：只有空列能作为「无牌可拖」的目标（由调用方处理）
  const col = target?.closest?.('.col');
  if (col) return null;
  return null;
}

/** 指针位置 → 目标牌堆（以元素命中为准，触摸也一样） */
function dropTargetAt(x: number, y: number, src: Source): PileRef | null {
  const el = (document as any).elementFromPoint ? (document as any).elementFromPoint(x, y) : null;
  if (!el) return null;
  const pile = pileFromElement(el);
  if (!pile || pile.kind === 'stock') return null;
  if (pile.kind === 'waste' && src.loc.kind === 'waste') return null;
  return pile;
}

/* ---- 指针事件 ---- */

function onPointerDown(e: any): void {
  if (e.button !== undefined && e.button !== 0) return;
  closeMenu();
  const target = e.target;
  const src = sourceAt(target, e.clientX, e.clientY);
  if (!src) {
    // 点牌库 → 翻牌
    const stock = target?.closest?.('.slot.stock');
    if (stock) { doDraw(); return; }
    // 点空白列：若已有选中牌，尝试放下
    if (selected) {
      const pile = pileFromElement(target?.closest?.('.slot, .col'));
      if (pile) tryMove(selected, pile);
      else clearTransient();
      return;
    }
    clearTransient();
    return;
  }
  if (engine.phase === 'won') return;

  const { w, h, fan } = metrics();
  const rect = target.getBoundingClientRect?.() ?? { left: 0, top: 0 };
  pendingClick = { source: src, x: e.clientX ?? 0, y: e.clientY ?? 0 };
  drag = {
    source: src,
    el: null,
    startX: e.clientX ?? 0, startY: e.clientY ?? 0,
    offsetX: (e.clientX ?? 0) - rect.left,
    offsetY: (e.clientY ?? 0) - rect.top,
    moved: false,
    cardW: w, cardH: h,
  };
  // 拖拽期间持续收到指针事件（鼠标移出窗口也能正确收尾）
  try { (e.target as any)?.setPointerCapture?.(e.pointerId); } catch { /* 忽略不支持的环境 */ }
  // 阻止触屏滚动与文本选择
  if (e.cancelable) e.preventDefault?.();
}

function onPointerMove(e: any): void {
  if (!drag) return;
  const x = e.clientX ?? 0, y = e.clientY ?? 0;
  const dx = x - drag.startX, dy = y - drag.startY;
  if (!drag.moved) {
    if (Math.abs(dx) < 6 && Math.abs(dy) < 6) return;
    drag.moved = true;
    beginDragVisual();
  }
  moveDragVisual(x, y);
  highlightDrop(dropTargetAt(x, y, drag.source));
}

function onPointerUp(e: any): void {
  if (!drag) { pendingClick = null; return; }
  const d = drag;
  drag = null;
  const x = e.clientX ?? d.startX, y = e.clientY ?? d.startY;

  if (!d.moved) {
    // 双击判定必须放在「再点同一张取消选中」之前，
    // 否则第一次点击已经选中，第二次只会取消选中，双击永远收不了牌。
    const now = Date.now();
    const dblHit = lastClick !== null && now - lastClick.at < 400 && sameLocation(lastClick.loc, d.source.loc);
    lastClick = { loc: d.source.loc, at: now };
    if (dblHit && d.source.count === 1) {
      if (autoCollect(d.source.loc)) { pendingClick = null; return; }
    }

    const pile = pileFromElement(e.target);
    // 已有选中牌 → 点目标放下（点同一张则取消）
    if (selected && pile && !sameLocation(selected.loc, pile) && pile.kind !== 'stock') {
      tryMove(selected, pile);
      pendingClick = null;
      return;
    }
    if (selected && sameLocation(selected.loc, d.source.loc)) {
      selectSource(null);
      pendingClick = null;
      return;
    }
    if (!selected) selectSource(d.source);
    pendingClick = null;
    return;
  }

  // 拖动结束：落点合法就移动，否则回弹
  const dst = dropTargetAt(x, y, d.source);
  clearDragVisual();
  clearDropHighlights();
  pendingClick = null;
  if (dst) tryMove(d.source, dst);
  else render();
}

function onPointerCancel(): void {
  if (!drag) return;
  drag = null;
  clearDragVisual();
  clearDropHighlights();
  render();
}

function beginDragVisual(): void {
  if (!drag) return;
  const { loc, count } = drag.source;
  const els = topCardsOf(loc, count);
  const layer = dragLayer();
  layer.innerHTML = '';
  layer.hidden = false;
  const stack = document.createElement('div');
  stack.className = 'drag-stack';
  const { fan } = metrics();
  els.forEach((ce: any, i: number) => {
    const clone = ce.cloneNode ? ce.cloneNode(true) : ce;
    clone.classList?.remove?.('selected');
    clone.style.top = (i * fan) + 'px';
    clone.style.left = '0';
    clone.style.position = 'absolute';
    clone.style.visibility = 'visible';
    stack.appendChild(clone);
    ce.style.visibility = 'hidden';
  });
  layer.appendChild(stack);
  drag.el = stack;
}

function moveDragVisual(x: number, y: number): void {
  if (!drag?.el) return;
  const rect = tableEl().getBoundingClientRect?.() ?? { left: 0, top: 0 };
  drag.el.style.left = (x - rect.left - drag.offsetX) + 'px';
  drag.el.style.top = (y - rect.top - drag.offsetY) + 'px';
}

function clearDragVisual(): void {
  const layer = dragLayer();
  if (layer) { layer.innerHTML = ''; layer.hidden = true; }
  // 只把被临时隐藏的原牌恢复，不重建 DOM（避免拖动结束时闪一下）
  for (const n of $$('.card')) if (n.style.visibility === 'hidden') n.style.visibility = '';
}

function highlightDrop(dst: PileRef | null): void {
  clearDropHighlights();
  if (!dst) return;
  if (!engine.canMove(drag!.source.loc, drag!.source.count, dst)) return;
  const el = dst.kind === 'tableau' ? tableauEl().children[dst.index]
    : dst.kind === 'foundation' ? $('#found' + dst.suit)
      : dst.kind === 'waste' ? $('#waste') : null;
  if (el) el.classList.add('drop-ok');
  else if (dst.kind === 'tableau') tableauEl().children[dst.index]?.classList.add('drop-ok');
}

function clearDropHighlights(): void {
  for (const n of $$('.drop-ok')) n.classList.remove('drop-ok');
}

/* ---- 双击收牌 ---- */

function autoCollect(loc: PileRef): boolean {
  const suit = engine.autoMove(loc);
  if (!suit) return false;
  clearTransient();
  render();
  checkAutoFinishPrompt();
  if (engine.phase === 'won') winSequence();
  return true;
}

/* ---- 牌库 ---- */

function doDraw(): void {
  if (engine.phase === 'won') return;
  const r = engine.draw();
  clearTransient();
  render();
  if (r.recycled) toast('废牌堆已回收，重新翻牌', 1200);
  else if (engine.stockCount === 0 && engine.wasteCount > 0) toast('牌库已空，点击牌库可回收废牌堆', 1600);
}

/* ---- 提示 ---- */

function clearHint(): void {
  if (hintTimer) { clearTimeout(hintTimer); hintTimer = null; }
  for (const n of $$('.hint-src, .hint-dst')) n.classList.remove('hint-src', 'hint-dst');
}

function showHint(): void {
  if (engine.phase === 'won') return;
  clearHint();
  const h = engine.hint();
  if (!h) { toast('暂时没有可走的牌了，可以撤销或重新发牌', 1800); return; }
  if (h.from.kind === 'stock') { toast(h.text, 1600); return; }
  toast(h.text, 2200);
  const srcHost = h.from.kind === 'tableau' ? tableauEl().children[h.from.index]
    : h.from.kind === 'foundation' ? $('#found' + h.from.suit)
      : h.from.kind === 'waste' ? $('#waste') : null;
  if (srcHost) srcHost.classList.add('hint-src');
  const dstHost = h.to.kind === 'tableau' ? tableauEl().children[h.to.index]
    : h.to.kind === 'foundation' ? $('#found' + h.to.suit)
      : h.to.kind === 'waste' ? $('#waste') : null;
  if (dstHost) dstHost.classList.add('hint-dst');
  hintTimer = setTimeout(clearHint, 2400);
}

/* ---- 自动完成 ---- */

function checkAutoFinishPrompt(): void {
  if (engine.canAutoFinish() && engine.phase === 'playing') {
    toast('全部牌已翻开，可以点「自动完成」收尾', 2600);
  }
}

function autoFinish(): void {
  if (engine.phase === 'won') return;
  if (!engine.canAutoFinish()) { toast('牌库和废牌堆清空、所有牌翻开后才能自动完成', 2000); return; }
  clearTransient();
  let guard = 0;
  const step = (): void => {
    if (engine.phase === 'won' || guard++ > 200) { render(); if (engine.phase === 'won') winSequence(); return; }
    if (!engine.autoFinishStep()) { render(); return; }
    render();
    setTimeout(step, 90);
  };
  step();
}

/* ---- 新游戏 / 撤销 ---- */

function newGame(pass?: PassCount, rand?: () => number, clock?: () => number): void {
  if (pass !== undefined) passCount = pass;
  if (winTimer) { clearTimeout(winTimer); winTimer = null; }
  for (const n of $$('.win-banner, .bouncing')) n.remove?.();
  engine = new ENGINE(rand ?? Math.random, clock, passCount);
  clearTransient();
  render();
  startClock();
}

function restart(): void {
  if (winTimer) { clearTimeout(winTimer); winTimer = null; }
  for (const n of $$('.win-banner, .bouncing')) n.remove?.();
  engine.restart(passCount);
  clearTransient();
  render();
  startClock();
}

function undo(): void {
  if (!engine.undo()) { toast('没有可撤销的操作', 1200); return; }
  for (const n of $$('.win-banner, .bouncing')) n.remove?.();
  if (winTimer) { clearTimeout(winTimer); winTimer = null; }
  clearTransient();
  render();
}

/* ---- 计时刷新 ---- */

function startClock(): void {
  if (clockTimer) { clearInterval(clockTimer); clockTimer = null; }
  clockTimer = setInterval(() => {
    ledTime.set(engine.elapsed());
    if (engine.phase === 'won' && clockTimer) { clearInterval(clockTimer); clockTimer = null; }
  }, 500);
}

/* ---- 胜利动画：经典纸牌弹跳 ---- */

function winSequence(): void {
  if (winTimer || engine.phase !== 'won') return;
  const table = tableEl();
  const { w, h } = metrics();
  const layer = document.createElement('div');
  layer.className = 'bouncing';
  layer.style.inset = '0';
  layer.style.position = 'absolute';
  table.appendChild(layer);

  // 从收牌区顶端逐张弹出
  for (const s of SUITS) {
    const host = $('#found' + s);
    const card = host?.querySelector('.card');
    if (!card) continue;
    const rect = card.getBoundingClientRect?.() ?? { left: 0, top: 0, width: w, height: h };
    const tRect = table.getBoundingClientRect?.() ?? { left: 0, top: 0 };
    const x0 = rect.left - tRect.left, y0 = rect.top - tRect.top;
    // 克隆一份用于弹跳，避免动到真实牌
    const c = card.cloneNode ? card.cloneNode(true) : cardEl({ suit: s, rank: 13, faceUp: true });
    c.style.position = 'absolute';
    c.style.left = x0 + 'px';
    c.style.top = y0 + 'px';
    c.style.margin = '0';
    layer.appendChild(c);
    const dir = s === 'S' || s === 'H' ? -1 : 1;
    const vx = dir * (2.2 + Math.random() * 1.6);
    let vy = -(1.5 + Math.random() * 1.2);
    let x = x0, y = y0;
    let alive = true;
    const W = table.clientWidth || (w * 7 + 64), H = table.clientHeight || 440;
    const tick = (): void => {
      if (!alive) return;
      vy += 0.35;
      x += vx; y += vy;
      if (x < 0) { x = 0; }
      if (x + w > W) { x = W - w; }
      if (y + h > H) { y = H - h; vy = -Math.abs(vy) * 0.78; if (Math.abs(vy) < 1.2) alive = false; }
      c.style.transform = 'translate(' + Math.round(x - x0) + 'px,' + Math.round(y - y0) + 'px)';
      if (alive) requestAnimationFrame(tick);
      else c.remove?.();
    };
    setTimeout(() => { if (typeof requestAnimationFrame === 'function') requestAnimationFrame(tick); }, Math.random() * 400);
  }

  winTimer = setTimeout(() => {
    layer.remove?.();
    const banner = document.createElement('div');
    banner.className = 'win-banner';
    banner.innerHTML = '<h3>你赢了！</h3><p>用时 ' + engine.elapsed() + ' 秒 · ' + engine.moves + ' 步</p>';
    const btn = document.createElement('button');
    btn.className = 'btn';
    btn.textContent = '再来一局';
    btn.addEventListener('click', () => newGame());
    banner.appendChild(btn);
    table.appendChild(banner);
  }, 2600);
}

/* ---- Toast ---- */

function toast(text: string, ms = 1600): void {
  const el = $('#toast');
  if (!el) return;
  el.textContent = text;
  el.hidden = false;
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; toastTimer = null; }, ms);
}

function hideToast(): void {
  const el = $('#toast');
  if (el) el.hidden = true;
  if (toastTimer) { clearTimeout(toastTimer); toastTimer = null; }
}

/* ---- 菜单 ---- */

function closeMenu(): void {
  if (!menuOpen) return;
  menuOpen.drop.hidden = true;
  menuOpen.title.classList.remove('active');
  menuOpen = null;
}

function openMenuOf(menu: any): void {
  const drop = menu?.querySelector?.('.dropdown');
  const title = menu?.querySelector?.('.menutitle');
  if (!drop || !title) return;
  if (menuOpen && menuOpen.drop === drop) { closeMenu(); return; }
  closeMenu();
  drop.hidden = false;
  title.classList.add('active');
  menuOpen = { menu, drop, title };
}

function toggleMenuById(id: string): void {
  openMenuOf($('#' + id));
}

function onMenuItem(act: string): void {
  closeMenu();
  switch (act) {
    case 'new': newGame(); break;
    case 'restart': restart(); break;
    case 'draw1': newGame(1); break;
    case 'draw3': newGame(3); break;
    case 'undo': undo(); break;
    case 'hint': showHint(); break;
    case 'autofinish': autoFinish(); break;
    case 'rules': showRules(); break;
    case 'about': showAbout(); break;
  }
}

function showRules(): void {
  toast('目标：把四门花色从 A 到 K 收齐。牌阵红黑交替、点数递减；空列只能放 K。', 4200);
}

function showAbout(): void {
  toast('经典纸牌接龙 · TypeScript + 原生 DOM，零运行时依赖', 3600);
}

/* ---- 事件绑定 ---- */

function bindEvents(): void {
  const table = tableEl();
  table.addEventListener('pointerdown', onPointerDown);
  // 用 pointer capture 保证移出牌桌/窗口后仍能收到 move/up（触屏尤其重要）
  table.addEventListener('lostpointercapture', () => onPointerCancel());
  document.addEventListener('pointermove', onPointerMove);
  document.addEventListener('pointerup', onPointerUp);
  document.addEventListener('pointercancel', onPointerCancel);

  // 菜单标题
  for (const title of $$('.menutitle')) {
    title.addEventListener('mousedown', (e: any) => {
      e.preventDefault?.();
      e.stopPropagation?.();
      openMenuOf(title.closest('.menu'));
    });
  }
  // 菜单项
  document.addEventListener('mousedown', (e: any) => {
    const mi = e.target?.closest?.('.mi');
    if (mi) {
      e.preventDefault?.();
      const act = mi.dataset.act;
      if (act) onMenuItem(act);
      return;
    }
    if (!e.target?.closest?.('.menu')) closeMenu();
  });
  // 按钮
  $('#btnUndo')?.addEventListener('click', undo);
  $('#btnHint')?.addEventListener('click', showHint);
  $('#btnAuto')?.addEventListener('click', autoFinish);

  // 键盘
  document.addEventListener('keydown', (e: any) => {
    const k = (e.key ?? '').toLowerCase();
    if (e.key === 'F2') { e.preventDefault(); newGame(); return; }
    if ((e.ctrlKey || e.metaKey) && k === 'z') { e.preventDefault(); undo(); return; }
    if (e.altKey && k === 'g') { e.preventDefault(); toggleMenuById('menuGame'); return; }
    if (e.altKey && k === 'h') { e.preventDefault(); toggleMenuById('menuHelp'); return; }
    if (e.key === 'Escape') { clearTransient(); closeMenu(); return; }
    if (menuOpen) {
      // 菜单展开时：字母直接触发对应项；G/H 收起当前菜单（与原版一致）。
      // 「帮助」菜单里的 H 既是展开键又是「玩法说明」的助记键，这里以菜单项优先。
      const inHelp = menuOpen.menu === $('#menuHelp');
      const map: Record<string, string> = inHelp
        ? { r: 'rules', a: 'about', g: 'close', h: 'close' }
        : { n: 'new', r: 'restart', u: 'undo', f: 'autofinish', '1': 'draw1', '3': 'draw3', h: 'hint', g: 'close' };
      const act = map[k];
      if (act === 'close') { closeMenu(); return; }
      if (act) { e.preventDefault(); onMenuItem(act); return; }
      return;
    }
    if (k === 'h') { e.preventDefault(); showHint(); return; }
    if (k === 'f') { e.preventDefault(); autoFinish(); return; }
    if (k === 'u') { e.preventDefault(); undo(); return; }
    if (k === 'n') { e.preventDefault(); newGame(); return; }
  });

  window.addEventListener('blur', () => {
    if (drag) { drag = null; clearDragVisual(); clearDropHighlights(); }
    closeMenu();
  });
  window.addEventListener('resize', () => { render(); });
}

/* ---- 启动 ---- */

function init(): void {
  ledScore = makeLed($('#ledScore'));
  ledTime = makeLed($('#ledTime'));
  engine = new ENGINE(Math.random, undefined, 1);
  bindEvents();
  render();
  startClock();
}

init();

/* 测试钩子：uitest 以最小 DOM stub 执行本文件后，借它驱动流程（生产环境无害） */
(globalThis as any).__sui = {
  newGame, restart, undo, doDraw, showHint, autoFinish,
  setEngine(e: SolitaireInstance) { engine = e; render(); },
  engine: (): SolitaireInstance => engine,
  render,
  metrics,
  get selected(): Source | null { return selected; },
  selectSource,
  tryMove,
  onPointerDown, onPointerMove, onPointerUp, onPointerCancel,
  onMenuItem,
  closeMenu, openMenuOf, toggleMenuById,
  get passCount(): PassCount { return passCount; },
  set passCount(v: PassCount) { passCount = v; },
  ledScore: (): Led => ledScore,
  ledTime: (): Led => ledTime,
  toast,
};
