# Local Bittensor Chain Handoff Spec (For Agent Execution)

## Goal
Stand up a **real local Bittensor chain instance** (not mocks), then seed deterministic on-chain state for integration/rebalance testing with:

- 1 controller wallet (tx submitter / spawner)
- 1 pure proxy controlled by the controller wallet
- 20 delegator wallets with **total 2000 TAO** (target: 100 TAO each before fees/stakes)
- Each delegator authorizes the pure proxy with `ProxyType=Staking`, `delay=0`
- Root subnet (`netuid=0`) plus 16 additional subnets (`netuid=1..16`)
- Per-subnet **varied price and depth** (reserves must be intentionally different)

## Scope
This is a chain/bootstrap task only. Do not mock blockchain behavior. Do not use in-memory chain simulators.

## Primary References
- Local chain deployment: https://docs.learnbittensor.org/local-build/deploy/
- Local subnet creation: https://docs.learnbittensor.org/local-build/create-subnet
- Proxy overview/types: https://docs.learnbittensor.org/keys/proxies
- Pure proxies: https://docs.learnbittensor.org/keys/proxies/pure-proxies
- Staking with proxy: https://docs.learnbittensor.org/keys/proxies/staking-with-proxy
- Subtensor repo: https://github.com/opentensor/subtensor

## Runtime Compatibility Contract (Must Pass)
The seeded chain must expose APIs used by this codebase:

### Required pallets/extrinsics
- `proxy.createPure`
- `proxy.addProxy`
- `proxy.proxy`
- `utility.forceBatch` or `utility.batch` (prefer `forceBatch` if available)
- `subtensorModule.addStake`
- `subtensorModule.removeStake`
- `subtensorModule.moveStake`

### Optional but expected
- `subtensorModule.addStakeLimit`
- `subtensorModule.removeStakeLimit`
- `subtensorModule.swapStakeLimit`
- RPC: `swap_currentAlphaPrice`

### Required queries / runtime APIs
- `query.subtensorModule.subnetTAO`
- `query.subtensorModule.subnetAlphaIn`
- `call.stakeInfoRuntimeApi.getStakeInfoForColdkey`

## Important Codebase Note
Current code hardcodes Finney in `BlockchainService`:
- [`src/common/blockchain.service.ts`](/home/kubernautis/tss/trusted-stake-api/src/common/blockchain.service.ts)

Before local execution, update it to read RPC URL from env (for example `BITTENSOR_RPC`) with fallback to Finney. Otherwise local testing will not connect to your local chain.

## Deliverables
Agent must produce all of the following:

1. `scripts/localnet/bootstrap-chain.sh`
2. `scripts/localnet/seed-state.ts` (or `.js`) using `@polkadot/api` (non-interactive)
3. `scripts/localnet/verify-state.ts` (or `.js`) with strict assertions
4. `configs/localnet/state-manifest.json` (deterministic seed inputs)
5. `configs/localnet/state-report.json` (actual final on-chain state summary)
6. Short `README` section with exact run commands

## Deterministic Seed Inputs
Use a deterministic mnemonic set (fixed in `state-manifest.json`) for:
- Controller wallet (spawner/signer)
- Pure proxy (derived on-chain via `createPure`)
- 20 delegator wallets
- Optional liquidity-seeder wallets (separate from delegators)
- Optional subnet-owner wallets

Do not generate random keys at runtime unless explicitly passed a seed; state must be reproducible.

## Chain Bring-Up Requirements
1. Launch official local chain image (or local build) from docs.
2. Wait until block production is live.
3. Validate websocket endpoint by querying `system.number`.
4. Assert metadata includes required pallets/calls before seeding.

## Seeding Plan (Order Matters)

### Phase 1: Base Funding
1. Fund controller and seeder wallets from dev account.
2. Fund 20 delegators to target total 2000 TAO (100 TAO each target).
3. Fund controller/pure-proxy enough for tx fees.

### Phase 2: Proxy Topology
1. Controller executes `proxy.createPure(Any, 0, index=0)` and records pure proxy address.
2. For each delegator wallet, submit `proxy.addProxy(delegate=pureProxy, proxyType=Staking, delay=0)`.
3. Verify on-chain each delegator now includes pure proxy delegate with `Staking`.

### Phase 3: Subnet Topology
1. Ensure root subnet (`netuid=0`) exists.
2. Create 16 additional subnets (target `netuid=1..16`).
3. For each created subnet, establish at least one active validator hotkey with stake.

### Phase 4: Liquidity/Price Shaping
Goal: each subnet has deliberately different reserve depth and spot price.

- Depth proxy: `subnetTAO` magnitude
- Price proxy: `subnetTAO / subnetAlphaIn`

Use seeder wallets and stake/unstake flows to converge reserves to targets per subnet.
If direct reserve control is unavailable, iterative trades are acceptable.

## Target Liquidity Profile (Example)
Use this as default unless overridden by manifest.

| netuid | target `subnetTAO` (TAO) | target `subnetAlphaIn` (alpha) | implied price (TAO/alpha) | depth tier |
|---|---:|---:|---:|---|
| 1 | 150000 | 200000 | 0.75 | deep |
| 2 | 120000 | 100000 | 1.20 | deep |
| 3 | 90000 | 150000 | 0.60 | deep |
| 4 | 70000 | 50000 | 1.40 | mid |
| 5 | 65000 | 95000 | 0.6842 | mid |
| 6 | 50000 | 40000 | 1.25 | mid |
| 7 | 45000 | 70000 | 0.6429 | mid |
| 8 | 35000 | 30000 | 1.1667 | mid |
| 9 | 30000 | 45000 | 0.6667 | shallow |
| 10 | 25000 | 18000 | 1.3889 | shallow |
| 11 | 22000 | 33000 | 0.6667 | shallow |
| 12 | 18000 | 12000 | 1.50 | shallow |
| 13 | 15000 | 20000 | 0.75 | shallow |
| 14 | 12000 | 8000 | 1.50 | shallow |
| 15 | 10000 | 14000 | 0.7143 | shallow |
| 16 | 8000 | 6000 | 1.3333 | very shallow |

Tolerance guidance for convergence:
- reserve amounts: +/-5%
- implied price ratio: +/-3%

## Delegator Portfolio Seeding
To make rebalance tests meaningful, seed delegator positions across multiple subnets:
- Every delegator should have:
  - non-zero free TAO
  - at least 3 non-root staked positions
  - at least 1 delegator with root stake (`netuid=0`)
- Distribute positions so some wallets are overweight and some underweight for common strategy target sets.

## Verification Checklist (Hard Acceptance)
`verify-state` must fail fast if any assertion fails.

1. Chain reachable and producing blocks.
2. Required runtime compatibility contract passes.
3. Exactly 20 delegator wallets present.
4. Sum of delegator holdings (free + staked in TAO terms) is ~2000 TAO (allow fee drift).
5. Pure proxy exists and is controlled by controller.
6. All 20 delegators have `Staking` proxy delegation to pure proxy.
7. Subnets include `0..16` (17 total).
8. All 16 created subnets have non-zero reserves and at least one staked validator.
9. Liquidity profile variance is real:
   - max/min `subnetTAO` >= 10x
   - at least 4 distinct price bands by `subnetTAO/subnetAlphaIn`.
10. Emit `state-report.json` containing:
   - addresses
   - proxy links
   - per-wallet balances/stakes
   - per-subnet reserves and implied prices
   - block heights + tx hashes for major setup transactions

## Execution Contract for Agent
- Must be non-interactive and idempotent where possible.
- Re-running should not duplicate proxy relationships or fail on existing subnets; handle already-exists safely.
- On failure, print precise failing assertion and exit non-zero.
- Keep all amounts in RAO internally; only format TAO for logs/reports.

## Suggested Command Surface
- `npm run localnet:up` -> launches chain
- `npm run localnet:seed` -> seeds wallets/proxy/subnets/liquidity
- `npm run localnet:verify` -> hard assertions + state report
- `npm run localnet:down` -> stops chain

## Notes for Integration with This API
- Batch logic in this repository executes nested proxy calls:
  - `proxy.proxy(op.userAddress, 'Staking', stakeCall)`
  - wrapped inside `proxy.proxy(pureProxyAddress, 'Any', utility.forceBatch(...))`
- Therefore:
  - delegators must delegate `Staking` to pure proxy
  - controller/spawner must be able to execute through pure proxy (`Any` path)

