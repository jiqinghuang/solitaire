"use strict";
/* 纸牌接龙（Klondike）引擎：纯逻辑，零 DOM 依赖
   源码：src/engine.ts → 编译产物：dist/engine.js（随仓库提交）
   浏览器：<script src="dist/engine.js"></script> → window.Solitaire
   Node：  const Solitaire = require('./engine.js')

   规则（经典 Windows 纸牌）：
   - 7 列牌阵：第 n 列 n 张，仅最上面一张明牌；其余 24 张进牌库
   - 牌阵内红黑交替、点数递减；空列只接 K
   - 收牌区同花色从 A 到 K 依次累积；双击/自动送入
   - 牌库支持「每次翻 1 张 / 3 张」；翻完可由废牌堆整体回收（保持物理翻堆顺序）
   - 任一列移走牌后自动翻开新顶牌
   - 收牌区集齐 52 张即胜利；计时从第一次操作开始、胜利冻结
   - 撤销保存完整快照（含自动翻牌与胜负状态），不限步数但限制内存（最近 200 步） */
(function (root, factory) {
    if (typeof module === 'object' && module.exports)
        module.exports = factory();
    else
        root.Solitaire = factory();
})(typeof self !== 'undefined' ? self : this, function () {
    'use strict';
    const SUITS = ['S', 'H', 'D', 'C'];
    const RANK_LABEL = ['', 'A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];
    const SUIT_LABEL = { S: '黑桃', H: '红桃', D: '方块', C: '梅花' };
    const MAX_SECONDS = 5999;
    const UNDO_LIMIT = 200;
    const isRed = (c) => c.suit === 'H' || c.suit === 'D';
    const rankLabel = (r) => RANK_LABEL[r] ?? '?';
    const suitLabel = (s) => SUIT_LABEL[s] ?? '?';
    const foundationBase = (s) => SUITS.indexOf(s);
    function sameLocation(a, b) {
        if (a.kind !== b.kind)
            return false;
        if (a.kind === 'foundation' && b.kind === 'foundation')
            return a.suit === b.suit;
        if (a.kind === 'tableau' && b.kind === 'tableau')
            return a.index === b.index;
        return true;
    }
    function locationText(loc) {
        switch (loc.kind) {
            case 'stock': return '牌库';
            case 'waste': return '废牌堆';
            case 'foundation': return '收牌区';
            case 'tableau': return '第 ' + (loc.index + 1) + ' 列';
        }
    }
    const defaultClock = typeof performance !== 'undefined' && typeof performance.now === 'function'
        ? () => performance.now()
        : () => Date.now();
    function makeDeck() {
        const deck = [];
        for (const suit of SUITS)
            for (let rank = 1; rank <= 13; rank++)
                deck.push({ suit, rank, faceUp: false });
        return deck;
    }
    const cloneCard = (c) => ({ suit: c.suit, rank: c.rank, faceUp: c.faceUp });
    class SolitaireImpl {
        constructor(rand = Math.random, clock = defaultClock, passCount = 1) {
            this.stock = [];
            this.waste = [];
            this.foundations = { S: [], H: [], D: [], C: [] };
            this.tableau = [];
            this.history = [];
            this._moves = 0;
            this._phase = 'playing';
            this._startedAt = null;
            this._endedAt = null;
            this.rand = rand;
            this.clock = clock;
            this._passCount = SolitaireImpl.normalizePass(passCount);
            this.deal();
        }
        static normalizePass(p) {
            if (p !== 1 && p !== 3)
                throw new Error('抽牌模式非法：' + p);
            return p;
        }
        /** 测试专用：显式牌局构造，便于覆盖边界规则 */
        static planted(spec, clock = defaultClock, passCount = 1) {
            const e = new SolitaireImpl(() => 0.5, clock, passCount);
            const conv = (list) => (list ?? []).map(([suit, rank, faceUp]) => ({ suit, rank, faceUp: faceUp ?? true }));
            e.stock = conv(spec.stock);
            e.waste = conv(spec.waste);
            e.foundations = { S: [], H: [], D: [], C: [] };
            for (const s of SUITS)
                e.foundations[s] = conv(spec.foundations?.[s]);
            e.tableau = (spec.tableau ?? []).map((pile) => conv(pile));
            while (e.tableau.length < 7)
                e.tableau.push([]);
            e.history = [];
            e._moves = 0;
            e._phase = 'playing';
            e._startedAt = null;
            e._endedAt = null;
            return e;
        }
        deal() {
            const deck = makeDeck();
            for (let i = deck.length - 1; i > 0; i--) {
                const j = Math.floor(this.rand() * (i + 1));
                const t = deck[i];
                deck[i] = deck[j];
                deck[j] = t;
            }
            this.stock = [];
            this.waste = [];
            this.history = [];
            this.foundations = { S: [], H: [], D: [], C: [] };
            this.tableau = [];
            for (let col = 0; col < 7; col++) {
                const pile = [];
                for (let row = 0; row <= col; row++) {
                    const c = deck.pop();
                    c.faceUp = row === col;
                    pile.push(c);
                }
                this.tableau.push(pile);
            }
            while (deck.length) {
                const c = deck.pop();
                c.faceUp = false;
                this.stock.push(c);
            }
            this._moves = 0;
            this._phase = 'playing';
            this._startedAt = null;
            this._endedAt = null;
        }
        restart(passCount) {
            if (passCount !== undefined)
                this._passCount = SolitaireImpl.normalizePass(passCount);
            this.deal();
        }
        /* ---- 只读视图 ---- */
        get passCount() { return this._passCount; }
        get phase() { return this._phase; }
        get moves() { return this._moves; }
        get stockCount() { return this.stock.length; }
        get wasteCount() { return this.waste.length; }
        foundationCount(suit) { return this.foundations[suit].length; }
        tableauCount(index) { return this.tableau[index]?.length ?? 0; }
        pile(loc) {
            switch (loc.kind) {
                case 'stock': return this.stock;
                case 'waste': return this.waste;
                case 'foundation': return this.foundations[loc.suit];
                case 'tableau': return this.tableau[loc.index] ?? [];
            }
        }
        cardsAt(loc) {
            if (loc.kind === 'tableau' && !this.tableau[loc.index])
                return [];
            return this.pile(loc).map(cloneCard);
        }
        topCard(loc) {
            const p = this.pile(loc);
            return p.length ? cloneCard(p[p.length - 1]) : null;
        }
        allFaceUp() {
            return this.tableau.every((pile) => pile.every((c) => c.faceUp));
        }
        /* ---- 规则判定 ---- */
        canMove(from, count, to) {
            if (from.kind === 'stock')
                return false;
            if (to.kind === 'stock' || to.kind === 'waste')
                return false;
            if (sameLocation(from, to))
                return false;
            if (!Number.isInteger(count) || count < 1)
                return false;
            const src = this.pile(from);
            if (count > src.length)
                return false;
            const moving = src.slice(src.length - count);
            if (moving.some((c) => !c.faceUp))
                return false;
            if (to.kind === 'foundation') {
                if (count !== 1)
                    return false;
                if (to.suit !== moving[0].suit)
                    return false;
                return moving[0].rank === this.foundations[to.suit].length + 1;
            }
            const dst = this.tableau[to.index];
            if (!dst)
                return false;
            if (dst.length === 0)
                return moving[0].rank === 13;
            const top = dst[dst.length - 1];
            return top.faceUp && top.rank === moving[0].rank + 1 && isRed(top) !== isRed(moving[0]);
        }
        /* ---- 状态变更 ---- */
        touch() {
            if (this._startedAt === null)
                this._startedAt = this.clock();
        }
        snapshot() {
            return {
                stock: this.stock.map(cloneCard),
                waste: this.waste.map(cloneCard),
                foundations: {
                    S: this.foundations.S.map(cloneCard), H: this.foundations.H.map(cloneCard),
                    D: this.foundations.D.map(cloneCard), C: this.foundations.C.map(cloneCard),
                },
                tableau: this.tableau.map((p) => p.map(cloneCard)),
                moves: this._moves, phase: this._phase,
                startedAt: this._startedAt, endedAt: this._endedAt,
            };
        }
        pushHistory() {
            this.history.push(this.snapshot());
            if (this.history.length > UNDO_LIMIT)
                this.history.shift();
        }
        checkWin() {
            const total = SUITS.reduce((n, s) => n + this.foundations[s].length, 0);
            if (total === 52 && this._phase !== 'won') {
                this._phase = 'won';
                this._endedAt = this.clock();
            }
        }
        move(from, count, to) {
            if (this._phase === 'won')
                return { ok: false, reason: '本局已结束' };
            if (!this.canMove(from, count, to)) {
                if (from.kind === 'stock')
                    return { ok: false, reason: '牌库的牌需要先翻开' };
                return { ok: false, reason: '这两叠牌不能这样叠放' };
            }
            this.pushHistory();
            this.touch();
            const src = this.pile(from);
            const moving = src.splice(src.length - count, count);
            if (from.kind === 'tableau') {
                const left = this.tableau[from.index];
                if (left.length && !left[left.length - 1].faceUp)
                    left[left.length - 1].faceUp = true;
            }
            const dst = this.pile(to);
            for (const c of moving) {
                c.faceUp = true;
                dst.push(c);
            }
            this._moves++;
            this.checkWin();
            return { ok: true, reason: '' };
        }
        draw() {
            if (this._phase === 'won')
                return { drawn: 0, recycled: false };
            if (this.stock.length === 0) {
                if (this.waste.length === 0)
                    return { drawn: 0, recycled: false };
                this.pushHistory();
                this.touch();
                // 物理翻堆：整叠掉头后扣回牌库，原废牌堆顶变成新牌库底
                this.stock = this.waste.slice().reverse().map((c) => ({ suit: c.suit, rank: c.rank, faceUp: false }));
                this.waste = [];
                this._moves++;
                return { drawn: 0, recycled: true };
            }
            this.pushHistory();
            this.touch();
            let drawn = 0;
            for (let i = 0; i < this._passCount && this.stock.length; i++) {
                const c = this.stock.pop();
                c.faceUp = true;
                this.waste.push(c);
                drawn++;
            }
            this._moves++;
            return { drawn, recycled: false };
        }
        autoMove(from) {
            if (this._phase === 'won')
                return null;
            const card = this.topCard(from);
            if (!card || !card.faceUp)
                return null;
            const target = { kind: 'foundation', suit: card.suit };
            if (!this.canMove(from, 1, target))
                return null;
            const r = this.move(from, 1, target);
            return r.ok ? card.suit : null;
        }
        undo() {
            const snap = this.history.pop();
            if (!snap)
                return false;
            this.stock = snap.stock;
            this.waste = snap.waste;
            this.foundations = snap.foundations;
            this.tableau = snap.tableau;
            this._moves = snap.moves;
            this._phase = snap.phase;
            this._startedAt = snap.startedAt;
            this._endedAt = snap.endedAt;
            return true;
        }
        /* ---- 提示 ---- */
        hint() {
            if (this._phase === 'won')
                return null;
            const candidates = [];
            const add = (from, count, to, text, score) => {
                if (this.canMove(from, count, to))
                    candidates.push({ from, count, to, text, score });
            };
            const cardText = (c) => suitLabel(c.suit) + rankLabel(c.rank);
            // 收牌区优先：废牌堆 → 牌阵
            const wasteTop = this.topCard({ kind: 'waste' });
            if (wasteTop) {
                add({ kind: 'waste' }, 1, { kind: 'foundation', suit: wasteTop.suit }, '把 ' + cardText(wasteTop) + ' 移到收牌区', 100);
                for (let t = 0; t < 7; t++) {
                    add({ kind: 'waste' }, 1, { kind: 'tableau', index: t }, '把 ' + cardText(wasteTop) + ' 移到第 ' + (t + 1) + ' 列', 60);
                }
            }
            for (let i = 0; i < 7; i++) {
                const pile = this.tableau[i];
                if (!pile.length)
                    continue;
                const top = pile[pile.length - 1];
                if (top.faceUp) {
                    add({ kind: 'tableau', index: i }, 1, { kind: 'foundation', suit: top.suit }, '把 ' + cardText(top) + ' 移到收牌区', 100);
                }
                // 牌阵内部的整段移动：优先「能翻出暗牌」的走法
                for (let start = pile.length - 1; start >= 0; start--) {
                    if (!pile[start].faceUp)
                        break;
                    const count = pile.length - start;
                    const head = pile[start];
                    const reveals = start > 0 && !pile[start - 1].faceUp;
                    for (let t = 0; t < 7; t++) {
                        if (t === i)
                            continue;
                        const dstEmpty = this.tableau[t].length === 0;
                        if (!this.canMove({ kind: 'tableau', index: i }, count, { kind: 'tableau', index: t }))
                            continue;
                        if (dstEmpty && count === pile.length)
                            continue; // 整列平移到空列毫无意义
                        const score = reveals ? 80 : dstEmpty ? 55 : 10;
                        const text = '把 ' + cardText(head) + ' 连同下面 ' + (count - 1) + ' 张移到第 ' + (t + 1) + ' 列';
                        add({ kind: 'tableau', index: i }, count, { kind: 'tableau', index: t }, count > 1 ? text : '把 ' + cardText(head) + ' 移到第 ' + (t + 1) + ' 列', score);
                    }
                }
            }
            if (this.stock.length || this.waste.length) {
                candidates.push({
                    from: { kind: 'stock' }, count: 0, to: { kind: 'stock' },
                    text: this.stock.length ? '翻开牌库里的牌' : '回收废牌堆，重新翻牌',
                    score: this.stock.length ? 20 : 5,
                });
            }
            if (!candidates.length)
                return null;
            candidates.sort((a, b) => b.score - a.score);
            const best = candidates[0];
            return { from: best.from, count: best.count, to: best.to, text: best.text };
        }
        /* ---- 自动完成 ---- */
        canAutoFinish() {
            return this._phase === 'playing' && this.stock.length === 0 && this.waste.length === 0 && this.allFaceUp();
        }
        autoFinishStep() {
            if (this._phase === 'won')
                return false;
            const options = [];
            for (let i = 0; i < 7; i++) {
                const pile = this.tableau[i];
                const top = pile[pile.length - 1];
                if (top && top.faceUp)
                    options.push({ from: { kind: 'tableau', index: i }, card: top });
            }
            const wasteTop = this.waste[this.waste.length - 1];
            if (wasteTop)
                options.push({ from: { kind: 'waste' }, card: wasteTop });
            // 点数小的先送：A→2→3… 每次只送当前最底层可收的牌
            options.sort((a, b) => a.card.rank - b.card.rank);
            for (const opt of options) {
                const target = { kind: 'foundation', suit: opt.card.suit };
                if (this.canMove(opt.from, 1, target)) {
                    this.move(opt.from, 1, target);
                    return true;
                }
            }
            return false;
        }
        /* ---- 计时 ---- */
        elapsed() {
            if (this._startedAt === null)
                return 0;
            const end = this._endedAt ?? this.clock();
            const sec = Math.floor((end - this._startedAt) / 1000);
            return Math.min(MAX_SECONDS, Math.max(0, sec));
        }
    }
    return { Solitaire: SolitaireImpl, SUITS, isRed, rankLabel, suitLabel, sameLocation, foundationBase };
});
