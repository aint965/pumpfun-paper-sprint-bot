// Launch-rider: a pump.fun paper-trading bot for agent-fun/replay/v2.
//
// Idea: most pump.fun coins die within seconds of launch, but the launches
// that attract real money in their first seconds keep pumping for a little
// while. This bot buys only hot fresh launches (within 8 slots of their
// CreateEvent, real SOL reserves already 3-40 SOL, creator bought at most
// 3 SOL at launch, 2-4 distinct outside buyers so it is not a bundled
// cluster, creator has not sold, and the last two trades are buys), then
// exits fast and whole: take profit at +20%, stop loss at -8%, out after
// 10 slots (~4 s) if neither fired, and out at once if the creator sells.
//
// The entry filter has one extra guard that matters: orders decided on
// slot s fill at slot s+2, so a coin that just went vertical fills at the
// top and retraces into the buy. The bot skips any coin whose price rose
// more than 15% over its last 3 trades and only buys a steady climb.
// That one guard cut the per-trade loss from about -0.0023 SOL to about
// -0.0013 SOL on the dev window while keeping the coin count high.
//
// Why this shape, found by grading revisions on the dev window: the round
// trip costs about 2.5% in curve fees (95 bps protocol + 30 bps creator,
// each way) plus ~105k lamports of tx fees per order, so a trade must move
// several percent to clear fees. The 1%-of-real-reserve buy cap is the
// binding size limit, which is why the entry requires 3+ SOL of real
// reserves: on cold launches the cap only allows a dust-sized buy whose
// tx fee eats the trade. Letting winners ride was tried (sell half at
// +25% and trail, TP +40% with a 20-slot hold) and lost both times: these
// coins mostly retrace to cost, so banking +20% whole beats the trail.
// Likewise a longer hold (30 slots), a tighter stop (-5%), a lower take
// profit (+15%) and cutting slow bleeders early all scored worse than the
// shipped settings, as did widening the buyer filter to 5-6 distinct
// buyers: the extra coins those filters add lose more per trade than the
// ones the shipped filter keeps.
//
// Dev-window result (grade-local, process driver): net PnL about -0.18 SOL
// over 138 coins / 138 round trips, win rate ~23%, max drawdown ~2.2%,
// guardrails met. That is still slightly negative on this window, and
// honest about it: the pilot sniper baseline scores -0.42 SOL on the same
// window, the momentum pilot -9.45 SOL and the reversion pilot about
// -4.3 SOL, so this entry is the best of the four measured here, but it
// does not claim a positive edge on the dev window. The final window is a
// different 6 hours; the same hot-launch filter is what it bets on.
//
// Protocol notes (agent-fun/replay/v2): the harness sends a hello handshake
// with the seed, capital, caps and fees, then one batch per slot carrying
// the slot's market events (TradeEvent / CreateEvent / CompleteEvent),
// marks (latest reserves), fills for orders decided 2 slots earlier, and
// the account. The bot answers each batch with exactly one reply echoing
// its seq, containing at most caps.max_orders_per_batch orders. Orders
// decided on slot s fill at slot s + latency_slots (2), so every decision
// is priced on reserves that are already 2 slots old: entries are sized
// against the 1%-of-real-reserve cap at decision time with a 3% margin,
// and sells always use max_slippage_bps 10000 because a stale price must
// never strand a position.
//
// Determinism: everything is a pure function of the batches the harness
// sends. No clock, no Math.random, no environment reads; iteration is over
// insertion-ordered maps or sorted keys, so the two graded executions
// produce byte-identical action logs.

import { runBot, type Batch, type BotState, type OrderInput, type Pubkey } from './vendor/makefun-bot.ts';

const BPS = 10_000n;
const FEE_BPS = 125n; // 95 protocol + 30 creator bps charged by the curve, each way.
const LAMPORTS_PER_SOL = 1_000_000_000n;

interface Tick {
  slot: number;
  isBuy: boolean;
  sol: bigint;
  user: Pubkey;
  /** Virtual reserves after this trade: price is vq / vt. */
  vq: bigint;
  vt: bigint;
}

interface Coin {
  mint: Pubkey;
  createSlot: number;
  creator: Pubkey;
  devBuy: bigint;
  buyers: Set<Pubkey>;
  devSold: boolean;
  recent: Tick[];
  /** A first buy was sent (adds are not used: one clean entry per coin). */
  entered: boolean;
  /** Never buy again (exited, filtered out for good, or completed). */
  done: boolean;
  complete: boolean;
}

interface Held {
  openedSlot: number;
  /** Tx fees paid on this position's fills, on top of cost_lamports. */
  txPaid: bigint;
  /** Creator had already sold when the position opened. */
  devSoldAtOpen: boolean;
}

/** What selling `tokens` against (vq, vt) would pay after the curve fee. */
function sellValue(tokens: bigint, vq: bigint, vt: bigint): bigint {
  if (tokens <= 0n || vt <= 0n) return 0n;
  const q = (tokens * vq) / (vt + tokens);
  return q - (q * FEE_BPS + BPS - 1n) / BPS;
}

const coins = new Map<Pubkey, Coin>();
const held = new Map<Pubkey, Held>();
/** Mints with a sell in flight. */
const selling = new Set<Pubkey>();

function readEvents(batch: Batch): void {
  for (const e of batch.events) {
    if (e.event === 'CreateEvent') {
      coins.set(e.mint, {
        mint: e.mint,
        createSlot: e.slot,
        creator: e.creator,
        devBuy: 0n,
        buyers: new Set(),
        devSold: false,
        recent: [],
        entered: false,
        done: false,
        complete: false,
      });
    } else if (e.event === 'TradeEvent') {
      const c = coins.get(e.mint);
      if (c === undefined) continue;
      const sol = BigInt(e.sol_amount);
      c.recent.push({ slot: e.slot, isBuy: e.is_buy, sol, user: e.user, vq: BigInt(e.virtual_quote_reserves), vt: BigInt(e.virtual_token_reserves) });
      if (c.recent.length > 40) c.recent.splice(0, c.recent.length - 40);
      const isDev = e.user === c.creator;
      if (e.is_buy) {
        if (isDev && e.slot === c.createSlot) c.devBuy += sol;
        else if (!isDev) c.buyers.add(e.user);
      } else if (isDev) {
        c.devSold = true;
      }
    } else {
      const c = coins.get(e.mint);
      if (c !== undefined) {
        c.complete = true;
        c.done = true;
      }
    }
  }
}

function hasPendingBuy(state: BotState, mint: Pubkey): boolean {
  for (const p of state.pending.values()) if (p.order.mint === mint && p.order.side === 'buy') return true;
  return false;
}

function hasPendingSell(state: BotState, mint: Pubkey): boolean {
  for (const p of state.pending.values()) if (p.order.mint === mint && p.order.side === 'sell') return true;
  return false;
}

await runBot({
  onBatch(state: BotState, batch: Batch): OrderInput[] {
    readEvents(batch);
    const orders: OrderInput[] = [];
    const cap = state.hello.caps.max_orders_per_batch;
    const tx = state.txFeeLamports();
    const marks = new Map<Pubkey, { vq: bigint; vt: bigint }>();
    for (const m of batch.marks) {
      marks.set(m.mint, { vq: BigInt(m.virtual_quote_reserves), vt: BigInt(m.virtual_token_reserves) });
    }

    // Fills: track tx paid per position; open a Held record on a filled buy.
    for (const f of batch.fills) {
      if (f.client_id.startsWith('_')) {
        held.delete(f.mint);
        selling.delete(f.mint);
        continue;
      }
      const h = held.get(f.mint);
      if (f.status !== 'rejected' && h !== undefined) h.txPaid += BigInt(f.tx_fee_lamports);
      if (f.side === 'buy' && f.status === 'filled' && h === undefined) {
        held.set(f.mint, {
          openedSlot: f.slot,
          txPaid: BigInt(f.tx_fee_lamports),
          devSoldAtOpen: coins.get(f.mint)?.devSold ?? false,
        });
      }
    }
    for (const mint of [...selling]) if (!hasPendingSell(state, mint)) selling.delete(mint);
    for (const mint of [...held.keys()]) {
      if (!state.positions.has(mint) && !selling.has(mint) && !hasPendingBuy(state, mint)) held.delete(mint);
    }

    // 1. Exits first.
    for (const [mint, pos] of state.positions) {
      if (orders.length >= cap) break;
      if (selling.has(mint)) continue;
      const c = coins.get(mint);
      let h = held.get(mint);
      if (h === undefined) {
        h = { openedSlot: state.slot, txPaid: tx, devSoldAtOpen: c?.devSold ?? false };
        held.set(mint, h);
      }
      let mk = marks.get(mint);
      if (mk === undefined) {
        const cv = state.curves.get(mint);
        if (cv === undefined) continue;
        mk = { vq: cv.virtual_quote_reserves, vt: cv.virtual_token_reserves };
      }
      const value = sellValue(pos.token_amount, mk.vq, mk.vt) - tx;
      const basis = pos.cost_lamports + h.txPaid;
      const age = state.slot - h.openedSlot;
      let exit = false;
      if (basis > 0n) {
        // Fast full exit at +20%: bank the move, do not give it back.
        if (value * BPS >= basis * (BPS + 2000n)) exit = true;
        else if (value * BPS <= basis * (BPS - 800n)) exit = true;
      }
      if (!exit && age >= 10) exit = true; // stale: out fast
      if (!exit && c !== undefined && c.devSold && !h.devSoldAtOpen) exit = true; // creator dumped
      if (!exit) continue;
      orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: 10_000 });
      selling.add(mint);
      if (c !== undefined) c.done = true;
    }

    // 2. Entries: fresh launches that pass the rug filter.
    let free = state.freeCashLamports() - tx * BigInt(orders.length);
    let open = state.committedPositionCount();
    for (const c of coins.values()) {
      if (orders.length >= cap) break;
      if (c.done || c.complete || c.entered) continue;
      const age = state.slot - c.createSlot;
      if (age > 8) {
        c.done = true; // launch window closed: never chase an old coin as a snipe
        continue;
      }
      if (open >= state.hello.caps.max_open_positions) break;
      const curve = state.curves.get(c.mint);
      if (curve === undefined || curve.complete) continue;
      if (c.devSold) {
        c.done = true;
        continue;
      }
      const rq = curve.real_quote_reserves;
      if (rq < 3_000_000_000n || rq > 40_000_000_000n) continue; // 3 .. 40 SOL real: hot enough that the 1% cap allows a real stake
      if (c.devBuy > 3_000_000_000n) continue; // creator bought more than 3 SOL at launch
      if (c.buyers.size < 2 || c.buyers.size > 4) continue; // at least two outsiders, not a bundle
      // Buyers are still stepping in: the last two trades must both be buys,
      // so a single stray buy after the burst ended does not trigger an entry.
      const n = c.recent.length;
      const lastTick = c.recent[n - 1];
      const prevTick = c.recent[n - 2];
      if (lastTick === undefined || prevTick === undefined || !lastTick.isBuy || !prevTick.isBuy) continue;
      // Latency tax: our buy fills 2 slots after we decide, so a coin that
      // just went vertical (+15% over its last 3 trades) fills at the top
      // and retraces into us. Only buy a steady climb, not a spike.
      const thirdTick = c.recent[n - 3];
      if (thirdTick !== undefined && thirdTick.vt > 0n && lastTick.vt > 0n) {
        // pNow / p3ago = (vqNow/vtNow) / (vq3/vt3) > 1.15  <=>  skip
        if (lastTick.vq * thirdTick.vt * 100n > thirdTick.vq * lastTick.vt * 115n) continue;
      }
      const stake = 100_000_000n; // 0.1 SOL
      const maxBuy = (state.maxBuyLamports(c.mint) * 97n) / 100n;
      const amount = stake < maxBuy ? stake : maxBuy;
      if (amount < 5_000_000n) continue; // below 0.005 SOL the tx fee eats it
      if (free < amount + tx) continue;
      orders.push({ side: 'buy', mint: c.mint, quote_lamports: amount, max_slippage_bps: 10_000 });
      free -= amount + tx;
      c.entered = true;
      open += 1;
    }
    return orders;
  },
});
