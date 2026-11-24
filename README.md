# Launch-rider — Pump.fun Paper Sprint bot

[![make.fun bounty](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)
[![rank](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/aint965/pumpfun-paper-sprint-bot/rank.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)
[![reward](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/aint965/pumpfun-paper-sprint-bot/reward.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)

Entry for [Pump.fun Paper Sprint: Any Bot Can Win](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b) — a paper-trading bot for the `agent-fun/replay/v2` harness. Starting capital 10 SOL, ranked by net PnL over a 6-hour replay of real pump.fun market data.

## Strategy

Most pump.fun coins die seconds after launch; a small share run hard in their first minutes. This bot:

1. **Snipes hot fresh launches** (within 6 slots of their `CreateEvent`) that pass a rug filter: real SOL reserves already 3–30 SOL, creator bought at most 2.5 SOL at launch, 2–3 distinct outside buyers (not a bundled cluster), creator has not sold, and the most recent trade is a buy.
2. **Buys 0.1 SOL** per coin (capped at 97% of the 1%-of-real-reserve per-reply buy cap), at most 5 open positions.
3. **Exits fast and whole**: take profit at +20%, stop loss at −8%, out after 10 slots (~2 s) if neither fired, and out at once if the creator sells.

Every trade must clear ~2.5% of curve fees (95 bps protocol + 30 bps creator, each way) plus ~105k lamports of tx fees per order. The 1%-of-real-reserve buy cap is the binding size limit, which is why the entry requires 3+ SOL of real reserves: on cold launches the cap only allows a dust-sized buy whose tx fee eats the trade. Letting winners ride (sell half, trail the rest) was tried and lost on the dev window — these coins mostly retrace to cost, so banking +20% whole beats the trail.

Dev-window result (grade-local): net PnL about −0.20 SOL over 99 coins / 99 round trips, win rate ~24%, max drawdown ~2.4%, guardrails met — the best of the four strategies measured on that window (pilot sniper −0.42 SOL, pilot reversion ~−4.3 SOL, pilot momentum −9.45 SOL), though still slightly negative there, so no positive edge is claimed on the dev window.

## Determinism

The bot is a pure function of the batches the harness sends: no clock, no randomness, no environment reads, iteration over insertion-ordered maps only. The two graded executions produce byte-identical action logs.

## Files

- `main.ts` — the whole strategy (Node 22, runs as `node main.ts`).
- `vendor/makefun-bot.ts` — the kit's `agent-fun/replay/v2` shim, vendored unchanged.
