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
   - 撤销记录「反向操作」（含自动翻牌与胜负状态），不限步数但限制内存（最近 200 步） */

/* ---- 领域类型（脚本式全局作用域，ui.ts / test.ts / uitest.ts 共用） ---- */
type Suit = 'S' | 'H' | 'D' | 'C';
type Phase = 'playing' | 'won';
type PassCount = 1 | 3;

interface Card { suit: Suit; rank: number; faceUp: boolean }

type PileRef =
  | { kind: 'stock' }
  | { kind: 'waste' }
  | { kind: 'foundation'; suit: Suit }
  | { kind: 'tableau'; index: number };

interface DrawResult { drawn: number; recycled: boolean }

/** 下一次 draw() 会发生什么（不改变状态）。
    quick 死局判定靠它区分「翻牌真的推进局面」与「只是原地打转」。 */
interface DrawPeek {
  /** 下一次 draw() 会翻出的牌数（回收时按回收后的牌库算） */
  count: number;
  /** 下一次 draw() 是否会触发回收 */
  recycled: boolean;
  /** 回收后下一张会翻出的牌（不回收时为 null） */
  recycleTop: Card | null;
}
interface MoveResult { ok: boolean; reason: string }

interface Hint { from: PileRef; count: number; to: PileRef; text: string }

interface SolitaireInstance {
  readonly passCount: PassCount;
  readonly phase: Phase;
  readonly moves: number;
  readonly stockCount: number;
  readonly wasteCount: number;
  /** 收牌区某花色的牌数（0–13） */
  foundationCount(suit: Suit): number;
  /** 某列的牌数 */
  tableauCount(index: number): number;
  /** 只读牌视图（复制；调用方拿不到内部对象） */
  cardsAt(loc: PileRef): Card[];
  topCard(loc: PileRef): Card | null;
  /** 本次可拖动的牌组是否合法（不改变状态） */
  canMove(from: PileRef, count: number, to: PileRef): boolean;
  /** 执行移动；失败返回 ok:false + 原因（规则不允许 / 无可移动牌） */
  move(from: PileRef, count: number, to: PileRef): MoveResult;
  /** 从牌库翻牌；牌库空时回收废牌堆。drawn=0 且 recycled=false 表示彻底没牌可翻 */
  draw(): DrawResult;
  /** 预览下一次 draw() 的结果，不改变状态 */
  peekDraw(): DrawPeek;
  /** 双击：把单张顶牌送进收牌区；成功返回花色 */
  autoMove(from: PileRef): Suit | null;
  /** 撤销上一步；无历史返回 false */
  undo(): boolean;
  /** 提示：返回一条当前最值得执行的合法走法；无路可走返回 null */
  hint(): Hint | null;
  /** 自动完成是否可用：牌库与废牌堆清空且牌阵全部明牌 */
  canAutoFinish(): boolean;
  /** 自动完成推进一步（每次移动一张到收牌区） */
  autoFinishStep(): boolean;
  /** 重新发牌（保留抽牌模式） */
  restart(passCount?: PassCount): void;
  /** 秒；首次操作前为 0；胜利后冻结 */
  elapsed(): number;
  /** 牌面是否全明（胜利动画 / 自动完成的判断依据） */
  allFaceUp(): boolean;
}

/** 测试与 UI 共用的常量与纯函数 */
interface SolitaireAPI {
  Solitaire: SolitaireCtor;
  SUITS: Suit[];
  isRed(card: Card): boolean;
  rankLabel(rank: number): string;
  suitLabel(suit: Suit): string;
  sameLocation(a: PileRef, b: PileRef): boolean;
  foundationBase(suit: Suit): number;
}

interface SolitaireCtor {
  new (rand?: () => number, clock?: () => number, passCount?: PassCount): SolitaireInstance;
  /** 测试专用：用显式牌局构造（不洗牌） */
  planted(spec: PlantedSpec, clock?: () => number, passCount?: PassCount): SolitaireInstance;
}

interface PlantedSpec {
  stock?: CardSpec[];
  waste?: CardSpec[];
  foundations?: Partial<Record<Suit, CardSpec[]>>;
  tableau?: CardSpec[][];
}

type CardSpec = [Suit, number, boolean?];

(function (root: any, factory: () => SolitaireAPI) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Solitaire = factory();
})(typeof self !== 'undefined' ? self : this, function (): SolitaireAPI {
  'use strict';

  const SUITS: Suit[] = ['S', 'H', 'D', 'C'];
  const RANK_LABEL = ['', 'A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];
  const SUIT_LABEL: Record<Suit, string> = { S: '黑桃', H: '红桃', D: '方块', C: '梅花' };
  const MAX_SECONDS = 5999;
  const UNDO_LIMIT = 200;

  const isRed = (c: Card): boolean => c.suit === 'H' || c.suit === 'D';
  const rankLabel = (r: number): string => RANK_LABEL[r] ?? '?';
  const suitLabel = (s: Suit): string => SUIT_LABEL[s] ?? '?';
  const foundationBase = (s: Suit): number => SUITS.indexOf(s);

  function sameLocation(a: PileRef, b: PileRef): boolean {
    if (a.kind !== b.kind) return false;
    if (a.kind === 'foundation' && b.kind === 'foundation') return a.suit === b.suit;
    if (a.kind === 'tableau' && b.kind === 'tableau') return a.index === b.index;
    return true;
  }

  function locationText(loc: PileRef): string {
    switch (loc.kind) {
      case 'stock': return '牌库';
      case 'waste': return '废牌堆';
      case 'foundation': return '收牌区';
      case 'tableau': return '第 ' + (loc.index + 1) + ' 列';
    }
  }

  const defaultClock: () => number =
    typeof performance !== 'undefined' && typeof performance.now === 'function'
      ? () => performance.now()
      : () => Date.now();

  function makeDeck(): Card[] {
    const deck: Card[] = [];
    for (const suit of SUITS) for (let rank = 1; rank <= 13; rank++) deck.push({ suit, rank, faceUp: false });
    return deck;
  }

  /** 撤销记录里需要回滚的「元状态」：步数、胜负、计时起止点 */
  interface UndoMeta {
    moves: number; phase: Phase;
    startedAt: number | null; endedAt: number | null;
  }

  /** 撤销记录：只存「反向操作」需要的最小信息。
      早期版本每步克隆整盘 52 张牌（200 步 ≈ 一万个对象）；
      这里每条只有几十字节，回滚靠把牌搬回去 + 复原元状态。 */
  type UndoRecord =
    | (UndoMeta & { kind: 'move'; from: PileRef; to: PileRef; count: number; flipped: boolean; faces: boolean[] })
    | (UndoMeta & { kind: 'draw'; drawn: number })
    | (UndoMeta & { kind: 'recycle' });

  const cloneCard = (c: Card): Card => ({ suit: c.suit, rank: c.rank, faceUp: c.faceUp });

  /** PileRef 由调用方持有，存进撤销记录前先复制，避免外部改对象污染历史 */
  function copyLoc(loc: PileRef): PileRef {
    switch (loc.kind) {
      case 'foundation': return { kind: 'foundation', suit: loc.suit };
      case 'tableau': return { kind: 'tableau', index: loc.index };
      default: return { kind: loc.kind };
    }
  }

  class SolitaireImpl implements SolitaireInstance {
    private rand: () => number;
    private clock: () => number;
    private _passCount: PassCount;
    private stock: Card[] = [];
    private waste: Card[] = [];
    private foundations: Record<Suit, Card[]> = { S: [], H: [], D: [], C: [] };
    private tableau: Card[][] = [];
    private history: UndoRecord[] = [];
    private _moves = 0;
    private _phase: Phase = 'playing';
    private _startedAt: number | null = null;
    private _endedAt: number | null = null;

    constructor(rand: () => number = Math.random, clock: () => number = defaultClock, passCount: PassCount = 1) {
      this.rand = rand;
      this.clock = clock;
      this._passCount = SolitaireImpl.normalizePass(passCount);
      this.deal();
    }

    private static normalizePass(p: number): PassCount {
      if (p !== 1 && p !== 3) throw new Error('抽牌模式非法：' + p);
      return p;
    }

    /** 测试专用：显式牌局构造，便于覆盖边界规则 */
    static planted(spec: PlantedSpec, clock: () => number = defaultClock, passCount: PassCount = 1): SolitaireInstance {
      const e = new SolitaireImpl(() => 0.5, clock, passCount);
      const conv = (list: CardSpec[] | undefined): Card[] =>
        (list ?? []).map(([suit, rank, faceUp]) => ({ suit, rank, faceUp: faceUp ?? true }));
      e.stock = conv(spec.stock);
      e.waste = conv(spec.waste);
      e.foundations = { S: [], H: [], D: [], C: [] };
      for (const s of SUITS) e.foundations[s] = conv(spec.foundations?.[s]);
      e.tableau = (spec.tableau ?? []).map((pile) => conv(pile));
      while (e.tableau.length < 7) e.tableau.push([]);
      e.history = [];
      e._moves = 0;
      e._phase = 'playing';
      e._startedAt = null;
      e._endedAt = null;
      return e;
    }

    private deal(): void {
      const deck = makeDeck();
      for (let i = deck.length - 1; i > 0; i--) {
        const j = Math.floor(this.rand() * (i + 1));
        const t = deck[i]; deck[i] = deck[j]; deck[j] = t;
      }
      this.stock = []; this.waste = []; this.history = [];
      this.foundations = { S: [], H: [], D: [], C: [] };
      this.tableau = [];
      for (let col = 0; col < 7; col++) {
        const pile: Card[] = [];
        for (let row = 0; row <= col; row++) {
          const c = deck.pop() as Card;
          c.faceUp = row === col;
          pile.push(c);
        }
        this.tableau.push(pile);
      }
      while (deck.length) {
        const c = deck.pop() as Card;
        c.faceUp = false;
        this.stock.push(c);
      }
      this._moves = 0;
      this._phase = 'playing';
      this._startedAt = null;
      this._endedAt = null;
    }

    restart(passCount?: PassCount): void {
      if (passCount !== undefined) this._passCount = SolitaireImpl.normalizePass(passCount);
      this.deal();
    }

    /* ---- 只读视图 ---- */

    get passCount(): PassCount { return this._passCount; }
    get phase(): Phase { return this._phase; }
    get moves(): number { return this._moves; }
    get stockCount(): number { return this.stock.length; }
    get wasteCount(): number { return this.waste.length; }

    foundationCount(suit: Suit): number { return this.foundations[suit].length; }
    tableauCount(index: number): number { return this.tableau[index]?.length ?? 0; }

    private pile(loc: PileRef): Card[] {
      switch (loc.kind) {
        case 'stock': return this.stock;
        case 'waste': return this.waste;
        case 'foundation': return this.foundations[loc.suit];
        case 'tableau': return this.tableau[loc.index] ?? [];
      }
    }

    cardsAt(loc: PileRef): Card[] {
      if (loc.kind === 'tableau' && !this.tableau[loc.index]) return [];
      return this.pile(loc).map(cloneCard);
    }

    topCard(loc: PileRef): Card | null {
      const p = this.pile(loc);
      return p.length ? cloneCard(p[p.length - 1]) : null;
    }

    allFaceUp(): boolean {
      return this.tableau.every((pile) => pile.every((c) => c.faceUp));
    }

    /* ---- 规则判定 ---- */

    canMove(from: PileRef, count: number, to: PileRef): boolean {
      if (from.kind === 'stock') return false;
      if (to.kind === 'stock' || to.kind === 'waste') return false;
      if (sameLocation(from, to)) return false;
      if (!Number.isInteger(count) || count < 1) return false;
      // 只有牌阵允许整组移动；废牌堆与收牌区都只能操作顶牌。
      if (from.kind !== 'tableau' && count !== 1) return false;
      const src = this.pile(from);
      if (count > src.length) return false;
      const moving = src.slice(src.length - count);
      if (moving.some((c) => !c.faceUp)) return false;
      // 全为明牌还不够：整组自身也必须满足红黑交替、点数递减。
      for (let i = 1; i < moving.length; i++) {
        const upper = moving[i - 1], lower = moving[i];
        if (upper.rank !== lower.rank + 1 || isRed(upper) === isRed(lower)) return false;
      }
      if (to.kind === 'foundation') {
        if (count !== 1) return false;
        if (to.suit !== moving[0].suit) return false;
        return moving[0].rank === this.foundations[to.suit].length + 1;
      }
      const dst = this.tableau[to.index];
      if (!dst) return false;
      if (dst.length === 0) return moving[0].rank === 13;
      const top = dst[dst.length - 1];
      return top.faceUp && top.rank === moving[0].rank + 1 && isRed(top) !== isRed(moving[0]);
    }

    /* ---- 状态变更 ---- */

    private touch(): void {
      if (this._startedAt === null) this._startedAt = this.clock();
    }

    /** 变更前抓一份元状态，撤销时原样回滚 */
    private meta(): UndoMeta {
      return { moves: this._moves, phase: this._phase, startedAt: this._startedAt, endedAt: this._endedAt };
    }

    private remember(rec: UndoRecord): void {
      this.history.push(rec);
      if (this.history.length > UNDO_LIMIT) this.history.shift();
    }

    private checkWin(): void {
      const total = SUITS.reduce((n, s) => n + this.foundations[s].length, 0);
      if (total === 52 && this._phase !== 'won') {
        const now = this.clock();
        // 首次操作即获胜时也必须建立计时起点，否则 endedAt 会被 elapsed 忽略。
        if (this._startedAt === null) this._startedAt = now;
        this._phase = 'won';
        this._endedAt = now;
      }
    }

    move(from: PileRef, count: number, to: PileRef): MoveResult {
      if (this._phase === 'won') return { ok: false, reason: '本局已结束' };
      if (!this.canMove(from, count, to)) {
        if (from.kind === 'stock') return { ok: false, reason: '牌库的牌需要先翻开' };
        return { ok: false, reason: '这两叠牌不能这样叠放' };
      }
      const meta = this.meta();          // 必须在 touch() 之前抓，撤销才能把计时起点也退回去
      this.touch();
      const src = this.pile(from);
      const moving = src.splice(src.length - count, count);
      const faces = moving.map((c) => c.faceUp);   // 撤销时要原样恢复朝向
      let flipped = false;
      if (from.kind === 'tableau') {
        const left = this.tableau[from.index];
        if (left.length && !left[left.length - 1].faceUp) { left[left.length - 1].faceUp = true; flipped = true; }
      }
      const dst = this.pile(to);
      for (const c of moving) { c.faceUp = true; dst.push(c); }
      this._moves++;
      this.checkWin();
      this.remember({ kind: 'move', from: copyLoc(from), to: copyLoc(to), count, flipped, faces, ...meta });
      return { ok: true, reason: '' };
    }

    draw(): DrawResult {
      if (this._phase === 'won') return { drawn: 0, recycled: false };
      if (this.stock.length === 0) {
        if (this.waste.length === 0) return { drawn: 0, recycled: false };
        const meta = this.meta();
        this.touch();
        // 物理翻堆：整叠掉头后扣回牌库，原废牌堆顶变成新牌库底
        this.stock = this.waste.slice().reverse().map((c) => ({ suit: c.suit, rank: c.rank, faceUp: false }));
        this.waste = [];
        this._moves++;
        this.remember({ kind: 'recycle', ...meta });
        return { drawn: 0, recycled: true };
      }
      const meta = this.meta();
      this.touch();
      let drawn = 0;
      for (let i = 0; i < this._passCount && this.stock.length; i++) {
        const c = this.stock.pop() as Card;
        c.faceUp = true;
        this.waste.push(c);
        drawn++;
      }
      this._moves++;
      this.remember({ kind: 'draw', drawn, ...meta });
      return { drawn, recycled: false };
    }

    /** 下一次 draw() 的纯预览：回收会整叠掉头，所以「回收后第一张」是废牌堆底 */
    peekDraw(): DrawPeek {
      if (this.stock.length === 0) {
        if (this.waste.length === 0) return { count: 0, recycled: false, recycleTop: null };
        const first = this.waste[0];   // 回收后它变成新牌库顶，也是回收后第一张被翻出的牌
        return {
          count: Math.min(this._passCount, this.waste.length),
          recycled: true,
          recycleTop: first ? cloneCard(first) : null,
        };
      }
      return { count: Math.min(this._passCount, this.stock.length), recycled: false, recycleTop: null };
    }

    autoMove(from: PileRef): Suit | null {
      if (this._phase === 'won') return null;
      const card = this.topCard(from);
      if (!card || !card.faceUp) return null;
      const target: PileRef = { kind: 'foundation', suit: card.suit };
      if (!this.canMove(from, 1, target)) return null;
      const r = this.move(from, 1, target);
      return r.ok ? card.suit : null;
    }

    undo(): boolean {
      const rec = this.history.pop();
      if (!rec) return false;
      if (rec.kind === 'move') {
        // 把牌从目标搬回源位置（牌对象本身不变，身份与顺序都能精确复原）
        const dst = this.pile(rec.to);
        const moving = dst.splice(dst.length - rec.count, rec.count);
        const src = this.pile(rec.from);
        for (let i = 0; i < moving.length; i++) {
          moving[i].faceUp = rec.faces[i] ?? true;   // 恢复移动前的朝向
          src.push(moving[i]);
        }
        // 自动翻开的那张牌要重新盖回（必须在 push 之前定位，否则会误伤刚搬回来的牌）
        if (rec.flipped && rec.from.kind === 'tableau') {
          const left = this.tableau[rec.from.index];
          const idx = left.length - rec.count - 1;
          if (idx >= 0) left[idx].faceUp = false;
        }
      } else if (rec.kind === 'draw') {
        for (let i = 0; i < rec.drawn; i++) {
          const c = this.waste.pop() as Card;
          c.faceUp = false;
          this.stock.push(c);
        }
      } else {
        // 回收的反向：牌库（= 掉头后的废牌堆）整叠翻回废牌堆
        const back = this.stock.splice(0).reverse();
        for (const c of back) { c.faceUp = true; this.waste.push(c); }
      }
      this._moves = rec.moves;
      this._phase = rec.phase;
      this._startedAt = rec.startedAt;
      this._endedAt = rec.endedAt;
      return true;
    }

    /* ---- 提示 ---- */

    hint(): Hint | null {
      if (this._phase === 'won') return null;
      const candidates: Array<Hint & { score: number }> = [];
      const add = (from: PileRef, count: number, to: PileRef, text: string, score: number): void => {
        if (this.canMove(from, count, to)) candidates.push({ from, count, to, text, score });
      };
      const cardText = (c: Card): string => suitLabel(c.suit) + rankLabel(c.rank);

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
        if (!pile.length) continue;
        const top = pile[pile.length - 1];
        if (top.faceUp) {
          add({ kind: 'tableau', index: i }, 1, { kind: 'foundation', suit: top.suit }, '把 ' + cardText(top) + ' 移到收牌区', 100);
        }
        // 牌阵内部的整段移动：优先「能翻出暗牌」的走法
        for (let start = pile.length - 1; start >= 0; start--) {
          if (!pile[start].faceUp) break;
          const count = pile.length - start;
          const head = pile[start];
          const reveals = start > 0 && !pile[start - 1].faceUp;
          for (let t = 0; t < 7; t++) {
            if (t === i) continue;
            const dstEmpty = this.tableau[t].length === 0;
            if (!this.canMove({ kind: 'tableau', index: i }, count, { kind: 'tableau', index: t })) continue;
            if (dstEmpty && count === pile.length) continue;   // 整列平移到空列毫无意义
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
      if (!candidates.length) return null;
      candidates.sort((a, b) => b.score - a.score);
      const best = candidates[0];
      return { from: best.from, count: best.count, to: best.to, text: best.text };
    }

    /* ---- 自动完成 ---- */

    /** 能否自动完成：牌库与废牌堆清空、全明，**且真的能把剩下的牌逐张收完**。
        早期版本只看表面条件（空库 + 全明），导致「真死局」里按钮也是亮的、
        点下去却什么都发生不了。现在用与 autoFinishStep 同一套贪心试跑一遗。 */
    canAutoFinish(): boolean {
      if (this._phase !== 'playing') return false;
      if (this.stock.length !== 0 || this.waste.length !== 0 || !this.allFaceUp()) return false;
      return this.sweepCompletes();
    }

    /** 在副本上试跑一遍贪心收牌，看能不能把剩下的牌逐张收完。
        与 autoFinishStep 使用同一优先级（点数小的先送），保证：
        canAutoFinish() 为 true ⟹ autoFinish 一定跑得完。
        注意：收走顶牌后要露出列里的下一张，所以必须维护真实牌叠。 */
    private sweepCompletes(): boolean {
      const found: Record<Suit, number> = { S: 0, H: 0, D: 0, C: 0 };
      for (const s of SUITS) found[s] = this.foundations[s].length;
      const cols: Card[][] = this.tableau.map((p) => p.slice());
      const waste: Card[] = this.waste.slice();
      let remaining = SUITS.reduce((n, s) => n + (13 - found[s]), 0);
      let guard = 0;
      while (remaining > 0 && guard++ < 60) {
        const opts: Array<{ card: Card; take: () => void }> = [];
        for (let i = 0; i < 7; i++) {
          const c = cols[i][cols[i].length - 1];
          if (c) opts.push({ card: c, take: () => { cols[i].pop(); } });
        }
        const wt = waste[waste.length - 1];
        if (wt) opts.push({ card: wt, take: () => { waste.pop(); } });
        opts.sort((a, b) => a.card.rank - b.card.rank);
        let moved = false;
        for (const opt of opts) {
          const s = opt.card.suit;
          if (opt.card.rank === found[s] + 1) {
            found[s]++;
            remaining--;
            opt.take();
            moved = true;
            break;
          }
        }
        if (!moved) return false;   // 卡在半路：自动完不成
      }
      return remaining === 0;
    }

    autoFinishStep(): boolean {
      if (this._phase === 'won') return false;
      const options: Array<{ from: PileRef; card: Card }> = [];
      for (let i = 0; i < 7; i++) {
        const pile = this.tableau[i];
        const top = pile[pile.length - 1];
        if (top && top.faceUp) options.push({ from: { kind: 'tableau', index: i }, card: top });
      }
      const wasteTop = this.waste[this.waste.length - 1];
      if (wasteTop) options.push({ from: { kind: 'waste' }, card: wasteTop });
      // 点数小的先送：A→2→3… 每次只送当前最底层可收的牌
      options.sort((a, b) => a.card.rank - b.card.rank);
      for (const opt of options) {
        const target: PileRef = { kind: 'foundation', suit: opt.card.suit };
        if (this.canMove(opt.from, 1, target)) {
          this.move(opt.from, 1, target);
          return true;
        }
      }
      return false;
    }

    /* ---- 计时 ---- */

    elapsed(): number {
      if (this._startedAt === null) return 0;
      const end = this._endedAt ?? this.clock();
      const sec = Math.floor((end - this._startedAt) / 1000);
      return Math.min(MAX_SECONDS, Math.max(0, sec));
    }
  }

  return { Solitaire: SolitaireImpl, SUITS, isRed, rankLabel, suitLabel, sameLocation, foundationBase };
});
