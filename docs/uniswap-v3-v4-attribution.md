# Uniswap V3/V4 verified-trade contract

This is the evidence contract for promoting a V3/V4 event to a verified BUY or
SELL. It derives protocol facts from Uniswap core contracts, not router docs,
indexer conventions, or a topic hash alone.

It applies only to Uniswap V3 and Uniswap V4. Other venues and launchpads stay
`unknown_unsupported` until they have an equivalent evidence contract.

## Current production state

The implementation is deployed to Railway in **shadow mode**:
`LIVE_VERIFIED_TRADE_SHADOW=true` and `LIVE_VERIFIED_TRADE_GATE=false`. Strict
results are recorded and compared, while the legacy candidate path still feeds
the live UI and alerts. Therefore this document describes the requirement for a
*verified* trade; it is not a claim that every currently displayed live signal
already meets it.

Promotion requires a reviewed 24–48 hour measurement window and an explicit
gate change. The first investigated shadow mismatch was correctly suppressed:
the watched wallet received a V4 output transfer but did not fund either swap.

## Non-negotiable result

A live BUY or SELL means all of these are demonstrated for one watched wallet
in one successful transaction:

1. A supported, verified Uniswap pool action occurred.
2. That wallet gave up one asset and received another.
3. Direction comes from the wallet's net balance change, never the discovery
   Transfer log, router destination, or a Swap event's sender/recipient.
4. The evidence is not part of undecomposed liquidity, fee, hook, or other
   multi-action activity.

Failure to prove an item is not a negative trade verdict. It is pending,
unknown, or a conservative non-trade outcome. Once the verified-trade gate is
enabled, it must never enter the live feed, swarm, alert, or sniper path.

## Authoritative Uniswap sources

| Protocol | Source | Permitted protocol claim |
| --- | --- | --- |
| V3 factory | [IUniswapV3Factory](https://github.com/Uniswap/v3-core/blob/main/contracts/interfaces/IUniswapV3Factory.sol) | `getPool(tokenA, tokenB, fee)` maps a token pair and fee to a pool; `PoolCreated` is provenance evidence. |
| V3 pool events | [IUniswapV3PoolEvents](https://github.com/Uniswap/v3-core/blob/main/contracts/interfaces/pool/IUniswapV3PoolEvents.sol) | `Initialize`, `Mint`, `Burn`, `Collect`, and `Swap` are distinct. Mint/Burn/Swap cannot precede Initialize; Collect is fee withdrawal. |
| V4 manager | [IPoolManager](https://github.com/Uniswap/v4-core/blob/main/src/interfaces/IPoolManager.sol) | `Initialize`, `ModifyLiquidity`, and `Swap` are emitted by the singleton manager; a pool is identified by `PoolId`, not a pool address. |
| V4 execution | [PoolManager](https://github.com/Uniswap/v4-core/blob/main/src/PoolManager.sol) | An unlock can contain multiple actions and hook effects; event co-occurrence cannot identify a wallet's swap leg. |

Configured V3 factory and V4 PoolManager addresses must be verified on chain
4663. Mainnet deployment addresses are not portable proof for Robinhood Chain.

## V3 acceptance rules

### Pool identity

- Parse `Swap` from its emitting pool only.
- Read the pool's `token0`, `token1`, `fee`, and `factory`.
- Query the configured trusted factory's `getPool(token0, token1, fee)`.
- Both the factory result and `pool.factory()` must match the emitter/trusted
  factory. Persist all call results and source block as verification evidence.
- Timeout, throttle, or queue delay is `verification_pending`, never
  `unsupported_protocol`.

### V3 non-trades

- Pool `Mint` is liquidity added; `Burn` is liquidity removed; `Collect` is
  fee/liquidity withdrawal, including zero-amount collections.
- Position-manager increase/decrease/collect is evidence only when emitted by
  the configured manager and tied to the watched wallet by real ownership/action
  evidence.
- A verified swap plus liquidity/fee is `mixed_or_ambiguous_activity` until
  individual asset movements are attributed to individual actions.

### Wallet economics and direction

- Calculate the watched wallet's net balance deltas from all fungible Transfer
  logs in the receipt, never the trigger Transfer alone.
- Require one asset in and one asset out. The counter-leg may be ERC-20,
  canonical WETH wrap/unwrap, top-level native value to a verified entry point,
  or a valid execution-trace-native delta.
- A positive net delta in the signal token is BUY; a negative delta is SELL.

## V4 acceptance rules

### Pool identity

- The `Swap`, `Initialize`, and `ModifyLiquidity` emitter must equal the
  configured, chain-verified V4 PoolManager singleton.
- `topic1` must be a valid `PoolId`; it is not an address.
- Resolve and persist `Initialize` provenance from that same manager for the
  PoolId, its currencies, fee, tick spacing, and hook address. The durable
  PoolId → PoolKey registry may backfill a missing entry from manager logs;
  lookup failure is pending, not proof that a pool is invalid.
- For a multihop route, require the transferred signal token to belong to at
  least one verified PoolId in the route. It need not belong to every hop.
- Manager-shaped logs from another emitter, or malformed/missing PoolIds, are
  unsupported rather than trades.

### V4 multi-action and hooks

- `ModifyLiquidity` and `Donate` are non-trades.
- Under V4's unlock model, event `sender` is often a router/action caller, not
  the wallet. It cannot establish wallet ownership of the action.
- Swap plus liquidity, donation, or un-decomposed hook settlement remains
  `mixed_or_ambiguous_activity`, suppressed rather than guessed.
- V4 uses the same full wallet-net-delta requirement as V3. PoolManager event
  data is not a substitute for wallet accounting.

## Implementation boundary

`src/attrib/classifier.ts` is the canonical verdict function. The legacy
`src/chain/receipt.ts` predicate is only a candidate discovery gate: it sees a
nearby V3/V4 topic but does not establish every rule above. It must not remain
the authority for production BUY/SELL emissions.

```
receipt / tx context
  -> verified pool provenance
  -> protocol findings + complete wallet deltas (+ trace-native when required)
  -> classifyTransaction
  -> confirmed_trade only
  -> live feed / aggregation / alerts
```

Every other outcome is retained in the attribution ledger for reconciliation.

## Required fixture matrix

Use captured successful real-chain receipts plus pool-verification evidence for
safety-critical acceptance paths. Synthetic fixtures are appropriate for pure
parsing and classifier branches, but cannot prove a router, trace, or pool
provenance integration. The fixture set includes the FORK 0.5 ETH → FORK V4
route and the captured third-party-funded V4 mismatch.

| Case | Required result |
| --- | --- |
| V3 verified pool, ERC-20 exchange | confirmed V3 BUY/SELL |
| V3 native/WETH counter-leg | confirmed only with WETH, top-level, or trace proof |
| V3 Mint, Burn, Collect, position add/remove/collect | non-trade |
| V3 swap plus LP/fee/zap | mixed/ambiguous, suppressed |
| V3 Swap from spoofed/unverified emitter | unsupported or pending, never trade |
| V4 trusted manager + known PoolId + exchange | confirmed V4 BUY/SELL |
| V4 ModifyLiquidity or Donate | non-trade |
| V4 swap plus liquidity/hook settlement | mixed/ambiguous until decomposed |
| V4 Swap from non-manager emitter | unsupported, never trade |
| Airdrop/direct transfer near unrelated swap | non-trade/ambiguous, never trade |
| Universal Router/multicall | direction only from wallet net deltas |

## Promotion gate

1. Dual-run this path against the existing listener with no alert or sniper
   behaviour change.
2. Reconcile every candidate in a fixed window with transaction hash, evidence,
   classifier version, and reason for every disagreement.
3. Review all disagreements, mixed outcomes, verification-pending observations,
   and trace-limited cases. Quiet time is not validation.
4. Require representative real V3 and V4 buys/sells, native-route coverage,
   and review of every observed matrix class before changing production
   emission. Keep collecting any class not yet seen in the shadow window.
5. Promote `confirmed_trade` to the feed first; alert and sniper control get a
   separate rollout and rollback switch.

The resulting claim is intentionally narrow: the live Uniswap V3/V4 path emits
only demonstrated wallet exchanges within its supported action set. It does not
claim universal chain coverage; unsupported venues, launchpads, hooks, and
un-decomposed actions remain visible as unknown/suppressed until their own
evidence contracts are implemented.
