#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
MANIFEST_PATH="${PROJECT_ROOT}/configs/localnet/state-manifest.json"
NODE_DEPS_ROOT="${PROJECT_ROOT}/../trusted-stake-api/node_modules"

mapfile -t MANIFEST_VALUES < <(
  node - "${MANIFEST_PATH}" <<'NODE'
const fs = require('fs');
const manifest = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
console.log(manifest.network.containerName);
console.log(manifest.network.image);
console.log(manifest.network.fastBlocks ? 'true' : 'false');
for (const port of manifest.network.dockerPorts) {
  console.log(port);
}
NODE
)

CONTAINER_NAME="${MANIFEST_VALUES[0]}"
IMAGE_NAME="${MANIFEST_VALUES[1]}"
FAST_BLOCKS="${MANIFEST_VALUES[2]}"
PORT_1="${MANIFEST_VALUES[3]}"
PORT_2="${MANIFEST_VALUES[4]}"
ACTION="${1:-up}"
RPC_URL="${LOCALNET_RPC_URL:-ws://127.0.0.1:9944}"

wait_for_chain() {
  RPC_URL="${RPC_URL}" NODE_PATH="${NODE_DEPS_ROOT}" node - <<'NODE'
const { ApiPromise, WsProvider } = require('@polkadot/api');

async function getBlock(api) {
  const block = await api.query.system.number();
  return Number(block.toString());
}

(async () => {
  const rpcUrl = process.env.RPC_URL || 'ws://127.0.0.1:9944';
  const provider = new WsProvider(rpcUrl, 5000);
  const api = await ApiPromise.create({ provider });
  const first = await getBlock(api);
  await new Promise((resolve) => setTimeout(resolve, 2500));
  const second = await getBlock(api);
  await api.disconnect();
  if (!(second > first)) {
    throw new Error(`block production did not advance: ${first} -> ${second}`);
  }
  console.log(`local chain is live at ${rpcUrl} (${first} -> ${second})`);
})().catch((error) => {
  console.error(String(error && error.stack || error));
  process.exit(1);
});
NODE
}

case "${ACTION}" in
  up)
    if docker ps --filter "name=^/${CONTAINER_NAME}$" --format '{{.Names}}' | grep -qx "${CONTAINER_NAME}"; then
      echo "${CONTAINER_NAME} is already running"
      wait_for_chain
      exit 0
    fi

    if docker ps -a --filter "name=^/${CONTAINER_NAME}$" --format '{{.Names}}' | grep -qx "${CONTAINER_NAME}"; then
      docker start "${CONTAINER_NAME}" >/dev/null
      echo "started existing container ${CONTAINER_NAME}"
      wait_for_chain
      exit 0
    fi

    DOCKER_ARGS=(
      run
      -d
      --name "${CONTAINER_NAME}"
      -p "${PORT_1}"
      -p "${PORT_2}"
    )

    if [[ "${FAST_BLOCKS}" == "true" ]]; then
      DOCKER_ARGS+=(-e BITTENSOR_FAST_BLOCKS=true)
    fi

    DOCKER_ARGS+=("${IMAGE_NAME}")

    docker "${DOCKER_ARGS[@]}" >/dev/null
    echo "started ${CONTAINER_NAME} from ${IMAGE_NAME}"
    wait_for_chain
    ;;
  down)
    if docker ps --filter "name=^/${CONTAINER_NAME}$" --format '{{.Names}}' | grep -qx "${CONTAINER_NAME}"; then
      docker stop "${CONTAINER_NAME}" >/dev/null
      echo "stopped ${CONTAINER_NAME}"
    else
      echo "${CONTAINER_NAME} is not running"
    fi
    ;;
  reset)
    if docker ps --filter "name=^/${CONTAINER_NAME}$" --format '{{.Names}}' | grep -qx "${CONTAINER_NAME}"; then
      docker stop "${CONTAINER_NAME}" >/dev/null
      echo "stopped ${CONTAINER_NAME}"
    fi

    if docker ps -a --filter "name=^/${CONTAINER_NAME}$" --format '{{.Names}}' | grep -qx "${CONTAINER_NAME}"; then
      docker rm "${CONTAINER_NAME}" >/dev/null
      echo "removed ${CONTAINER_NAME}"
    else
      echo "${CONTAINER_NAME} did not exist"
    fi

    bash "${BASH_SOURCE[0]}" up
    ;;
  status)
    docker ps -a --filter "name=^/${CONTAINER_NAME}$"
    ;;
  logs)
    docker logs --tail 200 "${CONTAINER_NAME}"
    ;;
  *)
    echo "usage: $0 {up|down|reset|status|logs}" >&2
    exit 1
    ;;
esac
