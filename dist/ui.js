"use strict";
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
const $ = (s) => document.querySelector(s);
const $$ = (s, root) => (root ?? document).querySelectorAll(s);
/* ---- 花色图形：纯内联 SVG，currentColor 上色，零字体/图片 ----
   四种花色轮廓刻意拉开差异（尖顶黑桃 vs 三叶梅花、尖角方块 vs 圆弧红桃）
   并配四种可区分的墨色/红色，让「红黑交替」规则一眼可判。 */
const SUIT_PATH = {
    S: '<path d="M16 2C16 2 3 13.4 3 20.2c0 3.7 2.8 6.4 6.4 6.4 1.9 0 3.5-.8 4.5-2-.2 2.5-.8 4.3-1.7 5.8h7.6c-.9-1.5-1.5-3.3-1.7-5.8 1 1.2 2.6 2 4.5 2 3.6 0 6.4-2.7 6.4-6.4C29 13.4 16 2 16 2z"/>',
    H: '<path d="M16 30.4C16 30.4 2 21.2 2 11.2 2 6 6.1 1.6 11.2 1.6c2.7 0 4.3 1.4 4.8 2.7.5-1.3 2.1-2.7 4.8-2.7C25.9 1.6 30 6 30 11.2c0 10-14 19.2-14 19.2z"/>',
    D: '<path d="M16 .8c2.9 7.4 7 11.8 13.3 15.2C23 19.4 18.9 23.8 16 31.2 13.1 23.8 9 19.4 2.7 16 9 12.6 13.1 8.2 16 .8z"/>',
    C: '<circle cx="16" cy="10" r="6.4"/><circle cx="8.3" cy="20" r="6.4"/><circle cx="23.7" cy="20" r="6.4"/>'
        + '<path d="M14.2 31.2h3.6l-.6-9.2c.8 1.2 2.1 2 3.5 2.4-.9 2.5-1.7 4.4-2.4 5.8h-5.2c-.7-1.4-1.5-3.3-2.4-5.8 1.4-.4 2.7-1.2 3.5-2.4z"/>',
};
/** 花色 SVG。size 控制视觉大小，shape 用不同 class 让四种花色形态更易区分 */
function suitSvg(suit, cls = '') {
    return '<svg class="ps ' + cls + '" viewBox="0 0 32 32" aria-hidden="true">' + SUIT_PATH[suit] + '</svg>';
}
/* ---- 七段 LED（与扫雷同款；显示步数与用时） ---- */
const SEG_ON = '#f00', SEG_OFF = '#3d0000';
const SEG_POS = {
    a: 'left:23.0769%;top:0;width:53.8462%;height:8.6957%', d: 'left:23.0769%;top:91.3043%;width:53.8462%;height:8.6957%',
    g: 'left:23.0769%;top:45.6522%;width:53.8462%;height:8.6957%',
    f: 'left:0;top:8.6957%;width:15.3846%;height:36.9565%', b: 'left:84.6154%;top:8.6957%;width:15.3846%;height:36.9565%',
    e: 'left:0;top:54.3478%;width:15.3846%;height:36.9565%', c: 'left:84.6154%;top:54.3478%;width:15.3846%;height:36.9565%',
};
const SEG_MAP = {
    '0': 'abcdef', '1': 'bc', '2': 'abged', '3': 'abgcd', '4': 'fgbc', '5': 'afgcd',
    '6': 'afgedc', '7': 'abc', '8': 'abcdefg', '9': 'abfgcd', '-': 'g', ' ': '',
};
function makeLed(el) {
    const digits = [], segs = [];
    for (let d = 0; d < 3; d++) {
        const dig = document.createElement('div');
        dig.className = 'led-digit';
        const row = [];
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
    const set = (v) => {
        const clean = Math.max(-99, Math.min(999, Math.floor(Number(v) || 0)));
        const neg = clean < 0;
        const text = (neg ? '-' : '') + String(Math.abs(clean)).padStart(neg ? 2 : 3, '0');
        const shown = text.slice(-3);
        for (let d = 0; d < 3; d++) {
            const ch = shown[d] ?? ' ';
            const on = SEG_MAP[ch] ?? '';
            const row = segs[d];
            for (let i = 0; i < row.length; i++) {
                row[i].style.backgroundColor = on.includes('abcdefg'[i]) ? SEG_ON : SEG_OFF;
            }
        }
    };
    return { el, segs, set };
}
/* ---- 牌元素 ---- */
/** 中央花色排布：双列固定在 40% / 60%，为两侧角标（尤其 10）留出空间。 */
const PIP_LAYOUT = {
    2: [[50, 22], [50, 78]],
    3: [[50, 20], [50, 50], [50, 80]],
    4: [[40, 22], [60, 22], [40, 78], [60, 78]],
    5: [[40, 22], [60, 22], [50, 50], [40, 78], [60, 78]],
    6: [[40, 20], [60, 20], [40, 50], [60, 50], [40, 80], [60, 80]],
    7: [[40, 20], [60, 20], [50, 35], [40, 50], [60, 50], [40, 80], [60, 80]],
    8: [[40, 20], [60, 20], [50, 35], [40, 50], [60, 50], [50, 65], [40, 80], [60, 80]],
    9: [[40, 18], [60, 18], [40, 36], [60, 36], [50, 50], [40, 64], [60, 64], [40, 82], [60, 82]],
    10: [[40, 16], [60, 16], [50, 28], [40, 40], [60, 40], [40, 60], [60, 60], [50, 72], [40, 84], [60, 84]],
};
function cardInner(card) {
    const r = rankLabel(card.rank);
    const sm = suitSvg(card.suit);
    const cornerHtml = '<span class="r">' + r + '</span><span class="s">' + sm + '</span>';
    const corners = '<div class="corner tl">' + cornerHtml + '</div><div class="corner br">' + cornerHtml + '</div>';
    if (card.rank === 1)
        return corners + '<div class="pip ace">' + suitSvg(card.suit) + '</div>';
    if (card.rank >= 11) {
        // J / Q / K：中央画框 + 大字母 + 花色徽记（零人物图、零资源）
        return corners + '<div class="court"><span class="letter">' + r + '</span><span class="s">' + sm + '</span></div>';
    }
    const layout = PIP_LAYOUT[card.rank];
    if (!layout)
        return corners;
    let pips = '';
    for (const [x, y] of layout) {
        pips += '<div class="pip' + (y > 50 ? ' flip' : '') + '" style="left:' + x + '%;top:' + y + '%">' + suitSvg(card.suit) + '</div>';
    }
    return corners + pips;
}
function cardEl(card, extraClass = '') {
    const el = document.createElement('div');
    const suitCls = 's-' + card.suit;
    el.className = 'card ' + (card.faceUp ? 'face-up ' + (isRed(card) ? 'red ' : 'black ') + suitCls : 'back') + (extraClass ? ' ' + extraClass : '');
    el.innerHTML = card.faceUp ? cardInner(card) : '<div class="back-inner"></div>';
    return el;
}
/* ---- 应用状态 ---- */
let engine;
let ledScore, ledTime;
let selected = null;
let drag = null;
let lastClick = null;
/** 「可以自动完成了」的提示每局只弹一次 */
let autoPromptShown = false;
/** 自动完成定时器及所属牌局；撤销/新局时必须使旧回调失效。 */
let autoFinishTimer = null;
let gameGeneration = 0;
let hintTimer = null;
let winTimer = null;
let clockTimer = null;
let toastTimer = null;
let passCount = 1;
let menuOpen = null;
const tableEl = () => $('#table');
const dragLayer = () => $('#dragLayer');
const tableauEl = () => $('#tableau');
/* ---- 尺寸：宽度和间距读取纯 px 变量；高度读取 CSS calc 计算后的真实牌高。
       这样牌高可以始终与牌宽保持同一比例，又不会让 JS 布局与真实画面漂移。 ---- */
function metrics() {
    const cs = typeof getComputedStyle === 'function' ? getComputedStyle(document.documentElement) : null;
    const read = (name, fallback) => {
        const v = parseFloat(String(cs?.getPropertyValue?.(name) ?? ''));
        return Number.isFinite(v) ? v : fallback;
    };
    const w = read('--card-w', 96);
    const actualCard = $('#stock .stock-back') ?? $('#stock');
    const measuredH = actualCard?.getBoundingClientRect?.().height;
    const h = Number.isFinite(measuredH) && measuredH > 0
        ? measuredH
        : Math.round(w * 1.35);
    const fan = Math.round(h * read('--fan-ratio', 0.24));
    const fanDown = Math.round(h * read('--fan-down-ratio', 0.16));
    const gap = read('--gap', 12);
    return { w, h, fan, fanDown, gap };
}
/* ---- 渲染 ---- */
function render() {
    renderStock();
    renderWaste();
    renderFoundations();
    renderTableau();
    renderStatus();
    syncMenuChecks();
    syncButtons();
    if (selected)
        markSelected();
}
function renderStock() {
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
    }
    else if (engine.wasteCount) {
        const n = document.createElement('span');
        n.className = 'stock-count';
        n.textContent = String(engine.wasteCount);
        el.appendChild(n);
    }
}
function renderWaste() {
    const el = $('#waste');
    el.innerHTML = '';
    const cards = engine.cardsAt({ kind: 'waste' });
    const start = Math.max(0, cards.length - 3);
    for (let i = start; i < cards.length; i++) {
        const c = cards[i];
        const offset = cards.length - 1 - i; // 0 = 最上面
        // 三张扇形：最上面那张必须给 w1（最右 26%），否则它会和最下面的牌挤在一起（修过的 bug）
        const cls = engine.passCount === 3 && cards.length > 1 ? 'w' + (offset + 1) : '';
        const ce = cardEl(c, cls);
        ce.dataset.pile = 'waste';
        ce.dataset.index = String(i);
        ce.style.zIndex = String(i - start + 1);
        if (i === cards.length - 1)
            ce.dataset.top = '1';
        el.appendChild(ce);
    }
}
function renderFoundations() {
    for (const s of SUITS) {
        const el = $('#found' + s);
        el.innerHTML = '';
        el.classList.add('s-' + s); // 空位花色底纹靠 class 定位（CSS ::before 用 data-URI SVG）
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
function renderTableau() {
    const root = tableauEl();
    root.innerHTML = '';
    const { h, fan, fanDown } = metrics();
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
            if (k === cards.length - 1)
                ce.dataset.top = '1';
            col.appendChild(ce);
            y += c.faceUp ? fan : fanDown;
        }
        // 列高随牌数增长：给父容器撑开滚动/布局高度
        // y 已包含每张牌（含最后一张）的偏移，最后一张只需再补自身高度。
        const lastStep = cards.length ? (cards[cards.length - 1].faceUp ? fan : fanDown) : 0;
        const columnHeight = cards.length ? y - lastStep + h : h;
        col.style.height = columnHeight + 'px';
        col.style.minHeight = columnHeight + 'px';
        root.appendChild(col);
    }
}
function renderStatus() {
    ledScore.set(engine.moves);
    ledTime.set(engine.elapsed());
}
function syncButtons() {
    const hintBtn = $('#btnHint');
    const autoBtn = $('#btnAuto');
    // 撤销在胜利后仍可用：按钮行为与引擎、菜单、快捷键保持一致。
    if (hintBtn)
        hintBtn.disabled = engine.phase === 'won';
    if (autoBtn)
        autoBtn.disabled = !engine.canAutoFinish();
}
function syncMenuChecks() {
    const d1 = $('[data-act="draw1"]');
    const d3 = $('[data-act="draw3"]');
    const setChk = (el, on) => {
        const chk = el?.querySelector?.('.chk');
        if (chk)
            chk.textContent = on ? '●' : ' ';
    };
    setChk(d1, engine.passCount === 1);
    setChk(d3, engine.passCount === 3);
}
function markSelected() {
    clearSelectionMarks();
    if (!selected)
        return;
    const { loc, count } = selected;
    const cards = topCardsOf(loc, count);
    for (const ce of cards)
        ce.classList.add('selected');
}
function clearSelectionMarks() {
    for (const ce of $$('.card.selected'))
        ce.classList.remove('selected');
}
function topCardsOf(loc, count) {
    if (loc.kind === 'tableau') {
        const col = tableauEl().children[loc.index];
        if (!col)
            return [];
        const cards = Array.from(col.querySelectorAll('.card'));
        return cards.slice(Math.max(0, cards.length - count));
    }
    if (loc.kind === 'waste') {
        const cards = Array.from($('#waste').querySelectorAll('.card'));
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
function selectSource(src) {
    selected = src;
    markSelected();
}
function clearTransient() {
    clearHint();
    hideToast();
    clearSelectionMarks();
    selected = null;
    $$('.drop-ok').forEach((n) => n.classList.remove('drop-ok'));
}
function tryMove(src, dst) {
    stopAutoFinish();
    const res = engine.move(src.loc, src.count, dst);
    if (!res.ok) {
        toast(res.reason, 1400);
        return false;
    }
    clearTransient();
    render();
    checkAutoFinishPrompt();
    if (engine.phase === 'won')
        winSequence();
    return true;
}
/** 元素 → 所属牌堆。
    牌元素自身带 data-pile；空槽/整列元素靠 class 与 data-suit / data-col 识别。
    两者都要支持：点空白列、点收牌区空位都是常见操作。 */
function pileFromElement(el) {
    if (!el)
        return null;
    // 从最近的「牌」或「槽/列」节点取语义
    const host = el.closest?.('.card, .slot, .col') ?? el;
    const kind = host.dataset?.pile;
    if (kind === 'stock' || host.classList?.contains('stock'))
        return { kind: 'stock' };
    if (kind === 'waste' || host.classList?.contains('waste'))
        return { kind: 'waste' };
    if (kind === 'foundation' || host.classList?.contains('foundation')) {
        const suit = host.dataset?.suit;
        return suit ? { kind: 'foundation', suit: suit } : null;
    }
    if (kind === 'tableau' || host.classList?.contains('card') || host.classList?.contains('col')) {
        // 牌元素本身带 data-col；空槽/整列靠祖先 .col 的 data-col
        const colEl = host.dataset?.col !== undefined ? host : host.closest?.('.col');
        const idx = colEl?.dataset?.col;
        return idx === undefined ? null : { kind: 'tableau', index: Number(idx) };
    }
    return null;
}
/** 从事件目标回溯出「被按住的那张牌」以及可移动的牌组 */
function sourceAt(target, clientX, clientY) {
    const card = target?.closest?.('.card');
    if (card) {
        const pile = card.dataset.pile;
        if (pile === 'stock')
            return null;
        if (pile === 'waste') {
            if (card.dataset.top !== '1')
                return null;
            return { loc: { kind: 'waste' }, count: 1 };
        }
        if (pile === 'foundation') {
            return { loc: { kind: 'foundation', suit: card.dataset.suit }, count: 1 };
        }
        if (pile === 'tableau') {
            const col = Number(card.dataset.col);
            const idx = Number(card.dataset.index);
            const cards = engine.cardsAt({ kind: 'tableau', index: col });
            if (!cards[idx]?.faceUp)
                return null;
            const count = cards.length - idx;
            for (let k = idx; k < cards.length; k++)
                if (!cards[k].faceUp)
                    return null;
            return { loc: { kind: 'tableau', index: col }, count };
        }
    }
    // 点空白列：只有空列能作为「无牌可拖」的目标（由调用方处理）
    const col = target?.closest?.('.col');
    if (col)
        return null;
    return null;
}
/** 指针位置 → 目标牌堆（以元素命中为准，触摸也一样） */
function dropTargetAt(x, y, src) {
    const el = document.elementFromPoint ? document.elementFromPoint(x, y) : null;
    if (!el)
        return null;
    const pile = pileFromElement(el);
    if (!pile)
        return null;
    // 牌库永远不能作为落点；废牌堆也不收牌（统一行为：非法落点一律静默回弹，
    // 不要让「拖到废牌堆」弹错误 toast 而「拖到空白处」却无反应）
    if (pile.kind === 'stock' || pile.kind === 'waste')
        return null;
    return pile;
}
/* ---- 指针事件 ---- */
function onPointerDown(e) {
    if (e.button !== undefined && e.button !== 0)
        return;
    closeMenu();
    const target = e.target;
    const src = sourceAt(target, e.clientX, e.clientY);
    if (!src) {
        // 点牌库 → 翻牌
        const stock = target?.closest?.('.slot.stock');
        if (stock) {
            doDraw();
            return;
        }
        // 点空白列：若已有选中牌，尝试放下
        if (selected) {
            const pile = pileFromElement(target?.closest?.('.slot, .col'));
            if (pile)
                tryMove(selected, pile);
            else
                clearTransient();
            return;
        }
        clearTransient();
        return;
    }
    if (engine.phase === 'won')
        return;
    const rect = target.getBoundingClientRect?.() ?? { left: 0, top: 0 };
    drag = {
        source: src,
        el: null,
        startX: e.clientX ?? 0, startY: e.clientY ?? 0,
        offsetX: (e.clientX ?? 0) - rect.left,
        offsetY: (e.clientY ?? 0) - rect.top,
        moved: false,
    };
    // 拖拽期间持续收到指针事件（鼠标移出窗口也能正确收尾）
    try {
        tableEl().setPointerCapture?.(e.pointerId);
    }
    catch { /* 忽略不支持的环境 */ }
    // 阻止触屏滚动与文本选择
    if (e.cancelable)
        e.preventDefault?.();
}
function onPointerMove(e) {
    if (!drag)
        return;
    const x = e.clientX ?? 0, y = e.clientY ?? 0;
    const dx = x - drag.startX, dy = y - drag.startY;
    if (!drag.moved) {
        if (Math.abs(dx) < 6 && Math.abs(dy) < 6)
            return;
        drag.moved = true;
        beginDragVisual();
    }
    moveDragVisual(x, y);
    highlightDrop(dropTargetAt(x, y, drag.source));
}
function onPointerUp(e) {
    if (!drag)
        return;
    const d = drag;
    drag = null;
    const x = e.clientX ?? d.startX, y = e.clientY ?? d.startY;
    if (!d.moved) {
        // 双击判定必须放在「再点同一张取消选中」之前，
        // 否则第一次点击已经选中，第二次只会取消选中，双击永远收不了牌。
        const now = Date.now();
        const dblHit = lastClick !== null && now - lastClick.at < 400 && sameLocation(lastClick.loc, d.source.loc);
        lastClick = { loc: d.source.loc, at: now };
        if (dblHit && d.source.count === 1 && autoCollect(d.source.loc))
            return;
        // 已有选中牌 → 点目标放下（点同一张则取消选中）
        if (selected && !sameLocation(selected.loc, d.source.loc) && d.source.loc.kind !== 'stock') {
            if (tryMove(selected, d.source.loc))
                return;
            // 落不下去时不能让选中态卡住：改选刚点的这张牌（与经典 Klondike 一致）
            selectSource(d.source);
            return;
        }
        if (selected && sameLocation(selected.loc, d.source.loc)) {
            selectSource(null);
            return;
        }
        selectSource(d.source);
        return;
    }
    // 拖动结束：落点合法就移动，否则回弹
    const dst = dropTargetAt(x, y, d.source);
    clearDragVisual();
    clearDropHighlights();
    if (dst)
        tryMove(d.source, dst);
    else
        render();
}
function onPointerCancel() {
    if (!drag)
        return;
    drag = null;
    clearDragVisual();
    clearDropHighlights();
    render();
}
function beginDragVisual() {
    if (!drag)
        return;
    const { loc, count } = drag.source;
    const els = topCardsOf(loc, count);
    const layer = dragLayer();
    layer.innerHTML = '';
    layer.hidden = false;
    const stack = document.createElement('div');
    stack.className = 'drag-stack';
    const { fan } = metrics();
    els.forEach((ce, i) => {
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
function moveDragVisual(x, y) {
    if (!drag?.el)
        return;
    const rect = tableEl().getBoundingClientRect?.() ?? { left: 0, top: 0 };
    drag.el.style.left = (x - rect.left - drag.offsetX) + 'px';
    drag.el.style.top = (y - rect.top - drag.offsetY) + 'px';
}
function clearDragVisual() {
    const layer = dragLayer();
    if (layer) {
        layer.innerHTML = '';
        layer.hidden = true;
    }
    // 只把被临时隐藏的原牌恢复，不重建 DOM（避免拖动结束时闪一下）
    for (const n of $$('.card'))
        if (n.style.visibility === 'hidden')
            n.style.visibility = '';
}
function highlightDrop(dst) {
    clearDropHighlights();
    if (!dst)
        return;
    if (!engine.canMove(drag.source.loc, drag.source.count, dst))
        return;
    const el = dst.kind === 'tableau' ? tableauEl().children[dst.index]
        : dst.kind === 'foundation' ? $('#found' + dst.suit)
            : dst.kind === 'waste' ? $('#waste') : null;
    if (el)
        el.classList.add('drop-ok');
    else if (dst.kind === 'tableau')
        tableauEl().children[dst.index]?.classList.add('drop-ok');
}
function clearDropHighlights() {
    for (const n of $$('.drop-ok'))
        n.classList.remove('drop-ok');
}
/* ---- 双击收牌 ---- */
function autoCollect(loc) {
    stopAutoFinish();
    const suit = engine.autoMove(loc);
    if (!suit)
        return false;
    clearTransient();
    render();
    checkAutoFinishPrompt();
    if (engine.phase === 'won')
        winSequence();
    return true;
}
/* ---- 牌库 ---- */
function doDraw() {
    if (engine.phase === 'won')
        return;
    stopAutoFinish();
    const r = engine.draw();
    clearTransient();
    render();
    if (r.recycled)
        toast('废牌堆已回收，重新翻牌', 1200);
    else if (engine.stockCount === 0 && engine.wasteCount > 0)
        toast('牌库已空，点击牌库可回收废牌堆', 1600);
}
/* ---- 提示 ---- */
function clearHint() {
    if (hintTimer) {
        clearTimeout(hintTimer);
        hintTimer = null;
    }
    for (const n of $$('.hint-src, .hint-dst'))
        n.classList.remove('hint-src', 'hint-dst');
}
function showHint() {
    if (engine.phase === 'won')
        return;
    clearHint();
    const h = engine.hint();
    if (!h) {
        toast('暂时没有可走的牌了，可以撤销或重新发牌', 1800);
        return;
    }
    if (h.from.kind === 'stock') {
        toast(h.text, 1600);
        return;
    }
    toast(h.text, 2200);
    const srcHost = h.from.kind === 'tableau' ? tableauEl().children[h.from.index]
        : h.from.kind === 'foundation' ? $('#found' + h.from.suit)
            : h.from.kind === 'waste' ? $('#waste') : null;
    if (srcHost)
        srcHost.classList.add('hint-src');
    const dstHost = h.to.kind === 'tableau' ? tableauEl().children[h.to.index]
        : h.to.kind === 'foundation' ? $('#found' + h.to.suit)
            : h.to.kind === 'waste' ? $('#waste') : null;
    if (dstHost)
        dstHost.classList.add('hint-dst');
    hintTimer = setTimeout(clearHint, 2400);
}
/* ---- 自动完成 ---- */
function checkAutoFinishPrompt() {
    if (autoPromptShown)
        return;
    if (engine.canAutoFinish() && engine.phase === 'playing') {
        autoPromptShown = true;
        toast('全部牌已翻开，可以点「自动完成」收尾', 2600);
    }
}
function stopAutoFinish() {
    if (autoFinishTimer !== null) {
        clearTimeout(autoFinishTimer);
        autoFinishTimer = null;
    }
    // 即使当前正处于同步 step 中，也让尚未排队的旧回调失效。
    gameGeneration++;
}
function autoFinish() {
    if (engine.phase === 'won')
        return;
    if (!engine.canAutoFinish()) {
        toast('牌库和废牌堆清空、所有牌翻开后才能自动完成', 2000);
        return;
    }
    stopAutoFinish();
    clearTransient();
    const generation = gameGeneration;
    let guard = 0;
    const step = () => {
        autoFinishTimer = null;
        if (generation !== gameGeneration || engine.phase === 'won' || guard++ > 200) {
            if (generation !== gameGeneration)
                return;
            render();
            if (engine.phase === 'won')
                winSequence();
            return;
        }
        if (!engine.autoFinishStep()) {
            render();
            return;
        }
        render();
        autoFinishTimer = setTimeout(step, 90);
    };
    step();
}
/* ---- 新游戏 / 撤销 ---- */
function newGame(pass, rand, clock) {
    stopAutoFinish();
    if (pass !== undefined)
        passCount = pass;
    autoPromptShown = false;
    if (winTimer) {
        clearTimeout(winTimer);
        winTimer = null;
    }
    for (const n of $$('.win-banner, .bouncing'))
        n.remove?.();
    engine = new ENGINE(rand ?? Math.random, clock, passCount);
    clearTransient();
    render();
    startClock();
}
function restart() {
    stopAutoFinish();
    autoPromptShown = false;
    if (winTimer) {
        clearTimeout(winTimer);
        winTimer = null;
    }
    for (const n of $$('.win-banner, .bouncing'))
        n.remove?.();
    engine.restart(passCount);
    clearTransient();
    render();
    startClock();
}
function undo() {
    stopAutoFinish();
    if (!engine.undo()) {
        toast('没有可撤销的操作', 1200);
        return;
    }
    for (const n of $$('.win-banner, .bouncing'))
        n.remove?.();
    if (winTimer) {
        clearTimeout(winTimer);
        winTimer = null;
    }
    clearTransient();
    render();
    // 从胜利状态撤销后恢复时钟刷新。
    if (!clockTimer)
        startClock();
}
/* ---- 计时刷新 ---- */
function startClock() {
    if (clockTimer) {
        clearInterval(clockTimer);
        clockTimer = null;
    }
    clockTimer = setInterval(() => {
        ledTime.set(engine.elapsed());
        if (engine.phase === 'won' && clockTimer) {
            clearInterval(clockTimer);
            clockTimer = null;
        }
    }, 500);
}
/* ---- 胜利动画：经典纸牌弹跳 ---- */
function winSequence() {
    if (winTimer || engine.phase !== 'won')
        return;
    const generation = gameGeneration;
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
        if (!card)
            continue;
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
        const tick = () => {
            if (!alive || generation !== gameGeneration || engine.phase !== 'won')
                return;
            vy += 0.35;
            x += vx;
            y += vy;
            if (x < 0) {
                x = 0;
            }
            if (x + w > W) {
                x = W - w;
            }
            if (y + h > H) {
                y = H - h;
                vy = -Math.abs(vy) * 0.78;
                if (Math.abs(vy) < 1.2)
                    alive = false;
            }
            c.style.transform = 'translate(' + Math.round(x - x0) + 'px,' + Math.round(y - y0) + 'px)';
            if (alive)
                requestAnimationFrame(tick);
            else
                c.remove?.();
        };
        setTimeout(() => {
            if (generation === gameGeneration && engine.phase === 'won' && typeof requestAnimationFrame === 'function') {
                requestAnimationFrame(tick);
            }
        }, Math.random() * 400);
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
function toast(text, ms = 1600) {
    const el = $('#toast');
    if (!el)
        return;
    el.textContent = text;
    el.hidden = false;
    if (toastTimer)
        clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.hidden = true; toastTimer = null; }, ms);
}
function hideToast() {
    const el = $('#toast');
    if (el)
        el.hidden = true;
    if (toastTimer) {
        clearTimeout(toastTimer);
        toastTimer = null;
    }
}
/* ---- 菜单 ---- */
function closeMenu() {
    if (!menuOpen)
        return;
    menuOpen.drop.hidden = true;
    menuOpen.title.classList.remove('active');
    menuOpen = null;
}
function openMenuOf(menu) {
    const drop = menu?.querySelector?.('.dropdown');
    const title = menu?.querySelector?.('.menutitle');
    if (!drop || !title)
        return;
    if (menuOpen && menuOpen.drop === drop) {
        closeMenu();
        return;
    }
    closeMenu();
    drop.hidden = false;
    title.classList.add('active');
    menuOpen = { menu, drop, title };
}
function toggleMenuById(id) {
    openMenuOf($('#' + id));
}
function onMenuItem(act) {
    closeMenu();
    switch (act) {
        case 'new':
            newGame();
            break;
        case 'restart':
            restart();
            break;
        case 'draw1':
            newGame(1);
            break;
        case 'draw3':
            newGame(3);
            break;
        case 'undo':
            undo();
            break;
        case 'hint':
            showHint();
            break;
        case 'autofinish':
            autoFinish();
            break;
        case 'rules':
            showRules();
            break;
        case 'about':
            showAbout();
            break;
    }
}
function showRules() {
    const el = $('.rules');
    if (el?.scrollIntoView)
        el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    else
        toast('目标：把四门花色从 A 到 K 收齐。牌阵红黑交替、点数递减；空列只能放 K。', 4200);
}
function showAbout() {
    toast('经典纸牌接龙 · TypeScript + 原生 DOM，零运行时依赖', 3600);
}
/* ---- 事件绑定 ---- */
function bindEvents() {
    const table = tableEl();
    table.addEventListener('pointerdown', onPointerDown);
    // 用 pointer capture 保证移出牌桌/窗口后仍能收到 move/up（触屏尤其重要）
    table.addEventListener('lostpointercapture', () => onPointerCancel());
    document.addEventListener('pointermove', onPointerMove);
    document.addEventListener('pointerup', onPointerUp);
    document.addEventListener('pointercancel', onPointerCancel);
    // 菜单标题
    for (const title of $$('.menutitle')) {
        title.addEventListener('mousedown', (e) => {
            e.preventDefault?.();
            e.stopPropagation?.();
            openMenuOf(title.closest('.menu'));
        });
    }
    // 菜单项
    document.addEventListener('mousedown', (e) => {
        const mi = e.target?.closest?.('.mi');
        if (mi) {
            e.preventDefault?.();
            const act = mi.dataset.act;
            if (act)
                onMenuItem(act);
            return;
        }
        if (!e.target?.closest?.('.menu'))
            closeMenu();
    });
    // 按钮
    $('#btnUndo')?.addEventListener('click', undo);
    $('#btnHint')?.addEventListener('click', showHint);
    $('#btnAuto')?.addEventListener('click', autoFinish);
    // 键盘
    document.addEventListener('keydown', (e) => {
        const k = (e.key ?? '').toLowerCase();
        if (e.key === 'F2') {
            e.preventDefault();
            newGame();
            return;
        }
        if ((e.ctrlKey || e.metaKey) && k === 'z') {
            e.preventDefault();
            undo();
            return;
        }
        if (e.altKey && k === 'g') {
            e.preventDefault();
            toggleMenuById('menuGame');
            return;
        }
        if (e.altKey && k === 'h') {
            e.preventDefault();
            toggleMenuById('menuHelp');
            return;
        }
        if (e.key === 'Escape') {
            clearTransient();
            closeMenu();
            return;
        }
        if (menuOpen) {
            // 菜单展开时：字母直接触发对应项；G/H 收起当前菜单（与原版一致）。
            // 「帮助」菜单里的 H 既是展开键又是「玩法说明」的助记键，这里以菜单项优先。
            const inHelp = menuOpen.menu === $('#menuHelp');
            const map = inHelp
                ? { r: 'rules', a: 'about', g: 'close', h: 'close' }
                : { n: 'new', r: 'restart', u: 'undo', f: 'autofinish', '1': 'draw1', '3': 'draw3', h: 'hint', g: 'close' };
            const act = map[k];
            if (act === 'close') {
                closeMenu();
                return;
            }
            if (act) {
                e.preventDefault();
                onMenuItem(act);
                return;
            }
            return;
        }
        if (k === 'h') {
            e.preventDefault();
            showHint();
            return;
        }
        if (k === 'f') {
            e.preventDefault();
            autoFinish();
            return;
        }
        if (k === 'u') {
            e.preventDefault();
            undo();
            return;
        }
        if (k === 'n') {
            e.preventDefault();
            newGame();
            return;
        }
    });
    window.addEventListener('blur', () => {
        stopAutoFinish();
        if (drag) {
            drag = null;
            clearDragVisual();
            clearDropHighlights();
        }
        closeMenu();
    });
    window.addEventListener('resize', () => { render(); });
}
/* ---- 启动 ---- */
function init() {
    ledScore = makeLed($('#ledScore'));
    ledTime = makeLed($('#ledTime'));
    engine = new ENGINE(Math.random, undefined, 1);
    bindEvents();
    render();
    startClock();
}
init();
/* 测试钩子：uitest 以最小 DOM stub 执行本文件后，借它驱动流程（生产环境无害） */
globalThis.__sui = {
    newGame, restart, undo, doDraw, showHint, autoFinish,
    setEngine(e) { engine = e; autoPromptShown = false; render(); },
    engine: () => engine,
    render,
    metrics,
    get selected() { return selected; },
    selectSource,
    tryMove,
    onPointerDown, onPointerMove, onPointerUp, onPointerCancel,
    onMenuItem,
    closeMenu, openMenuOf, toggleMenuById,
    get passCount() { return passCount; },
    set passCount(v) { passCount = v; },
    ledScore: () => ledScore,
    ledTime: () => ledTime,
    toast,
};
