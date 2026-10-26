"use strict";
/* 接龙求解器（纯逻辑，零 DOM 依赖）
   源码：src/solver.ts → 编译产物：dist/solver.js（随仓库提交）
   浏览器：<script src="dist/solver.js"></script> → window.SolitaireSolver
   Node：  const SolitaireSolver = require('./solver.js')

   职责两件事：
   1. 判定局面是「还能赢」/「已死局」/「搜不出来」
   2. 死局时给出**人话原因**（哪张牌被埋住、谁卡住了谁、收牌卡在哪一步）

   实现说明：
   - 状态用紧凑数组表示，走法生成独立于 engine（便于剪枝与转移表）
   - 正确性靠与 engine 的对拍测试保证（见 test.ts 的「求解器与引擎规则一致」段）
   - 搜索是带转移表的 DFS，设节点/时间上限，超限返回 unknown 而不是瞎猜
   - 判定「死局」有两种确定性来源：
       a) 没有任何合法移动（含翻牌）→ 一定是死局
       b) 可达状态空间被完整搜索完毕仍无解 → 也是死局
     其余情况一律 unknown，绝不谎报 */
(function (root, factory) {
    if (typeof module === 'object' && module.exports)
        module.exports = factory();
    else
        root.SolitaireSolver = factory();
})(typeof self !== 'undefined' ? self : this, function () {
    'use strict';
    const SUIT_ORDER = ['S', 'H', 'D', 'C'];
    const SUIT_NAME = { S: '黑桃', H: '红桃', D: '方块', C: '梅花' };
    const RANK_NAME = ['', 'A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];
    const COLOR_NAME = (s) => (s === 'H' || s === 'D' ? '红色' : '黑色');
    const suitOf = (i) => SUIT_ORDER[Math.floor(i / 13)];
    /** 花色在 found[] 数组里的下标（found 是 number[]，不能用 Suit 字符串直接索引） */
    const suitIdx = (i) => SUIT_ORDER.indexOf(suitOf(i));
    const rankOf = (i) => (i % 13) + 1;
    const isRedIdx = (i) => {
        const s = suitOf(i);
        return s === 'H' || s === 'D';
    };
    const cardText = (i) => SUIT_NAME[suitOf(i)] + RANK_NAME[rankOf(i)];
    const cardIndex = (suit, rank) => SUIT_ORDER.indexOf(suit) * 13 + (rank - 1);
    /* ============================ 走法生成 ============================ */
    /** 能否把 head 这张牌放到第 col 列顶部 */
    function canPlace(st, head, col) {
        const target = st.tab[col];
        if (!target.length)
            return rankOf(head) === 13;
        const last = target.length - 1;
        if (!st.up[col][last])
            return false;
        const top = target[last];
        return rankOf(top) === rankOf(head) + 1 && isRedIdx(top) !== isRedIdx(head);
    }
    /** 还有没有没翻开的暗牌（决定是否需要重排类走法） */
    function hasHidden(st) {
        for (let i = 0; i < 7; i++)
            for (let j = 0; j < st.up[i].length; j++)
                if (!st.up[i][j])
                    return true;
        return false;
    }
    /** 生成全部合法走法（不含「回收废牌堆」之外的无效循环） */
    function moves(st, pass) {
        const out = [];
        const wasteTop = st.waste.length ? st.waste[st.waste.length - 1] : -1;
        // 收牌区走法优先（引擎允许从收牌区移回牌阵，所以送进收牌区不会锁死）
        if (wasteTop >= 0 && st.found[suitIdx(wasteTop)] === rankOf(wasteTop) - 1)
            out.push({ kind: 'w2f' });
        for (let i = 0; i < 7; i++) {
            const col = st.tab[i];
            if (!col.length)
                continue;
            const top = col[col.length - 1];
            if (st.up[i][col.length - 1] && st.found[suitIdx(top)] === rankOf(top) - 1)
                out.push({ kind: 't2f', from: i });
        }
        // 牌阵内部移动：优先「能翻开暗牌」的
        for (let i = 0; i < 7; i++) {
            const col = st.tab[i];
            // 找出尾部明牌段的起点
            let start = col.length - 1;
            while (start >= 0 && st.up[i][start])
                start--;
            start++;
            for (let k = start; k < col.length; k++) {
                const head = col[k];
                const count = col.length - k;
                const reveals = k > 0 && !st.up[i][k - 1];
                for (let j = 0; j < 7; j++) {
                    if (j === i)
                        continue;
                    if (!canPlace(st, head, j))
                        continue;
                    out.push({ kind: 't2t', from: i, count, to: j, reveals });
                }
            }
        }
        if (wasteTop >= 0) {
            for (let j = 0; j < 7; j++)
                if (canPlace(st, wasteTop, j))
                    out.push({ kind: 'w2t', to: j });
        }
        // 收牌区的牌可以移回牌阵（这是引擎允许的自救手段）。
        // 但只在「还有暗牌没翻开」时才生成：全明之后把牌从收牌区移回来只是原地打转，
        // 会产生组合爆炸（验证过：一个 4 张牌的局面能撑到 4 万节点）。
        // 暗牌存在时才可能真的需要重排来解锁，这时才允许。
        if (hasHidden(st)) {
            for (let s = 0; s < 4; s++) {
                if (st.found[s] === 0)
                    continue;
                const card = cardIndex(SUIT_ORDER[s], st.found[s]);
                for (let j = 0; j < 7; j++)
                    if (canPlace(st, card, j))
                        out.push({ kind: 'f2t', suit: SUIT_ORDER[s], to: j });
            }
        }
        if (st.stock.length > 0 || st.waste.length > 0)
            out.push({ kind: 'draw' });
        return out;
    }
    /** 有没有「能推进局面」的走法：翻牌算（能出新牌），单纯回收不算 */
    function hasAnyMove(st, pass) {
        for (const m of moves(st, pass)) {
            if (m.kind === 'draw') {
                if (st.stock.length > 0)
                    return true; // 还有没翻过的牌
                continue; // 只剩回收 = 原地打转
            }
            return true;
        }
        return false;
    }
    function cloneState(st) {
        return {
            stock: st.stock.slice(),
            waste: st.waste.slice(),
            found: st.found.slice(),
            tab: st.tab.map((c) => c.slice()),
            up: st.up.map((c) => c.slice()),
        };
    }
    function applyMove(st, mv, pass) {
        const s = cloneState(st);
        switch (mv.kind) {
            case 'draw': {
                if (s.stock.length === 0) {
                    // 整叠掉头扣回牌库：原废牌堆顶变成新牌库底
                    s.stock = s.waste.slice().reverse().map((c) => c);
                    s.waste = [];
                    break;
                }
                for (let i = 0; i < pass && s.stock.length; i++) {
                    const c = s.stock.pop();
                    s.waste.push(c);
                }
                break;
            }
            case 'w2f': {
                const c = s.waste.pop();
                s.found[suitIdx(c)]++;
                break;
            }
            case 'w2t': {
                const c = s.waste.pop();
                s.tab[mv.to].push(c);
                s.up[mv.to].push(true);
                break;
            }
            case 't2f': {
                const card = s.tab[mv.from].pop();
                s.up[mv.from].pop();
                s.found[suitIdx(card)]++;
                break;
            }
            case 't2t': {
                const from = s.tab[mv.from];
                const upFrom = s.up[mv.from];
                const moving = from.splice(from.length - mv.count, mv.count);
                upFrom.splice(upFrom.length - mv.count, mv.count);
                if (upFrom.length)
                    upFrom[upFrom.length - 1] = true; // 移走后翻开新顶牌
                for (const c of moving) {
                    s.tab[mv.to].push(c);
                    s.up[mv.to].push(true);
                }
                break;
            }
            case 'f2t': {
                const si = SUIT_ORDER.indexOf(mv.suit);
                const card = cardIndex(mv.suit, s.found[si]);
                s.found[si]--;
                s.tab[mv.to].push(card);
                s.up[mv.to].push(true);
                break;
            }
        }
        return s;
    }
    /* ============================ 搜索 ============================ */
    function isWin(st) {
        return st.found[0] + st.found[1] + st.found[2] + st.found[3] === 52;
    }
    function keyOf(st) {
        let k = st.found.join(',');
        for (let i = 0; i < 7; i++) {
            let mask = 0;
            for (let j = 0; j < st.up[i].length; j++)
                if (st.up[i][j])
                    mask |= 1 << j;
            k += '|' + st.tab[i].join('-') + '/' + mask;
        }
        return k + '#' + st.stock.join('-') + '#' + st.waste.join('-');
    }
    /** 走法排序：先收牌、再翻暗牌、再普通移动，最后才翻牌（让 DFS 更快撞到胜利） */
    function orderMoves(list, st) {
        const score = (m) => {
            switch (m.kind) {
                case 't2f':
                case 'w2f': return 100;
                case 't2t': return m.reveals ? 80 : 40;
                case 'w2t': return 60;
                case 'f2t': return 20;
                case 'draw': return st.stock.length ? 10 : 5;
            }
        };
        return list.slice().sort((a, b) => score(b) - score(a));
    }
    function dfs(st, depth, ctx) {
        if (isWin(st))
            return 'win';
        if (ctx.nodes++ >= ctx.nodeLimit || depth > 200 || Date.now() > ctx.deadline) {
            ctx.overflow = true;
            return 'unknown';
        }
        const key = keyOf(st);
        const seen = ctx.memo.get(key);
        if (seen)
            return seen;
        const list = moves(st, ctx.pass);
        if (!list.length) {
            ctx.memo.set(key, 'dead');
            return 'dead';
        }
        let sawDead = false;
        let sawUnknown = false;
        for (const m of orderMoves(list, st)) {
            const r = dfs(applyMove(st, m, ctx.pass), depth + 1, ctx);
            if (r === 'win') {
                ctx.memo.set(key, 'win');
                return 'win';
            }
            if (r === 'dead')
                sawDead = true;
            else
                sawUnknown = true;
        }
        // 只有「所有后继都被证明是死局」才能断定死局；有 unknown 就不能下结论
        if (sawUnknown)
            return 'unknown';
        if (sawDead) {
            ctx.memo.set(key, 'dead');
            return 'dead';
        }
        return 'unknown';
    }
    /* ============================ 死局原因诊断 ============================ */
    /** 某张牌目前有没有任何去处（牌阵或收牌区） */
    function canGoAnywhere(st, card) {
        if (st.found[suitIdx(card)] === rankOf(card) - 1)
            return true;
        for (let j = 0; j < 7; j++)
            if (canPlace(st, card, j))
                return true;
        return false;
    }
    /** 把第 col 列第 fromIdx 之后的牌移走后，能否翻开它下面那张暗牌 */
    function canExposeColumn(st, col, hiddenIdx) {
        const pile = st.tab[col];
        for (let k = hiddenIdx + 1; k < pile.length; k++) {
            const head = pile[k];
            const count = pile.length - k;
            if (st.found[suitIdx(head)] === rankOf(head) - 1)
                return true;
            for (let j = 0; j < 7; j++) {
                if (j === col)
                    continue;
                if (canPlace(st, head, j))
                    return true;
            }
        }
        return false;
    }
    function diagnose(st, pass) {
        const reasons = [];
        const alive = hasAnyMove(st, pass);
        if (!alive) {
            if (st.stock.length === 0 && st.waste.length === 0) {
                reasons.push('牌库与废牌堆已经翻完，仍然没有任何合法移动。');
            }
            else {
                reasons.push('没有任何能推进局面的走法：翻牌只会让牌原地打转，剩下的牌也都动不了。');
            }
        }
        // 1) 被永久埋住的暗牌
        let buriedCount = 0;
        for (let i = 0; i < 7 && buriedCount < 3; i++) {
            const pile = st.tab[i];
            for (let k = 0; k < pile.length; k++) {
                if (st.up[i][k])
                    continue;
                if (!canExposeColumn(st, i, k)) {
                    reasons.push(SUIT_NAME[suitOf(pile[k])] + RANK_NAME[rankOf(pile[k])]
                        + '被压在第 ' + (i + 1) + ' 列的暗牌下面，而它上面的牌无处可去，这张牌永远翻不开。');
                    buriedCount++;
                    break;
                }
                break; // 只看每列最上面那张暗牌
            }
        }
        // 2) 被卡住的明牌，以及它到底在等谁
        const blocked = [];
        for (let i = 0; i < 7; i++) {
            const pile = st.tab[i];
            const top = pile.length ? pile[pile.length - 1] : -1;
            if (top >= 0 && st.up[i][pile.length - 1] && !canGoAnywhere(st, top))
                blocked.push(top);
        }
        const wasteTop = st.waste.length ? st.waste[st.waste.length - 1] : -1;
        if (wasteTop >= 0 && !canGoAnywhere(st, wasteTop))
            blocked.push(wasteTop);
        for (const b of blocked.slice(0, 3)) {
            const r = rankOf(b);
            if (r === 13) {
                reasons.push(cardText(b) + '无处可去：只有空列才接 K，而牌阵现在腾不出空列。');
            }
            else {
                const opp = r + 1;
                // 红牌只能压在黑牌上，黑牌只能压在红牌上
                const need = isRedIdx(b)
                    ? SUIT_NAME.S + RANK_NAME[opp] + ' 或 ' + SUIT_NAME.C + RANK_NAME[opp]
                    : SUIT_NAME.H + RANK_NAME[opp] + ' 或 ' + SUIT_NAME.D + RANK_NAME[opp];
                reasons.push(cardText(b) + '无处可去：它只能压在' + need + '上，而这两张都不在可动的顶牌位置。');
            }
        }
        // 3) 收牌区断链
        for (let s = 0; s < 4 && reasons.length < 6; s++) {
            const next = st.found[s] + 1;
            if (next > 13)
                continue;
            const card = cardIndex(SUIT_ORDER[s], next);
            const visible = (() => {
                for (let i = 0; i < 7; i++) {
                    const pile = st.tab[i];
                    const top = pile.length ? pile[pile.length - 1] : -1;
                    if (top === card)
                        return true;
                }
                return st.waste[st.waste.length - 1] === card;
            })();
            if (!visible) {
                const where = st.found[s] === 0 ? '尚未开始（还需要 ' + SUIT_NAME[SUIT_ORDER[s]] + 'A）'
                    : '停在 ' + RANK_NAME[st.found[s]] + '（还需要 ' + cardText(card) + '）';
                reasons.push(SUIT_NAME[SUIT_ORDER[s]] + '收牌' + where
                    + '，但这张牌此刻不在任何一张可动的顶牌上。');
            }
        }
        // 4) 腾不出空列
        const hasEmpty = st.tab.some((c) => c.length === 0);
        if (!hasEmpty) {
            let movableK = false;
            for (let i = 0; i < 7; i++) {
                const pile = st.tab[i];
                const top = pile.length ? pile[pile.length - 1] : -1;
                if (top >= 0 && rankOf(top) === 13 && st.up[i][pile.length - 1])
                    movableK = true;
            }
            if (!movableK)
                reasons.push('牌阵里没有空列，也没有可动的 K 能开新列，周转空间不足。');
        }
        if (!reasons.length) {
            reasons.push(alive
                ? '暂时看不出结构性死因，可能还需要翻几张牌才能确定。'
                : '局面已经动弹不得。');
        }
        return reasons;
    }
    /* ============================ 对外接口 ============================ */
    /** 从引擎只读视图构建求解状态 */
    function fromEngine(e) {
        const toIdx = (c) => cardIndex(c.suit, c.rank);
        const stock = e.cardsAt({ kind: 'stock' }).map(toIdx); // [底 ... 顶]
        const waste = e.cardsAt({ kind: 'waste' }).map(toIdx);
        const found = SUIT_ORDER.map((s) => e.cardsAt({ kind: 'foundation', suit: s }).length);
        const tab = [];
        const up = [];
        for (let i = 0; i < 7; i++) {
            const pile = e.cardsAt({ kind: 'tableau', index: i });
            tab.push(pile.map(toIdx));
            up.push(pile.map((c) => c.faceUp));
        }
        return { stock, waste, found, tab, up };
    }
    function analyze(st, pass, opts = {}) {
        const t0 = Date.now();
        const report = (verdict, nodes, reasons, line) => ({
            verdict, reasons, nodes, elapsedMs: Date.now() - t0, winningLine: line,
        });
        if (opts.quick) {
            const alive = hasAnyMove(st, pass);
            return report(alive ? 'unknown' : 'dead', 0, alive
                ? ['还有合法走法，暂时没被将死。']
                : diagnose(st, pass));
        }
        const ctx = {
            pass,
            memo: new Map(),
            nodes: 0,
            nodeLimit: opts.nodeLimit ?? 40000,
            deadline: t0 + (opts.timeLimit ?? 400),
            overflow: false,
        };
        const verdict = dfs(st, 0, ctx);
        const reasons = verdict === 'dead'
            ? diagnose(st, pass)
            : verdict === 'win'
                ? ['这局还有解，按提示走就能赢。']
                : ['局面太复杂，在限定时间内没搜出结论（不代表赢不了，也不代表一定输）。'];
        return report(verdict, ctx.nodes, reasons);
    }
    return {
        analyze,
        diagnose,
        fromEngine,
        hasAnyMove,
        moves,
        applyMove,
        canPlace,
        cardIndex,
        suitOf,
        rankOf,
        cardText,
        SUIT_ORDER,
    };
});
