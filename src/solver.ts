/* 接龙求解器（纯逻辑，零 DOM 依赖）
   源码：src/solver.ts → 编译产物：dist/solver.js（随仓库提交）
   浏览器：<script src="dist/solver.js"></script> → window.SolitaireSolver
   Node：  const SolitaireSolver = require('./solver.js')

   职责两件事：
   1. 判定局面是「还能赢」/「已死局」/「搜不出来」
   2. 死局时给出**人话原因**（哪张牌被埋住、谁卡住了谁、收牌卡在哪一步）

   实现说明：
   - 状态用紧凑数组表示，走法生成独立于 engine（便于剪枝与转移表）
   - 正确性靠与 engine 的走法及完整后继状态对拍保证（见 test.ts 的第 14 段）
   - 搜索是带转移表的 DFS，设节点/时间上限，超限返回 unknown 而不是瞎猜
   - 判定「死局」有两种确定性来源：
       a) 没有任何合法移动（含翻牌）→ 一定是死局
       b) 可达状态空间被完整搜索完毕仍无解 → 也是死局
     其余情况一律 unknown，绝不谎报 */

/* ---- 状态表示 ----
   卡牌编号 0..51 = 花色序号 * 13 + (点数 - 1)；花色序号沿用 engine 的 SUITS 顺序 */

interface SState {
  /** [底 ... 顶]，末尾是下一张要翻的 */
  stock: number[];
  /** [底 ... 顶]，末尾是废牌堆顶 */
  waste: number[];
  /** 四个花色已收张数，按 SUITS 顺序 */
  found: number[];
  /** 7 列牌阵，每列 [底 ... 顶] */
  tab: number[][];
  /** 与 tab 同构的明牌标记 */
  up: boolean[][];
}

type SMove =
  | { kind: 'draw' }
  | { kind: 'w2f' }
  | { kind: 'w2t'; to: number }
  | { kind: 't2f'; from: number }
  | { kind: 't2t'; from: number; count: number; to: number; reveals: boolean }
  | { kind: 'f2t'; suit: Suit; to: number };

type Verdict = 'win' | 'dead' | 'unknown';

interface SolverOpts {
  /** 搜索节点上限，超限返回 unknown */
  nodeLimit?: number;
  /** 时间上限（毫秒），超限返回 unknown */
  timeLimit?: number;
  /** 只判断「还有没有得走」，不做搜索 */
  quick?: boolean;
  /** 本轮提示已经走过的状态，推荐时避免回到这些状态；不影响完整搜索判定 */
  avoidSuggestionStates?: Set<string>;
}

/** 有限前瞻给出的可执行建议：即使无法证明输赢，也能告诉玩家「下一步先走哪里」。 */
interface SolverSuggestion {
  move: SMove;
  text: string;
  reason: string;
  score: number;
  /** 若有限前瞻真的走通了一整局，这里会带完整路线；路线可验证，因此可升级为 win。 */
  winningPath?: SMove[];
}

interface SolverReport {
  verdict: Verdict;
  /** 人话解释：为什么会这样 */
  reasons: string[];
  /** 搜索到的节点数（便于观测求解难度） */
  nodes: number;
  elapsedMs: number;
  /** 若可胜，给出一条能赢的路线；至少包含第一步 */
  winningLine?: SMove[];
  /** 当前局面最值得先尝试的一步；死局时为空 */
  suggestion?: SolverSuggestion;
  /** quick 判定：还有合法走法，但只剩可逆/无净收益移动 */
  stalled?: boolean;
  /** unknown 时触发的搜索上限：node=节点数，time=时间 */
  limit?: 'node' | 'time';
}

/** 从引擎只读视图构建求解状态所需的最小接口。
    注意：cardsAt 必须返回完整牌堆（包括牌阵/牌库里的暗牌）以及每张牌的 faceUp 标记；
    求解器需要暗牌的完整顺序才能对“这一局实际发牌”做精确的赢/死局搜索。
    如果传入只含明牌的视图，搜索会退化成看不到未来翻牌的近似，不能保证结论。 */
interface EngineView {
  readonly passCount: PassCount;
  readonly phase: Phase;
  cardsAt(loc: PileRef): Card[];
  /** 可选：提供后 quick 判定能精确区分「回收出新牌」与「原地打转」 */
  peekDraw?(): DrawPeek;
}

(function (root: any, factory: () => any) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.SolitaireSolver = factory();
})(typeof self !== 'undefined' ? self : this, function (): any {
  'use strict';

  const SUIT_ORDER: Suit[] = ['S', 'H', 'D', 'C'];
  const SUIT_NAME: Record<Suit, string> = { S: '黑桃', H: '红桃', D: '方块', C: '梅花' };
  const RANK_NAME = ['', 'A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];
  const COLOR_NAME = (s: Suit): string => (s === 'H' || s === 'D' ? '红色' : '黑色');

  const suitOf = (i: number): Suit => SUIT_ORDER[Math.floor(i / 13)];
  /** 花色在 found[] 数组里的下标（found 是 number[]，不能用 Suit 字符串直接索引） */
  const suitIdx = (i: number): number => SUIT_ORDER.indexOf(suitOf(i));
  const rankOf = (i: number): number => (i % 13) + 1;
  const isRedIdx = (i: number): boolean => {
    const s = suitOf(i);
    return s === 'H' || s === 'D';
  };
  const cardText = (i: number): string => SUIT_NAME[suitOf(i)] + RANK_NAME[rankOf(i)];
  const cardIndex = (suit: Suit, rank: number): number => SUIT_ORDER.indexOf(suit) * 13 + (rank - 1);

  /* ============================ 走法生成 ============================ */

  /** 能否把 head 这张牌放到第 col 列顶部 */
  function canPlace(st: SState, head: number, col: number): boolean {
    const target = st.tab[col];
    if (!target.length) return rankOf(head) === 13;
    const last = target.length - 1;
    if (!st.up[col][last]) return false;
    const top = target[last];
    return rankOf(top) === rankOf(head) + 1 && isRedIdx(top) !== isRedIdx(head);
  }

  /** 还有没有没翻开的暗牌（诊断与剪枝用） */
  function hasHidden(st: SState): boolean {
    for (let i = 0; i < 7; i++) for (let j = 0; j < st.up[i].length; j++) if (!st.up[i][j]) return true;
    return false;
  }


  /** 生成全部合法走法（不含「回收废牌堆」之外的无效循环） */
  function moves(st: SState, pass: PassCount): SMove[] {    const out: SMove[] = [];
    const wasteTop = st.waste.length ? st.waste[st.waste.length - 1] : -1;

    // 收牌区走法优先（引擎允许从收牌区移回牌阵，所以送进收牌区不会锁死）
    if (wasteTop >= 0 && st.found[suitIdx(wasteTop)] === rankOf(wasteTop) - 1) out.push({ kind: 'w2f' });

    for (let i = 0; i < 7; i++) {
      const col = st.tab[i];
      if (!col.length) continue;
      const top = col[col.length - 1];
      if (st.up[i][col.length - 1] && st.found[suitIdx(top)] === rankOf(top) - 1) out.push({ kind: 't2f', from: i });
    }

    // 牌阵内部移动：优先「能翻开暗牌」的
    for (let i = 0; i < 7; i++) {
      const col = st.tab[i];
      // 找出尾部明牌段的起点
      let start = col.length - 1;
      while (start >= 0 && st.up[i][start]) start--;
      start++;
      for (let k = start; k < col.length; k++) {
        const head = col[k];
        const count = col.length - k;
        const reveals = k > 0 && !st.up[i][k - 1];
        for (let j = 0; j < 7; j++) {
          if (j === i) continue;
          if (!canPlace(st, head, j)) continue;
          out.push({ kind: 't2t', from: i, count, to: j, reveals });
        }
      }
    }

    if (wasteTop >= 0) {
      for (let j = 0; j < 7; j++) if (canPlace(st, wasteTop, j)) out.push({ kind: 'w2t', to: j });
    }

    // 收牌区的牌可以移回牌阵（这是引擎允许的自救手段）。
    // 早先只在「还有暗牌没翻开」时生成，因为全明后 f2t 只是原地打转、会产生组合爆炸。
    // 但那个剪枝让求解器与引擎的走法集合不一致（引擎总是允许 f2t），
    // 全明局面也可能真需要把牌拉回来重排。现在总是生成，靠下面两点控规模：
    //   1) 转移表（keyOf 含完整牌面）把重复局面直接剪掉
    //   2) 只考虑「拉回来能压到列顶」的牌（canPlace 已经保证）
    // 若真出现爆炸，nodeLimit / timeLimit 会返回 unknown 而不是乱猜。
    for (let s = 0; s < 4; s++) {
      if (st.found[s] === 0) continue;
      const card = cardIndex(SUIT_ORDER[s], st.found[s]);
      for (let j = 0; j < 7; j++) if (canPlace(st, card, j)) out.push({ kind: 'f2t', suit: SUIT_ORDER[s], to: j });
    }

    if (st.stock.length > 0 || st.waste.length > 0) out.push({ kind: 'draw' });
    return out;
  }

  /** 还有没有「结构上能推进局面」的走法：翻牌算（牌库还有牌），单纯回收不算 */
  function hasAnyMove(st: SState, pass: PassCount): boolean {
    for (const m of moves(st, pass)) {
      if (m.kind === 'draw') {
        if (st.stock.length > 0) return true;   // 还有没翻过的牌
        continue;                                // 只剩回收 = 原地打转
      }
      return true;
    }
    return false;
  }

  /** 回收后的完整一轮里，是否会出现「有净进展」的走法。
      不能只看回收后的第一张：第一张不能走时，玩家仍可继续翻后面的牌；
      draw-3 也不能一律忽略，因为当前废牌堆可能来自已经抽走过牌的上一轮，
      回收后某一组的顶牌同样可能变成可行动的牌。
      注意不能把 f2t（从收牌区拉回）或整列搬到空列这类可逆/无收益 t2t 当成解锁，
      否则 quick 会把只剩倒牌的局误报成「还能推进」。 */
  function recycleUnlocks(st: SState, pass: PassCount): boolean {
    if (st.stock.length !== 0 || st.waste.length <= 1) return false;
    let cur = applyMove(st, { kind: 'draw' }, pass);   // 引擎语义：先只回收，不顺便翻牌
    const drawCount = Math.ceil(st.waste.length / pass);
    for (let i = 0; i < drawCount; i++) {
      cur = applyMove(cur, { kind: 'draw' }, pass);
      if (moves(cur, pass).some((mv) => mv.kind !== 'draw' && isProductiveMove(cur, mv, pass))) return true;
    }
    return false;
  }

  function cloneState(st: SState): SState {
    return {
      stock: st.stock.slice(),
      waste: st.waste.slice(),
      found: st.found.slice(),
      tab: st.tab.map((c) => c.slice()),
      up: st.up.map((c) => c.slice()),
    };
  }

  function applyMove(st: SState, mv: SMove, pass: PassCount): SState {
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
          const c = s.stock.pop() as number;
          s.waste.push(c);
        }
        break;
      }
      case 'w2f': {
        const c = s.waste.pop() as number;
        s.found[suitIdx(c)]++;
        break;
      }
      case 'w2t': {
        const c = s.waste.pop() as number;
        s.tab[mv.to].push(c);
        s.up[mv.to].push(true);
        break;
      }
      case 't2f': {
        const card = s.tab[mv.from].pop() as number;
        s.up[mv.from].pop();
        // 与 engine.move() 一致：收走顶牌后，源列露出的暗牌要立即翻开。
        if (s.up[mv.from].length) s.up[mv.from][s.up[mv.from].length - 1] = true;
        s.found[suitIdx(card)]++;
        break;
      }
      case 't2t': {
        const from = s.tab[mv.from];
        const upFrom = s.up[mv.from];
        const moving = from.splice(from.length - mv.count, mv.count);
        upFrom.splice(upFrom.length - mv.count, mv.count);
        if (upFrom.length) upFrom[upFrom.length - 1] = true;   // 移走后翻开新顶牌
        for (const c of moving) { s.tab[mv.to].push(c); s.up[mv.to].push(true); }
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

  function isWin(st: SState): boolean {
    return st.found[0] + st.found[1] + st.found[2] + st.found[3] === 52;
  }

  function keyOf(st: SState): string {
    // 牌阵的 7 列在规则上完全等价，列号只是界面位置。
    // 按列内容排序后编码，可把「同一局面换到别的空列/别的列」归一化，
    // 显著减少 visited 里的对称状态；这不会改变胜负，因为走法可以随列置换一一对应。
    const columns: string[] = [];
    for (let i = 0; i < 7; i++) {
      let mask = 0;
      for (let j = 0; j < st.up[i].length; j++) if (st.up[i][j]) mask |= 1 << j;
      columns.push(st.tab[i].join('-') + '/' + mask);
    }
    columns.sort();
    return st.found.join(',') + '|' + columns.join('|')
      + '#' + st.stock.join('-') + '#' + st.waste.join('-');
  }

  /** 走法排序：先收牌、再翻暗牌、再普通移动，最后才翻牌（让 DFS 更快撞到胜利） */
  function orderMoves(list: SMove[], st: SState): SMove[] {
    const score = (m: SMove): number => {
      switch (m.kind) {
        case 't2f': case 'w2f': return 100;
        case 't2t': return m.reveals ? 80 : 40;
        case 'w2t': return 60;
        case 'f2t': return 20;
        case 'draw': return st.stock.length ? 10 : 5;
      }
    };
    return list.slice().sort((a, b) => score(b) - score(a));
  }

  interface Ctx {
    pass: PassCount;
    nodes: number;
    nodeLimit: number;
    deadline: number;
  }

  /** 把一条走法翻译成人话（UI 展示「第一步该怎么走」用） */
  function describeMove(st: SState, mv: SMove): string {
    const wasteTop = (): number => st.waste[st.waste.length - 1];
    switch (mv.kind) {
      case 'draw':
        return st.stock.length ? '翻开牌库' : '回收废牌堆重新翻牌';
      case 'w2f':
        return '把废牌堆的 ' + cardText(wasteTop()) + ' 送进收牌区';
      case 'w2t':
        return '把废牌堆的 ' + cardText(wasteTop()) + ' 移到第 ' + (mv.to + 1) + ' 列';
      case 't2f':
        return '把第 ' + (mv.from + 1) + ' 列顶部的 ' + cardText(st.tab[mv.from][st.tab[mv.from].length - 1]) + ' 送进收牌区';
      case 't2t': {
        const head = st.tab[mv.from][st.tab[mv.from].length - mv.count];
        return mv.count > 1
          ? '把第 ' + (mv.from + 1) + ' 列的 ' + cardText(head) + ' 连同下面 ' + (mv.count - 1) + ' 张移到第 ' + (mv.to + 1) + ' 列'
          : '把第 ' + (mv.from + 1) + ' 列的 ' + cardText(head) + ' 移到第 ' + (mv.to + 1) + ' 列';
      }
      case 'f2t':
        return '把收牌区的 ' + cardText(cardIndex(mv.suit, st.found[SUIT_ORDER.indexOf(mv.suit)])) + ' 拉回第 ' + (mv.to + 1) + ' 列';
    }
  }

    /** 局面评估：收牌 > 翻开暗牌 > 空列 > 可立即收牌/机动性。
      搜索证明不了输赢时，至少用这个分数选出「最像进展」的下一步。 */
  function evaluateState(st: SState): number {
    const found = st.found[0] + st.found[1] + st.found[2] + st.found[3];
    let hidden = 0;
    let faceUp = 0;
    let emptyColumns = 0;
    let foundationReady = 0;
    let mobility = 0;
    for (let i = 0; i < 7; i++) {
      const pile = st.tab[i];
      if (!pile.length) { emptyColumns++; continue; }
      for (let k = 0; k < pile.length; k++) {
        if (st.up[i][k]) faceUp++;
        else hidden++;
      }
      const top = pile[pile.length - 1];
      if (st.up[i][pile.length - 1]) {
        if (st.found[suitIdx(top)] === rankOf(top) - 1) foundationReady++;
        for (let j = 0; j < 7; j++) if (j !== i && canPlace(st, top, j)) mobility++;
      }
    }
    const wasteTop = st.waste.length ? st.waste[st.waste.length - 1] : -1;
    if (wasteTop >= 0 && st.found[suitIdx(wasteTop)] === rankOf(wasteTop) - 1) foundationReady++;
    return found * 1000 - hidden * 90 + faceUp * 7 + emptyColumns * 110
      + foundationReady * 40 + Math.min(20, mobility) * 2;
  }

  /** 推荐时过滤掉「整列搬到另一个空列」这种没有信息增益的循环走法。 */
  function usefulMoves(st: SState, pass: PassCount): SMove[] {
    return moves(st, pass).filter((mv) => {
      if (mv.kind !== 't2t') return true;
      return !(mv.count === st.tab[mv.from].length && st.tab[mv.to].length === 0);
    });
  }

  /** 这一步是否带来可见净进展；只用于「建议」过滤，不用于完整正确性判定。
      可逆的 t2t 换位如果不翻开暗牌、不腾空列、也没有让新顶牌变得可收/可接，
      就是典型的「左移右移」循环来源，不应作为提示。 */
  function isProductiveMove(st: SState, mv: SMove, pass: PassCount): boolean {
    switch (mv.kind) {
      case 'w2f':
      case 't2f':
        return true;
      case 'w2t':
        return true;                 // 废牌堆的牌进入了牌阵，不会原路返回废牌堆
      case 'draw':
        return st.stock.length > 0 || recycleUnlocks(st, pass);
      case 'f2t':
        return false;                // 先不主动建议从收牌区拉回
      case 't2t': {
        const pile = st.tab[mv.from];
        if (mv.reveals) return true;
        if (mv.count === pile.length) return st.tab[mv.to].length > 0; // 腾出空列
        const exposedIndex = pile.length - mv.count - 1;
        const exposed = pile[exposedIndex];
        if (!st.up[mv.from][exposedIndex]) return true;
        if (st.found[suitIdx(exposed)] === rankOf(exposed) - 1) return true;
        for (let j = 0; j < 7; j++) {
          if (j !== mv.from && canPlace(st, exposed, j)) return true;
        }
        return false;
      }
    }
  }

  /** 是否至少有一条「能带来净进展」的合法走法。 */
  function hasProductiveMove(st: SState, pass: PassCount): boolean {
    return moves(st, pass).some((mv) => isProductiveMove(st, mv, pass));
  }
  function suggestionReason(st: SState, mv: SMove): string {
    switch (mv.kind) {
      case 't2f':
      case 'w2f':
        return '直接推进收牌区';
      case 't2t':
        if (mv.reveals) return '能翻开暗牌';
        if (mv.count === st.tab[mv.from].length) return '能腾出空列';
        return '为后续接牌或翻牌做准备';
      case 'w2t':
        return '把废牌堆的牌接回牌阵';
      case 'f2t':
        return '必要时从收牌区取回一张牌来解局';
      case 'draw':
        return st.stock.length ? '现有牌阵没有更直接的推进，先探查牌库' : '牌库已空，回收废牌堆重新探查';
    }
  }

  interface RecommendOpts {
    /** 已访问过的状态；避免提示在同样的局面之间循环 */
    avoid?: Set<string>;
    /** 最多向前看几层；不是完整搜索，成本受 nodeLimit 限制 */
    depth?: number;
    /** 每层保留的最有希望状态数 */
    width?: number;
    /** 最多展开多少个后继状态 */
    nodeLimit?: number;
  }

  interface RecommendCandidate {
    st: SState;
    first: SMove;
    path: SMove[];
    score: number;
  }

  /** 有限前瞻推荐：不追求证明，只保证给玩家一个合法、目前看起来最有进展的第一步。
      若前瞻中真的走完整局，则返回可验证的 winningPath（按它走确实能收满 52 张）。 */
  function recommend(st: SState, pass: PassCount, opts: RecommendOpts = {}): SolverSuggestion | null {
    const depth = Math.max(1, opts.depth ?? 4);
    const width = Math.max(1, opts.width ?? 40);
    const nodeLimit = Math.max(1, opts.nodeLimit ?? 4000);
    const rootMoves = usefulMoves(st, pass).filter((mv) => isProductiveMove(st, mv, pass));
    if (!rootMoves.length) return null;

    let layer: RecommendCandidate[] = [];
    let nodes = 0;
    const seen = new Set<string>([keyOf(st), ...(opts.avoid ?? [])]);

    for (const mv of rootMoves) {
      if (nodes++ >= nodeLimit) break;
      const next = applyMove(st, mv, pass);
      const path = [mv];
      const score = evaluateState(next);
      if (isWin(next)) {
        return { move: mv, text: describeMove(st, mv), reason: '这一步之后已经收满 52 张', score, winningPath: path };
      }
      const key = keyOf(next);
      if (seen.has(key)) continue;
      seen.add(key);
      layer.push({ st: next, first: mv, path, score });
    }

    layer.sort((a, b) => b.score - a.score);
    if (!layer.length) return null;
    if (layer.length > width) layer = layer.slice(0, width);
    let best = layer[0];

    for (let d = 1; d < depth && layer.length && nodes < nodeLimit; d++) {
      const nextLayer: RecommendCandidate[] = [];
      for (const cur of layer) {
        for (const mv of usefulMoves(cur.st, pass)) {
          if (nodes++ >= nodeLimit) break;
          const next = applyMove(cur.st, mv, pass);
          const path = cur.path.concat([mv]);
          const score = evaluateState(next);
          if (isWin(next)) {
            return { move: cur.first, text: describeMove(st, cur.first), reason: '有限前瞻中找到一条完整胜利路线', score, winningPath: path };
          }
          const key = keyOf(next);
          if (seen.has(key)) continue;
          seen.add(key);
          nextLayer.push({ st: next, first: cur.first, path, score });
        }
        if (nodes >= nodeLimit) break;
      }
      if (!nextLayer.length) break;
      nextLayer.sort((a, b) => b.score - a.score);
      layer = nextLayer.slice(0, width);
      if (layer[0].score > best.score) best = layer[0];
    }

    return best
      ? { move: best.first, text: describeMove(st, best.first), reason: suggestionReason(st, best.first), score: best.score }
      : null;
  }

  /** 玩家可见状态编码：暗牌只保留“有几张、在什么位置”，不包含暗牌点数/花色。 */
  function visibleKeyOf(st: SState): string {
    const columns: string[] = [];
    for (let i = 0; i < 7; i++) {
      const pile = st.tab[i];
      let hidden = 0;
      while (hidden < pile.length && !st.up[i][hidden]) hidden++;
      // 正常规则下暗牌一定在底部连续；若遇到异常状态，用 -1 占位避免把暗牌当明牌。
      const visible = pile.slice(hidden).map((c, k) => st.up[i][hidden + k] ? c : -1).join('-');
      columns.push(hidden + ':' + visible);
    }
    columns.sort();
    return st.found.join(',') + '|' + columns.join('|')
      + '#' + st.stock.length + '#' + st.waste.join('-');
  }

  /** 玩家视角下这一步的可见价值；不读暗牌点数，不做深层搜索。 */
  function visibleMoveScore(st: SState, mv: SMove): number | null {
    switch (mv.kind) {
      case 'w2f':
      case 't2f':
        return 100;
      case 'w2t':
        return 60;
      case 't2t':
        if (mv.count === st.tab[mv.from].length && st.tab[mv.to].length === 0) return null;
        if (mv.reveals) return 80;
        return st.tab[mv.to].length === 0 ? 55 : 10;
      case 'f2t':
        return null;              // 玩家通常不会仅凭可见信息主动从收牌区拉牌
      case 'draw':
        return st.stock.length ? 20 : (st.waste.length > 1 ? 5 : null);
    }
  }

  function visibleReason(st: SState, mv: SMove): string {
    switch (mv.kind) {
      case 'w2f':
      case 't2f':
        return '直接推进收牌区';
      case 'w2t':
        return '把废牌堆的牌接回牌阵';
      case 't2t':
        if (mv.reveals) return '能翻开一张暗牌';
        return st.tab[mv.to].length === 0 ? '能腾出空列' : '整理牌阵，为后续接牌做准备';
      case 'draw':
        return st.stock.length ? '先翻牌看看' : '回收废牌堆重新翻牌';
      case 'f2t':
        return '从收牌区取回一张牌';
    }
  }

  /** 只依赖可见信息的“净进展”判断；draw 不使用会读暗牌顺序的 recycleUnlocks。 */
  function visibleProductive(st: SState, mv: SMove, pass: PassCount): boolean {
    if (mv.kind === 'draw') return st.stock.length > 0 || st.waste.length > 1;
    return isProductiveMove(st, mv, pass);
  }

  /** 玩家视角提示：只用当前可见信息挑一步，不偷看暗牌、不做深层模拟。
      它保证合法、可执行，但只是“建议”，不是 win/dead 证明。 */
  function recommendVisible(st: SState, pass: PassCount, opts: { avoid?: Set<string> } = {}): SolverSuggestion | null {
    const seen = new Set<string>([visibleKeyOf(st), ...(opts.avoid ?? [])]);
    let best: { move: SMove; score: number } | null = null;
    for (const mv of usefulMoves(st, pass)) {
      if (!visibleProductive(st, mv, pass)) continue;
      const score = visibleMoveScore(st, mv);
      if (score === null) continue;
      const next = applyMove(st, mv, pass);
      if (seen.has(visibleKeyOf(next))) continue;
      if (!best || score > best.score) best = { move: mv, score };
    }
    if (!best) return null;
    return {
      move: best.move,
      text: describeMove(st, best.move),
      reason: visibleReason(st, best.move),
      score: best.score,
    };
  }

  type SearchLimit = 'node' | 'time';
  type SearchResult =
    | { verdict: 'win'; line: SMove[] }
    | { verdict: 'dead'; line?: undefined }
    | { verdict: 'unknown'; line?: undefined; limit: SearchLimit };

  /** 当前是否触到搜索预算；返回触到的那一项。 */
  function limitOf(ctx: Ctx): SearchLimit | null {
    if (ctx.nodes >= ctx.nodeLimit) return 'node';
    if (Date.now() > ctx.deadline) return 'time';
    return null;
  }

  /** 带全局 visited 的可达性搜索（显式栈迭代版）。
      单机单人、确定性游戏：状态图有限，每个状态只需展开一次；
      因此遍历完整个可达状态图仍无解就返回 dead，超出节点/时间预算才返回 unknown。
      以前这里用递归 DFS 并加了 `depth > 600` 的硬上限：第一条路径一深就提前放弃，
      初始牌局常常只有 601 个节点、十几毫秒就返回 unknown，预算完全没用上。
      现在改成显式栈，不再限制路径深度，只由 nodeLimit/timeLimit 控制。 */
  function searchReachable(root: SState, ctx: Ctx): SearchResult {
    const visited = new Set<string>();
    const path: SMove[] = [];

    if (isWin(root)) return { verdict: 'win', line: [] };
    const rootLimit = limitOf(ctx);
    if (rootLimit) return { verdict: 'unknown', limit: rootLimit };

    ctx.nodes++;
    visited.add(keyOf(root));

    interface Frame {
      st: SState;
      moves: SMove[];
      next: number;
    }
    const stack: Frame[] = [{
      st: root,
      moves: orderMoves(moves(root, ctx.pass), root),
      next: 0,
    }];

    while (stack.length) {
      const frame = stack[stack.length - 1];
      if (frame.next >= frame.moves.length) {
        stack.pop();
        if (stack.length) path.pop();   // pop the move that led into this frame
        continue;
      }

      const mv = frame.moves[frame.next++];
      const next = applyMove(frame.st, mv, ctx.pass);
      const nextKey = keyOf(next);
      if (visited.has(nextKey)) continue;

      if (isWin(next)) {
        path.push(mv);
        return { verdict: 'win', line: path.slice() };
      }

      const hit = limitOf(ctx);
      if (hit) return { verdict: 'unknown', limit: hit };

      visited.add(nextKey);
      ctx.nodes++;
      path.push(mv);
      stack.push({
        st: next,
        moves: orderMoves(moves(next, ctx.pass), next),
        next: 0,
      });
    }

    return { verdict: 'dead' };
  }
  /* ============================ 死局原因诊断 ============================ */

  /** 某张牌目前有没有任何去处（牌阵或收牌区） */
  function canGoAnywhere(st: SState, card: number): boolean {
    if (st.found[suitIdx(card)] === rankOf(card) - 1) return true;
    for (let j = 0; j < 7; j++) if (canPlace(st, card, j)) return true;
    return false;
  }

  /** 把第 col 列第 hiddenIdx 张暗牌上方的牌移走后，能否翻开它。
      条件必须是：上方所有牌都是明牌（暗牌不能移动），且其中至少有一张现在有去处。
      原实现没有检查 `st.up`，会把上方暗牌当成可移动牌，导致真正的埋牌被漏报。 */
  function canExposeColumn(st: SState, col: number, hiddenIdx: number): boolean {
    const pile = st.tab[col];
    for (let k = hiddenIdx + 1; k < pile.length; k++) {
      if (!st.up[col][k]) return false;   // 上面还有暗牌，本身就不可能移走
      const head = pile[k];
      if (st.found[suitIdx(head)] === rankOf(head) - 1) return true;
      for (let j = 0; j < 7; j++) {
        if (j === col) continue;
        if (canPlace(st, head, j)) return true;
      }
    }
    return false;
  }

  function diagnose(st: SState, pass: PassCount, uncertain = false): string[] {
    const reasons: string[] = [];
    const alive = hasAnyMove(st, pass);

    if (!alive) {
      if (st.stock.length === 0 && st.waste.length === 0) {
        reasons.push('牌库与废牌堆已经翻完，仍然没有任何合法移动。');
      } else {
        reasons.push('没有任何能推进局面的走法：翻牌只会让牌原地打转，剩下的牌也都动不了。');
      }
    }

    // 1) 被压住的暗牌：每列只看最上面那张暗牌（它才是下一步能翻开的牌）
    let buriedCount = 0;
    for (let i = 0; i < 7 && buriedCount < 2; i++) {
      const pile = st.tab[i];
      let hiddenIdx = -1;
      for (let k = pile.length - 1; k >= 0; k--) {
        if (!st.up[i][k]) { hiddenIdx = k; break; }
      }
      if (hiddenIdx < 0) continue;
      if (!canExposeColumn(st, i, hiddenIdx)) {
        reasons.push(SUIT_NAME[suitOf(pile[hiddenIdx])] + RANK_NAME[rankOf(pile[hiddenIdx])]
          + '被压在第 ' + (i + 1) + ' 列，上面的牌当前无处可去，暂时翻不开。');
        buriedCount++;
      }
    }

    // 2) 被卡住的明牌，以及它到底在等谁
    const blocked: number[] = [];
    for (let i = 0; i < 7; i++) {
      const pile = st.tab[i];
      const top = pile.length ? pile[pile.length - 1] : -1;
      if (top >= 0 && st.up[i][pile.length - 1] && !canGoAnywhere(st, top)) blocked.push(top);
    }
    const wasteTop = st.waste.length ? st.waste[st.waste.length - 1] : -1;
    if (wasteTop >= 0 && !canGoAnywhere(st, wasteTop)) blocked.push(wasteTop);

    for (const b of blocked.slice(0, 2)) {
      const r = rankOf(b);
      if (r === 13) {
        reasons.push(cardText(b) + (uncertain ? '暂时无处可去：' : '无处可去：') + '只有空列才接 K，而牌阵现在腾不出空列。');
      } else {
        const opp = r + 1;
        // 红牌只能压在黑牌上，黑牌只能压在红牌上
        const need = isRedIdx(b)
          ? SUIT_NAME.S + RANK_NAME[opp] + ' 或 ' + SUIT_NAME.C + RANK_NAME[opp]
          : SUIT_NAME.H + RANK_NAME[opp] + ' 或 ' + SUIT_NAME.D + RANK_NAME[opp];
        reasons.push(cardText(b) + (uncertain ? '暂时无处可去：' : '无处可去：') + '它只能压在' + need + '上，而这两张当前都不在可动的顶牌位置。');
      }
    }

    // 3) 收牌区断链
    for (let s = 0; s < 4 && reasons.length < 6; s++) {
      const next = st.found[s] + 1;
      if (next > 13) continue;
      const card = cardIndex(SUIT_ORDER[s], next);
      const visible = (() => {
        for (let i = 0; i < 7; i++) {
          const pile = st.tab[i];
          const top = pile.length ? pile[pile.length - 1] : -1;
          if (top === card) return true;
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
        // 没有空列时，K 唯一能走的方向是同花色的收牌区（该花色已收到 Q）。
        // 只有真能走掉才会腾出新空列；仅仅“顶上是 K”并不等于可动。
        if (top >= 0 && rankOf(top) === 13 && st.up[i][pile.length - 1]
          && st.found[suitIdx(top)] === 12) movableK = true;
      }
      if (!movableK) reasons.push('牌阵里没有空列，也没有可动的 K 能开新列，周转空间不足。');
    }

    if (!reasons.length) {
      reasons.push(uncertain
        ? '暂时看不出结构性卡点，继续尝试翻牌或调整牌阵。'
        : alive
          ? '暂时看不出结构性死因，可能还需要翻几张牌才能确定。'
          : '局面已经动弹不得。');
    }
    return reasons;
  }

  /* ============================ 对外接口 ============================ */

  /** 从引擎只读视图构建求解状态 */
  function fromEngine(e: EngineView): SState {
    const toIdx = (c: Card): number => cardIndex(c.suit, c.rank);
    const stock = e.cardsAt({ kind: 'stock' }).map(toIdx);          // [底 ... 顶]
    const waste = e.cardsAt({ kind: 'waste' }).map(toIdx);
    const found = SUIT_ORDER.map((s) => e.cardsAt({ kind: 'foundation', suit: s }).length);
    const tab: number[][] = [];
    const up: boolean[][] = [];
    for (let i = 0; i < 7; i++) {
      const pile = e.cardsAt({ kind: 'tableau', index: i });
      tab.push(pile.map(toIdx));
      up.push(pile.map((c) => c.faceUp));
    }
    return { stock, waste, found, tab, up };
  }
  function analyze(st: SState, pass: PassCount, opts: SolverOpts = {}): SolverReport {
    const t0 = Date.now();
    const report = (
      verdict: Verdict,
      nodes: number,
      reasons: string[],
      line?: SMove[],
      suggestion?: SolverSuggestion,
      stalled?: boolean,
      limit?: 'node' | 'time',
    ): SolverReport => ({
      verdict, reasons, nodes, elapsedMs: Date.now() - t0, winningLine: line, suggestion, stalled, limit,
    });

    if (opts.quick) {
      // quick 只判断「现在是否还有净进展」，不做完整证明。
      // 可逆的 t2t 来回移动虽然合法，但不应让它误以为牌局还能继续推进。
      const recyclable = recycleUnlocks(st, pass);
      const alive = hasAnyMove(st, pass) || recyclable;
      if (!alive) return report('dead', 0, diagnose(st, pass));
      const productive = hasProductiveMove(st, pass) || recyclable;
      if (!productive) {
        return report('unknown', 0, [
          '当前只剩可逆或没有净收益的合法移动，继续左右倒牌不会带来进展。',
          ...diagnose(st, pass, true).slice(0, 2),
        ], undefined, undefined, true);
      }
      return report('unknown', 0, ['还有能推进局面的合法走法。']);
    }

    const ctx: Ctx = {
      pass,
      nodes: 0,
      nodeLimit: opts.nodeLimit ?? 40000,
      deadline: t0 + (opts.timeLimit ?? 400),
    };
    const searched = searchReachable(st, ctx);
    let verdict = searched.verdict;
    let line = searched.line;
    const limit = searched.verdict === 'unknown' ? searched.limit : undefined;

    // 完整搜索证明不了输赢时，不直接甩一句「太复杂」：用有限前瞻给出当前最值得尝试的一步。
    // 若前瞻真的走完整局，则那条路线本身就是构造性证明，可以放心升级为 win。
    const suggestion: SolverSuggestion | null = verdict === 'unknown'
      ? recommend(st, pass, { depth: 6, width: 60, nodeLimit: 12000, avoid: opts.avoidSuggestionStates })
      : null;
    if (verdict === 'unknown' && suggestion?.winningPath?.length) {
      verdict = 'win';
      line = suggestion.winningPath;
    }

    let reasons: string[];
    if (verdict === 'dead') {
      reasons = diagnose(st, pass);
    } else if (verdict === 'win') {
      reasons = ['求解器已找到一条完整胜利路线。'];
    } else {
      const limitText = limit === 'node' ? '节点上限' : limit === 'time' ? '时间上限' : '搜索上限';
      reasons = ['完整搜索在' + limitText + '内没有结束，因此不谎报输赢。'];
      reasons.push(...diagnose(st, pass, true).slice(0, 3));
      if (suggestion) {
        reasons.push('下面是有限前瞻给出的可执行建议；它有帮助，但不代表已经证明必胜。');
      } else {
        reasons.push('当前没有找到有明显净进展的建议；可能只剩可逆移动或需要撤销几步重试。');
      }
    }

    if (line && line.length) {
      reasons.push('必胜第一步：' + describeMove(st, line[0]));
    } else if (suggestion) {
      reasons.push('建议先走：' + suggestion.text + '（' + suggestion.reason + '）');
    }

    const actionable = line && line.length
      ? {
          move: line[0],
          text: describeMove(st, line[0]),
          reason: '求解器已证明存在完整胜利路线',
          score: Number.MAX_SAFE_INTEGER,
          winningPath: line,
        }
      : suggestion;
    return report(verdict, ctx.nodes, reasons, line, actionable ?? undefined, undefined, limit);
  }
  return {
    analyze,
    recommend,
    recommendVisible,
    diagnose,
    fromEngine,
    hasAnyMove,
    moves,
    applyMove,
    canPlace,
    describeMove,
    stateKey: keyOf,
    visibleStateKey: visibleKeyOf,
    cardIndex,
    suitOf,
    rankOf,
    cardText,
    SUIT_ORDER,
  };
});
