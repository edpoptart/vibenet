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

Notes:

- The Node scripts reuse the installed `@polkadot/api` stack from [`../trusted-stake-api/node_modules`](/home/kubernautis/tss/trusted-stake-api/node_modules).
- `seed-state.js` is idempotent where possible: it reuses the stored pure proxy, skips existing proxy links, and only creates missing subnets in the `0..16` target set.
- The seeded market shape now includes a `200k TAO @ 0.1`, a `100k TAO @ 0.05`, then progressively smaller and cheaper subnets down to `2.5k TAO @ 0.002`, as defined in [`configs/localnet/state-manifest.json`](/home/kubernautis/tss/vibenet/configs/localnet/state-manifest.json).
- To make those deep low-price pools reproducible on the devnet image, reserve targets are applied with dev-only `sudo.system.setStorage` writes during seeding.
- `verify-state.js` rewrites [`configs/localnet/state-report.json`](/home/kubernautis/tss/vibenet/configs/localnet/state-report.json) with a fresh on-chain summary and exits non-zero on the first failed assertion.
