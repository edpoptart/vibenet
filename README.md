# Local Bittensor Localnet

## Localnet Commands

This workspace seeds a real local Bittensor chain using the official `ghcr.io/opentensor/subtensor-localnet:devnet-ready` image and writes deterministic state from [`configs/localnet/state-manifest.json`](/home/kubernautis/tss/vibenet/configs/localnet/state-manifest.json).

Run commands from [`/home/kubernautis/tss/vibenet`](/home/kubernautis/tss/vibenet):

```bash
npm run localnet:up
npm run localnet:seed
npm run localnet:verify
npm run localnet:down
```

Defaults:

- Websocket RPC: `ws://127.0.0.1:9944`
- Docker container: `vibenet-local-chain`
- Fast blocks: enabled
- Pure proxy controllers: the primary controller plus 9 deterministic additional controller wallets with `ProxyType=Any`
- Parallel controller free balance target: 100 TAO each, so smoke-test fee retries do not become the bottleneck

Notes:

- The Node scripts reuse the installed `@polkadot/api` stack from [`../trusted-stake-api/node_modules`](/home/kubernautis/tss/trusted-stake-api/node_modules).
- `seed-state.js` is idempotent where possible: it reuses the stored pure proxy, skips existing proxy links, and only creates missing subnets in the `0..16` target set.
- The seeded market shape now includes a `200k TAO @ 0.1`, a `100k TAO @ 0.05`, then progressively smaller and cheaper subnets down to `2.5k TAO @ 0.002`, as defined in [`configs/localnet/state-manifest.json`](/home/kubernautis/tss/vibenet/configs/localnet/state-manifest.json).
- Seeder wallets are funded for each subnet's target TAO depth and buy into the pool through normal staking; the fixture then bootstraps alpha-in depth to the manifest price so the seeded markets stay tradeable at smoke-test sizes.
- `verify-state.js` checks each target subnet's TAO reserve depth against the manifest and checks the reserve-implied price against `swap_currentAlphaPrice`.
- `verify-state.js` rewrites [`configs/localnet/state-report.json`](/home/kubernautis/tss/vibenet/configs/localnet/state-report.json) with a fresh on-chain summary and exits non-zero on the first failed assertion.

## Fixture Manager Container

The fixture manager is a side container that owns the local chain lifecycle and exposes HTTP endpoints for tests:

```bash
docker compose -f docker-compose.fixture.yml up --build
```

It uses host networking and mounts `/var/run/docker.sock`, so it can hard-reset and recreate the sibling `vibenet-local-chain` container.

Endpoints:

- `GET /health`
- `POST /reset`
- `POST /init`
- `POST /reset-and-init`
- `GET /fixture`
- `GET /verify`

`GET /fixture` reports the actual on-chain fixture facts from `state-report.json`: RPC URL, pure proxy, controller URIs/addresses, delegator addresses, and subnet validator/liquidity profiles.
