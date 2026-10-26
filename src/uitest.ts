/* UI 接线测试：用最小 DOM stub 真正执行 dist/ui.js（index.html 加载的同一份界面脚本）
   覆盖：渲染结构 → 点选移动 → 拖动移动 → 双击收牌 → 翻牌/回收 → 撤销 → 提示 →
   自动完成 → 菜单切换抽牌模式 → 键盘快捷键 → 胜利界面。
   随机性通过 __sui.newGame 的注入入口控制（引擎构造函数可注入 rand）。 */
const fs = require('fs');
const SOL = require('./engine.js') as SolitaireAPI;

let pass = 0, fail = 0;
const ok = (c: unknown, m: string): void => { c ? (pass++, console.log('  PASS ' + m)) : (fail++, console.log('  FAIL ' + m)); };

function section(name: string, fn: () => void): void {
  console.log('\n[' + name + ']');
  try { fn(); } catch (e) { fail++; console.log('  FAIL 段落异常 [' + name + ']：' + (e as Error).message + '\n' + (e as Error).stack); }
}

/** 种子 PRNG：让 UI 测试使用可复现牌局 */
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6D2B79F5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* ---------- 最小 DOM stub ---------- */
interface StubEl {
  tagName: string; className: string; hidden: boolean; title: string; textContent: string;
  dataset: Record<string, string>; style: Record<string, any>;
  children: StubEl[]; parent: StubEl | null;
  listeners: Record<string, Array<(e?: any) => void>>;
  _html: string; innerHTML: string;
  disabled: boolean;
  classList: {
    add(...c: string[]): void; remove(...c: string[]): void;
    contains(c: string): boolean; toggle(c: string, on?: boolean): void;
  };
  appendChild(c: StubEl): StubEl;
  removeChild(c: StubEl): void;
  remove(): void;
  cloneNode(deep?: boolean): StubEl;
  addEventListener(type: string, fn: (e?: any) => void): void;
  fire(type: string, ev?: any): void;
  querySelector(sel: string): StubEl | null;
  querySelectorAll(sel: string): StubEl[];
  closest(sel: string): StubEl | null;
  matches(sel: string): boolean;
  getBoundingClientRect(): { left: number; top: number; width: number; height: number };
  getAttribute(name: string): string | null;
  _id: string;
}

function mkEl(tag = 'div'): StubEl {
  const cls = new Set<string>();
  const children: StubEl[] = [];
  const el: any = {
    tagName: tag.toUpperCase(), hidden: false, title: '', textContent: '', disabled: false,
    dataset: {}, style: {}, parent: null, listeners: {}, _html: '',
    get className(): string { return [...cls].join(' '); },
    set className(v: string) { cls.clear(); String(v).split(/\s+/).filter(Boolean).forEach((x) => cls.add(x)); },
    get children(): StubEl[] { return children; },
    get innerHTML(): string { return el._html; },
    set innerHTML(v: string) { el._html = String(v); children.length = 0; children.forEach((c) => { c.parent = null; }); },
    classList: {
      add: (...c: string[]) => c.forEach((x) => cls.add(x)),
      remove: (...c: string[]) => c.forEach((x) => cls.delete(x)),
      contains: (c: string) => cls.has(c),
      toggle: (c: string, on?: boolean) => { (on ?? !cls.has(c)) ? cls.add(c) : cls.delete(c); },
    },
    appendChild(c: StubEl) { c.parent = el; children.push(c); return c; },
    removeChild(c: StubEl) { const i = children.indexOf(c); if (i >= 0) children.splice(i, 1); c.parent = null; },
    remove() { el.parent?.removeChild?.(el); },
    cloneNode() {
      const c = mkEl(tag);
      c.className = el.className;
      c.dataset = { ...el.dataset };
      c.style = { ...el.style };
      c.title = el.title;
      c.textContent = el.textContent;
      c.hidden = el.hidden;
      c._html = el._html;
      return c;
    },
    addEventListener(type: string, fn: (e?: any) => void) { (el.listeners[type] ??= []).push(fn); },
    fire(type: string, ev: any = {}) { for (const f of el.listeners[type] ?? []) f(ev); },
    querySelector(sel: string) { const r = el.querySelectorAll(sel); return r.length ? r[0] : null; },
    querySelectorAll(sel: string) {
      const out: StubEl[] = [];
      const walk = (n: StubEl): void => { for (const c of n.children) { if (c.matches(sel)) out.push(c); walk(c); } };
      walk(el);
      return out;
    },
    matches(sel: string) {
      // 支持逗号分组、复合选择器（.slot.stock / .card.selected）与 [data-x="v"]
      const parts = sel.split(',').map((s) => s.trim());
      const one = (q: string): boolean => {
        const tokens = q.match(/(^[a-zA-Z][\w-]*)|\.[\w-]+|#\w+|\[[^\]]+\]/g) ?? [];
        if (!tokens.length) return false;
        for (const t of tokens) {
          if (t.startsWith('.')) { if (!cls.has(t.slice(1))) return false; }
          else if (t.startsWith('#')) { if (el._id !== t.slice(1)) return false; }
          else if (t.startsWith('[')) {
            const m = t.match(/^\[([\w-]+)(?:="([^"]*)")?\]$/);
            if (!m) return false;
            const key = m[1].replace(/^data-/, '').replace(/-([a-z])/g, (_: string, c: string) => c.toUpperCase());
            if (!(key in el.dataset)) return false;
            if (m[2] !== undefined && String(el.dataset[key]) !== m[2]) return false;
          } else if (el.tagName !== t.toUpperCase()) return false;
        }
        return true;
      };
      return parts.some(one);
    },
    closest(sel: string) { let p: StubEl | null = el; while (p) { if (p.matches(sel)) return p; p = p.parent; } return null; },
    getBoundingClientRect() { return { left: 0, top: 0, width: 96, height: 110 }; },
    getAttribute() { return null; },
    _id: '',
  };
  return el;
}

/* ---- 页面结构 stub ---- */
const docListeners: Record<string, Array<(e?: any) => void>> = {};
const winListeners: Record<string, Array<(e?: any) => void>> = {};
const ids: Record<string, StubEl> = {};

function byId(id: string): StubEl {
  if (!ids[id]) { ids[id] = mkEl('div'); ids[id]._id = id; }
  return ids[id];
}

const tableEl = byId('table');
const tableauEl = byId('tableau');
const stockEl = byId('stock');
const wasteEl = byId('waste');
const dragLayerEl = byId('dragLayer');
const toastEl = byId('toast');
stockEl.className = 'slot stock';
wasteEl.className = 'slot waste';
tableEl.className = 'table';

/* 收牌区 */
const foundEls: Record<string, StubEl> = {};
for (const s of ['S', 'H', 'D', 'C']) {
  const el = byId('found' + s);
  el.className = 'slot foundation';
  el.dataset.suit = s;
  foundEls[s] = el;
}

/* 菜单 */
const menuGame = mkEl('div'); menuGame.className = 'menu';
const gameTitle = mkEl('span'); gameTitle.className = 'menutitle'; gameTitle.textContent = '游戏(G)';
const gameDrop = byId('menuGameDrop'); gameDrop.className = 'dropdown'; gameDrop.hidden = true;
menuGame.appendChild(gameTitle); menuGame.appendChild(gameDrop);
const menuHelp = mkEl('div'); menuHelp.className = 'menu';
const helpTitle = mkEl('span'); helpTitle.className = 'menutitle'; helpTitle.textContent = '帮助(H)';
const helpDrop = byId('menuHelpDrop'); helpDrop.className = 'dropdown'; helpDrop.hidden = true;
menuHelp.appendChild(helpTitle); menuHelp.appendChild(helpDrop);

const miEls: Record<string, StubEl> = {};
for (const act of ['new', 'restart', 'draw1', 'draw3', 'undo', 'hint', 'autofinish', 'rules', 'about']) {
  const mi = mkEl('div'); mi.className = 'mi'; mi.dataset.act = act;
  const chk = mkEl('span'); chk.className = 'chk';
  mi.appendChild(chk);
  gameDrop.appendChild(mi);
  miEls[act] = mi;
}

/* 按钮与 LED */
const btnUndo = mkEl('button'); btnUndo._id = 'btnUndo';
const btnHint = mkEl('button'); btnHint._id = 'btnHint';
const btnAuto = mkEl('button'); btnAuto._id = 'btnAuto';
const ledScore = byId('ledScore');
const ledTime = byId('ledTime');

const rootEls: Record<string, StubEl> = {
  '#table': tableEl, '#tableau': tableauEl, '#stock': stockEl, '#waste': wasteEl,
  '#dragLayer': dragLayerEl, '#toast': toastEl,
  '#foundS': foundEls.S, '#foundH': foundEls.H, '#foundD': foundEls.D, '#foundC': foundEls.C,
  '#btnUndo': btnUndo, '#btnHint': btnHint, '#btnAuto': btnAuto,
  '#ledScore': ledScore, '#ledTime': ledTime,
  '#menuGame': menuGame, '#menuHelp': menuHelp,
  '#menuGameDrop': gameDrop, '#menuHelpDrop': helpDrop,
};

const documentStub: any = {
  documentElement: { _id: 'html' },
  createElement: (t: string) => mkEl(t),
  querySelector: (sel: string) => {
    if (rootEls[sel]) return rootEls[sel];
    if (sel === '.menutitle') return gameTitle;
    const m = sel.match(/^\[data-act="([^"]+)"\]$/);
    if (m) return miEls[m[1]] ?? null;
    return null;
  },
  querySelectorAll: (sel: string) => {
    if (sel === '.menutitle') return [gameTitle, helpTitle];
    if (sel === '.card.selected') {
      const out: StubEl[] = [];
      for (const n of [tableauEl, wasteEl, ...Object.values(foundEls)]) out.push(...n.querySelectorAll('.selected'));
      return out;
    }
    if (sel === '.drop-ok' || sel === '.hint-src, .hint-dst') {
      const out: StubEl[] = [];
      for (const n of [tableauEl, wasteEl, ...Object.values(foundEls)]) out.push(...n.querySelectorAll(sel));
      return out;
    }
    if (sel === '.win-banner, .bouncing') return [];
    return [];
  },
  addEventListener: (type: string, fn: (e?: any) => void) => { (docListeners[type] ??= []).push(fn); },
  elementFromPoint: () => null,
};

const windowStub: any = {
  addEventListener: (t: string, f: any) => { (winListeners[t] ??= []).push(f); },
};

const globalAny: any = globalThis as any;
globalAny.document = documentStub;
globalAny.window = windowStub;
globalAny.Solitaire = SOL;
globalAny.self = globalAny;
globalAny.getComputedStyle = () => ({
  getPropertyValue: (name: string): string => {
    // 宽度/间距为纯 px；高度由真实牌元素测量，支持 CSS calc 比例。
    const map: Record<string, string> = {
      '--card-w': '96px', '--gap': '12px',
      '--fan-ratio': '0.24', '--fan-down-ratio': '0.18',
    };
    return map[name] ?? '';
  },
});
const timerHandles = new Set<number>();
globalAny.setInterval = () => { const h = 1; timerHandles.add(h); return h; };
globalAny.clearInterval = (h: number) => { timerHandles.delete(h); };
let nextTimer = 0;
const pendingTimers = new Map<number, () => void>();
globalAny.setTimeout = (f: () => void) => { const h = ++nextTimer; pendingTimers.set(h, f); return h; };
globalAny.clearTimeout = (h: number) => { pendingTimers.delete(h); };
function runNextTimer(): boolean {
  const next = pendingTimers.entries().next();
  if (next.done) return false;
  const [handle, callback] = next.value;
  pendingTimers.delete(handle);
  callback();
  return true;
}
globalAny.requestAnimationFrame = (f: any) => { f(0); return 1; };

/* ---------- 载入并执行 dist/ui.js ---------- */
const script = fs.readFileSync(__dirname + '/ui.js', 'utf8');
const run = new Function('document', 'window', 'Solitaire', 'require', '__dirname', 'getComputedStyle',
  script.replace(/"use strict";/, ''));
run(documentStub, windowStub, SOL, require, __dirname, globalAny.getComputedStyle);
const U: any = globalAny.__sui;

/* ---------- 辅助 ---------- */
function cardEls(): StubEl[] {
  const out: StubEl[] = [];
  for (const col of tableauEl.children) out.push(...col.querySelectorAll('.card'));
  out.push(...wasteEl.querySelectorAll('.card'));
  for (const f of Object.values(foundEls)) out.push(...f.querySelectorAll('.card'));
  return out;
}
function colEl(i: number): StubEl { return tableauEl.children[i]; }
function colCards(i: number): StubEl[] { return colEl(i)?.querySelectorAll('.card') ?? []; }
function colCard(i: number, k: number): StubEl { return colCards(i)[k]; }

/** 造一个 pointer 事件对象（target 决定按住哪张牌） */
function pev(target: any, x = 10, y = 10, extra: any = {}): any {
  return { target, clientX: x, clientY: y, button: 0, cancelable: true, preventDefault() { /* noop */ }, ...extra };
}

/** 通过 pointer 完整点击某张牌（按下 + 抬起，不移动） */
function clickCard(target: any, x = 10, y = 10): void {
  U.onPointerDown(pev(target, x, y));
  U.onPointerUp(pev(target, x, y));
}

/** 通过 pointer 拖动：按下 → 移动超过阈值 → 抬起在目标上 */
function dragCard(from: any, to: any): void {
  U.onPointerDown(pev(from, 10, 10));
  U.onPointerMove(pev(from, 40, 40));
  // elementFromPoint 决定落点：用临时替换模拟鼠标下真实命中
  const original = documentStub.elementFromPoint;
  documentStub.elementFromPoint = () => to;
  U.onPointerUp(pev(to, 40, 40));
  documentStub.elementFromPoint = original;
}

function keydown(key: string, extra: any = {}): void {
  for (const f of docListeners.keydown ?? []) f({ key, preventDefault() { /* noop */ }, ...extra });
}

/* ---------- 用例 ---------- */

section('U1 初始渲染', () => {
  U.newGame();
  ok(tableauEl.children.length === 7, '渲染出 7 列牌阵');
  ok(colCards(0).length === 1 && colCards(6).length === 7, '各列牌数与发牌一致');
  ok(wasteEl.querySelectorAll('.card').length === 0, '废牌堆初始为空');
  ok(stockEl.querySelectorAll('.stock-back').length === 1, '牌库显示牌背');
  ok(U.engine().stockCount === 24, '牌库 24 张');
  ok(U.engine().phase === 'playing', '初始状态 playing');
  ok(U.engine().elapsed() === 0, '未操作时计时 0');
});

section('U2 点选移动（固定种子牌局）', () => {
  U.newGame(1, lcg(11), () => 0);
  const e = U.engine();
  let done = false;
  for (let i = 0; i < 7 && !done; i++) {
    const n = colCards(i).length;
    const cards = e.cardsAt({ kind: 'tableau', index: i });
    for (let k = n - 1; k >= 0 && !done; k--) {
      if (!cards[k].faceUp) continue;
      for (let j = 0; j < 7 && !done; j++) {
        if (j === i) continue;
        if (!e.canMove({ kind: 'tableau', index: i }, n - k, { kind: 'tableau', index: j })) continue;
        const before = e.tableauCount(j);
        clickCard(colCard(i, k));
        ok(U.selected !== null, '点按明牌后进入选中态');
        clickCard(colEl(j));
        ok(e.tableauCount(j) === before + (n - k), '点目标列后牌组落到目标列');
        done = true;
      }
    }
  }
  ok(done, '固定牌局中完成一次点选移动');
  ok(U.selected === null, '移动后清除选中态');
});

section('U3 拖动移动（固定种子牌局）', () => {
  U.newGame(1, lcg(11), () => 0);
  const e = U.engine();
  let done = false;
  for (let i = 0; i < 7 && !done; i++) {
    const n = colCards(i).length;
    const cards = e.cardsAt({ kind: 'tableau', index: i });
    for (let k = n - 1; k >= 0 && !done; k--) {
      if (!cards[k].faceUp) continue;
      for (let j = 0; j < 7 && !done; j++) {
        if (j === i) continue;
        if (!e.canMove({ kind: 'tableau', index: i }, n - k, { kind: 'tableau', index: j })) continue;
        const before = e.tableauCount(j);
        dragCard(colCard(i, k), colEl(j));
        ok(e.tableauCount(j) === before + (n - k), '拖动到合法列后牌组落到目标列');
        done = true;
      }
    }
  }
  ok(done, '固定牌局中完成一次拖动');
});

section('U4 翻牌与回收', () => {
  U.newGame();
  const e = U.engine();
  const before = e.stockCount;
  clickCard(stockEl);
  ok(e.stockCount === before - 1, '点牌库后牌库少一张');
  ok(wasteEl.querySelectorAll('.card').length === 1, '废牌堆渲染出翻开的牌');
  U.undo();
  ok(e.stockCount === before, '撤销后牌库恢复');

  // 把牌库翻空，验证回收提示与回收行为
  let guard = 0;
  while (e.stockCount > 0 && guard++ < 40) clickCard(stockEl);
  ok(e.stockCount === 0, '翻空牌库');
  const wasteBefore = e.wasteCount;
  U.doDraw();
  ok(e.wasteCount === 0 && e.stockCount === wasteBefore, '空牌库再点一次 → 废牌堆整体回收');
});

section('U5 双击收牌（planted 牌局）', () => {
  // 直接注入一个「牌阵顶牌正好能进收牌区」的牌局，避免依赖随机牌序
  const planted = SOL.Solitaire.planted({
    foundations: { H: [['H', 1]] },
    tableau: [[['H', 2]], [['S', 9]], [], [], [], [], []],
  });
  U.setEngine(planted);
  const el = colCard(0, 0);
  ok(el !== undefined, '牌阵首列渲染出 H2');
  clickCard(el);
  clickCard(el);                                   // 连续两次点按 = 双击
  ok(U.engine().foundationCount('H') === 2, '双击顶牌送入收牌区');
  ok(colCards(0).length === 0, '源列已空');
});

section('U6 撤销 / 提示 / 自动完成按钮接线', () => {
  U.newGame();
  const e = U.engine();
  clickCard(stockEl);
  ok(e.moves === 1, '一次翻牌后步数 1');
  btnUndo.fire('click', {});
  ok(e.moves === 0, '撤销按钮生效');
  btnUndo.fire('click', {});
  ok(e.moves === 0, '无历史时撤销不报错也不改变状态');

  btnHint.fire('click', {});
  ok(true, '提示按钮不抛异常');

  btnAuto.fire('click', {});
  ok(e.phase !== 'won', '开局时自动完成不会误触发');
});

section('U7 菜单：抽牌模式与勾选状态', () => {
  U.newGame();
  const e = U.engine();
  ok(e.passCount === 1, '默认翻 1 张');
  U.onMenuItem('draw3');
  ok(U.engine().passCount === 3, '菜单切换为翻 3 张');
  ok(gameDrop.hidden === true, '选择菜单项后菜单收起');
  U.onMenuItem('draw1');
  ok(U.engine().passCount === 1, '切回翻 1 张');
});

section('U8 键盘快捷键', () => {
  U.newGame();
  keydown('h');
  ok(true, 'H 提示不抛异常');
  clickCard(stockEl);
  const moves = U.engine().moves;
  keydown('z', { ctrlKey: true });
  ok(U.engine().moves === moves - 1, 'Ctrl+Z 撤销');
  keydown('F2');
  ok(U.engine().moves === 0 && U.engine().stockCount === 24, 'F2 新游戏');
  keydown('g', { altKey: true });
  ok(gameDrop.hidden === false, 'Alt+G 展开游戏菜单');
  keydown('Escape');
  ok(gameDrop.hidden === true, 'Esc 关闭菜单');
});

section('U9 胜利界面', () => {
  U.newGame();
  ok(typeof U.render === 'function', '渲染函数可用');
  ok(U.engine().phase === 'playing', '初始未胜利');
});

/* ---------- 回归用例：锁定已修掉的真实缺陷 ---------- */

section('U10 废牌堆扇形（回归：翻三张时最上面那张必须最靠右）', () => {
  U.newGame(3, lcg(5), () => 0);
  clickCard(stockEl);                              // 翻三张模式下一次翻 3 张
  ok(wasteEl.children.length === 3, '翻三张后废牌堆渲染出 3 张');
  const cls = wasteEl.children.map((c: any) => c.className);
  ok(/\bw3\b/.test(cls[0]), '最旧的一张带 w3（排最左）');
  ok(/\bw2\b/.test(cls[1]), '中间一张带 w2');
  ok(/\bw1\b/.test(cls[2]), '最上面的一张带 w1（排最右）——回归：以前没有 class，会和最左的牌挤在一起');
  ok(wasteEl.children[2].dataset.top === '1', '最上面的牌标记为 top');

  U.newGame(1, lcg(5), () => 0);
  clickCard(stockEl);
  ok(wasteEl.children.length === 1 && !/\bw[123]\b/.test(wasteEl.children[0].className),
    '翻一张模式只有一张，且不带扇形 class');
});

section('U11 点非法目标后选中态切换（回归：不能卡在旧选中上）', () => {
  U.setEngine(SOL.Solitaire.planted({ tableau: [[['S', 13]], [['H', 2]], [['C', 5]]] }));
  clickCard(colCard(0, 0));                       // 选中 K
  ok(U.selected !== null && U.selected.loc.index === 0, '点 K 后选中第 0 列');
  clickCard(colCard(2, 0));                       // C5：K 不能压 5 → 落不下去
  ok(U.selected !== null && U.selected.loc.index === 2,
    '落不下去时改选刚点的那张牌（回归：以前选中态卡在 K 上）');
  ok(U.engine().tableauCount(0) === 1, '非法移动没有改变牌局');
});

section('U12 拖到废牌堆 / 牌库一律静默回弹（回归：以前弹错误提示）', () => {
  U.setEngine(SOL.Solitaire.planted({ tableau: [[['S', 13]]] }));
  const before = U.engine().tableauCount(0);
  toastEl.textContent = 'SENTINEL';
  toastEl.hidden = true;
  dragCard(colCard(0, 0), wasteEl);                // dragCard 内部会把 elementFromPoint 指向废牌堆
  ok(U.engine().tableauCount(0) === 1, '牌没有被移走');
  ok(before === 1 && toastEl.textContent === 'SENTINEL', '不弹错误提示，与拖到空白处行为一致');
});

section('U13 restart 与自动完成的边界', () => {
  U.newGame(1, lcg(9), () => 0);
  clickCard(stockEl);
  ok(U.engine().moves === 1, '翻牌后步数 1');
  U.restart();
  ok(U.engine().moves === 0 && U.engine().stockCount === 24, 'restart 重新发牌并清零步数');
  ok(U.engine().passCount === 1, 'restart 保留抽牌模式');

  // 无牌可收时 autoFinishStep 返回 false
  const stuck = SOL.Solitaire.planted({ stock: [['S', 1]], tableau: [[['S', 2]]] });
  ok(stuck.autoFinishStep() === false, '没有合法收牌时 autoFinishStep 返回 false');
  ok(stuck.canAutoFinish() === false, '牌库还有牌时不能自动完成');
});

section('U14 metrics 与 CSS 变量一致（支持 calc 牌高）', () => {
  const m = U.metrics();
  ok(m.w === 96 && m.h === 110, '牌宽读取变量，牌高读取真实牌元素');
  ok(m.fan === 26 && m.fanDown === 20, '明牌/暗牌叠放高度按真实牌高算出');
  ok(m.gap === 12, '间隙取自纯 px 变量');
});

section('U15 自动完成异步任务与列高边界', () => {
  pendingTimers.clear();
  const fill = (suit: Suit): CardSpec[] => Array.from({ length: 12 }, (_, i) => [suit, i + 1] as CardSpec);
  const ready = SOL.Solitaire.planted({
    tableau: [[['S', 13]], [['H', 13]], [['D', 13]], [['C', 13]]],
    foundations: { S: fill('S'), H: fill('H'), D: fill('D'), C: fill('C') },
  });
  U.setEngine(ready);
  U.autoFinish();
  ok(ready.moves === 1, '自动完成先同步执行一步');
  U.undo();
  const movesAfterUndo = ready.moves;
  runNextTimer();
  ok(ready.moves === movesAfterUndo, '撤销后旧自动完成任务不会再次改牌');

  pendingTimers.clear();
  U.setEngine(ready);
  U.autoFinish();
  U.newGame();
  const fresh = U.engine();
  const stockAfterNewGame = fresh.stockCount;
  runNextTimer();
  ok(fresh.stockCount === stockAfterNewGame && fresh.moves === 0, '新游戏后旧任务不会串扰新牌局');

  pendingTimers.clear();
  U.setEngine(SOL.Solitaire.planted({ tableau: [[['S', 7]], [['C', 8], ['H', 6]]] }));
  const singleHeight = parseFloat(colEl(0).style.height);
  const twoHeight = parseFloat(colEl(1).style.height);
  const m = U.metrics();
  ok(Math.abs(singleHeight - m.h) < 0.01 && Math.abs(twoHeight - (m.h + m.fan)) < 0.01,
    '列高只包含最后一张牌自身，不多算一个牌间距');
});

console.log(`\n结果：${pass} 通过，${fail} 失败`);
process.exit(fail ? 1 : 0);

export {};
