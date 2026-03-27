const fs = require('fs');
const path = require('path');
const { ApiPromise, WsProvider, Keyring } = require('@polkadot/api');
const { u8aToHex } = require('@polkadot/util');
const { cryptoWaitReady } = require('@polkadot/util-crypto');

const RAO_PER_TAO = 1_000_000_000n;
const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
const MANIFEST_PATH = path.join(PROJECT_ROOT, 'configs', 'localnet', 'state-manifest.json');
const REPORT_PATH = path.join(PROJECT_ROOT, 'configs', 'localnet', 'state-report.json');
const DECIMAL_PATTERN = /^(\d+)(?:\.(\d+))?$/;

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function writeJson(filePath, value) {
  fs.writeFileSync(
    filePath,
    JSON.stringify(
      value,
      (_, input) => (typeof input === 'bigint' ? input.toString() : input),
      2,
    ) + '\n',
  );
}

function encodeStorageValue(codec) {
  return u8aToHex(codec.toU8a());
}

function decimalToScaledBigInt(value, decimals = 9) {
  if (typeof value === 'bigint') {
    return value;
  }

  const text = String(value).trim();
  const match = DECIMAL_PATTERN.exec(text);
  if (!match) {
    throw new Error(`invalid decimal value: ${text}`);
  }

  const integerPart = match[1] || '0';
  const fractionPart = match[2] || '';
  if (fractionPart.length > decimals) {
    throw new Error(`too many fractional digits for ${text}; max is ${decimals}`);
  }

  const paddedFraction = fractionPart.padEnd(decimals, '0');
  return BigInt(integerPart) * 10n ** BigInt(decimals) + BigInt(paddedFraction || '0');
}

function loadManifest() {
  return readJson(MANIFEST_PATH);
}

function loadReport() {
  if (!fs.existsSync(REPORT_PATH)) {
    return null;
  }
  return readJson(REPORT_PATH);
}

function saveReport(report) {
  writeJson(REPORT_PATH, report);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeError(error) {
  if (!error) {
    return '';
  }
  return String(error.message || error);
}

function formatTao(valueRao) {
  return `${(Number(valueRao) / Number(RAO_PER_TAO)).toFixed(4)} TAO`;
}

function ratioFromReserves(taoRao, alphaRao) {
  if (alphaRao === 0n) {
    return 0;
  }
  return Number(taoRao) / Number(alphaRao);
}

function getSubnetTargetTaoRao(subnet) {
  if (subnet.targetPoolTao !== undefined) {
    return decimalToScaledBigInt(subnet.targetPoolTao, 9);
  }
  return toBigInt(subnet.targetSubnetTaoRao);
}

function getSubnetTargetPriceScaled(subnet) {
  if (subnet.targetAlphaPriceTao !== undefined) {
    return decimalToScaledBigInt(subnet.targetAlphaPriceTao, 9);
  }
  const taoRao = toBigInt(subnet.targetSubnetTaoRao);
  const alphaRao = toBigInt(subnet.targetSubnetAlphaInRao);
  if (alphaRao === 0n) {
    throw new Error(`subnet ${subnet.netuid} has zero target alpha reserve`);
  }
  return (taoRao * RAO_PER_TAO) / alphaRao;
}

function getSubnetTargetPrice(subnet) {
  return Number(getSubnetTargetPriceScaled(subnet)) / Number(RAO_PER_TAO);
}

function getSubnetTargetAlphaInRao(subnet) {
  if (subnet.targetSubnetAlphaInRao !== undefined) {
    return toBigInt(subnet.targetSubnetAlphaInRao);
  }
  const taoRao = getSubnetTargetTaoRao(subnet);
  const priceScaled = getSubnetTargetPriceScaled(subnet);
  if (priceScaled <= 0n) {
    throw new Error(`subnet ${subnet.netuid} has a non-positive target alpha price`);
  }
  return (taoRao * RAO_PER_TAO) / priceScaled;
}

function toBigInt(value) {
  if (typeof value === 'bigint') {
    return value;
  }
  if (typeof value === 'number') {
    return BigInt(Math.trunc(value));
  }
  if (typeof value === 'string') {
    return BigInt(value);
  }
  if (value && typeof value.toBigInt === 'function') {
    return value.toBigInt();
  }
  if (value && typeof value.toString === 'function') {
    return BigInt(value.toString());
  }
  throw new Error(`unable to convert value to bigint: ${String(value)}`);
}

function reserveTolerance(manifest) {
  return BigInt(manifest.verification.reserveToleranceBps);
}

function priceTolerance(manifest) {
  return BigInt(manifest.verification.priceToleranceBps);
}

function withinBps(actual, expected, toleranceBps) {
  if (expected === 0n) {
    return actual === 0n;
  }
  const delta = actual > expected ? actual - expected : expected - actual;
  return delta * 10_000n <= expected * toleranceBps;
}

async function connectApi(rpcUrl) {
  const provider = new WsProvider(rpcUrl, 10_000);
  return ApiPromise.create({ provider });
}

async function waitForBlockProgress(api, rounds = 2, delayMs = 2000) {
  let previous = Number((await api.query.system.number()).toString());
  for (let index = 0; index < rounds; index += 1) {
    await sleep(delayMs);
    const current = Number((await api.query.system.number()).toString());
    if (current <= previous) {
      throw new Error(`chain is reachable but not producing blocks: ${previous} -> ${current}`);
    }
    previous = current;
  }
  return previous;
}

function getRequiredRuntimeContract(api) {
  return {
    proxyCreatePure: typeof api.tx?.proxy?.createPure === 'function',
    proxyAddProxy: typeof api.tx?.proxy?.addProxy === 'function',
    proxyProxy: typeof api.tx?.proxy?.proxy === 'function',
    utilityBatch:
      typeof api.tx?.utility?.forceBatch === 'function' ||
      typeof api.tx?.utility?.batch === 'function',
    addStake: typeof api.tx?.subtensorModule?.addStake === 'function',
    removeStake: typeof api.tx?.subtensorModule?.removeStake === 'function',
    moveStake: typeof api.tx?.subtensorModule?.moveStake === 'function',
    subnetTAO: typeof api.query?.subtensorModule?.subnetTAO === 'function',
    subnetAlphaIn: typeof api.query?.subtensorModule?.subnetAlphaIn === 'function',
    stakeInfoRuntimeApi:
      typeof api.call?.stakeInfoRuntimeApi?.getStakeInfoForColdkey === 'function',
  };
}

function assertRuntimeContract(api) {
  const contract = getRequiredRuntimeContract(api);
  const failures = Object.entries(contract)
    .filter(([, ok]) => !ok)
    .map(([name]) => name);
  if (failures.length > 0) {
    throw new Error(`runtime compatibility contract failed: ${failures.join(', ')}`);
  }
  return {
    required: contract,
    optional: {
      addStakeLimit: typeof api.tx?.subtensorModule?.addStakeLimit === 'function',
      removeStakeLimit: typeof api.tx?.subtensorModule?.removeStakeLimit === 'function',
      swapStakeLimit: typeof api.tx?.subtensorModule?.swapStakeLimit === 'function',
      swapCurrentAlphaPrice:
        typeof api.rpc?.state?.call === 'function' || typeof api.rpc?.provider?.send === 'function',
    },
  };
}

function decodeDispatchError(api, dispatchError) {
  if (!dispatchError) {
    return null;
  }
  if (dispatchError.isModule) {
    const decoded = api.registry.findMetaError(dispatchError.asModule);
    return `${decoded.section}.${decoded.name}: ${decoded.docs.join(' ')}`;
  }
  return dispatchError.toString();
}

async function signAndSend(api, tx, signer, label = 'extrinsic') {
  return new Promise((resolve, reject) => {
    let unsub = null;

    tx.signAndSend(signer, async (result) => {
      if (result.dispatchError) {
        const message = decodeDispatchError(api, result.dispatchError);
        if (typeof unsub === 'function') {
          unsub();
        }
        reject(new Error(`${label} failed: ${message}`));
        return;
      }

      if (result.status.isInBlock || result.status.isFinalized) {
        const blockHash = result.status.isInBlock
          ? result.status.asInBlock.toString()
          : result.status.asFinalized.toString();
        const header = await api.rpc.chain.getHeader(blockHash);
        if (typeof unsub === 'function') {
          unsub();
        }
        resolve({
          label,
          txHash: result.txHash.toString(),
          blockHash,
          blockNumber: Number(header.number.toString()),
          events: result.events,
        });
      }
    })
      .then((handle) => {
        unsub = handle;
      })
      .catch((error) => {
        reject(new Error(`${label} submission failed: ${normalizeError(error)}`));
      });
  });
}

function isBenignAlreadyExists(error) {
  const message = normalizeError(error);
  return (
    message.includes('Duplicate') ||
    message.includes('Already') ||
    message.includes('already') ||
    message.includes('HotKeyAlreadyRegisteredInSubNet')
  );
}

async function deriveAccounts(manifest) {
  await cryptoWaitReady();
  const keyring = new Keyring({ type: 'sr25519' });
  const make = (label, uri) => {
    const pair = keyring.addFromUri(uri);
    return { label, uri, pair, address: pair.address };
  };

  const controller = make(
    'controller',
    `${manifest.wallets.controllerMnemonic}//controller`,
  );

  const funderUris = Array.isArray(manifest.funding.funderUris)
    ? manifest.funding.funderUris
    : [manifest.funding.funderUri];
  const funders = funderUris.map((uri, index) =>
    make(index === 0 ? 'funder-alice' : `funder-${index + 1}`, uri),
  );
  const funder = funders[0];

  const delegators = Array.from({ length: manifest.wallets.delegatorCount }, (_, index) =>
    make(
      `delegator-${String(index + 1).padStart(2, '0')}`,
      `${manifest.wallets.delegatorMnemonic}//delegator//${String(index + 1).padStart(2, '0')}`,
    ),
  );

  const seeders = Array.from({ length: manifest.wallets.seederCount }, (_, index) =>
    make(
      `seeder-${String(index + 1).padStart(2, '0')}`,
      `${manifest.wallets.seederMnemonic}//seeder//${String(index + 1).padStart(2, '0')}`,
    ),
  );

  const validatorByNetuid = new Map();
  validatorByNetuid.set(
    0,
    make('validator-root', `${manifest.wallets.validatorMnemonic}//validator//root`),
  );
  for (let netuid = 1; netuid <= 16; netuid += 1) {
    validatorByNetuid.set(
      netuid,
      make(
        `validator-${String(netuid).padStart(2, '0')}`,
        `${manifest.wallets.validatorMnemonic}//validator//${String(netuid).padStart(2, '0')}`,
      ),
    );
  }

  return {
    funders,
    funder,
    controller,
    delegators,
    seeders,
    validatorByNetuid,
  };
}

function parseProxyEntries(rawValue) {
  const tuple = Array.isArray(rawValue) ? rawValue : rawValue?.toJSON?.() ?? rawValue;
  const defs = Array.isArray(tuple) ? tuple[0] : tuple?.[0] ?? tuple?.proxies ?? [];
  const normalized = defs?.toJSON?.() ?? defs;
  return Array.isArray(normalized) ? normalized : [];
}

async function hasProxyDelegation(api, real, delegate, proxyType) {
  const raw = await api.query.proxy.proxies(real);
  const entries = parseProxyEntries(raw);
  return entries.some((entry) => {
    const entryDelegate = String(entry.delegate || '');
    const entryProxyType = String(entry.proxyType || entry.proxy_type || '');
    const entryDelay = Number(entry.delay || 0);
    return (
      entryDelegate === delegate &&
      entryProxyType === proxyType &&
      entryDelay === 0
    );
  });
}

function getPureCreatedAddress(events) {
  const hit = events.find(
    ({ event }) => event.section === 'proxy' && event.method === 'PureCreated',
  );
  if (!hit) {
    return null;
  }
  const names = hit.event.meta.fields.map((field) => field.name.toString());
  const pureIndex = names.findIndex((name) => name === 'pure');
  if (pureIndex >= 0) {
    return hit.event.data[pureIndex].toString();
  }
  return hit.event.data[0].toString();
}

async function getOrCreatePureProxy(api, controller, manifest, report, txLog) {
  const existingAddress = report?.pureProxy?.address;
  if (existingAddress) {
    const stillValid = await hasProxyDelegation(
      api,
      existingAddress,
      controller.address,
      manifest.proxy.pureProxyType,
    );
    if (stillValid) {
      return {
        address: existingAddress,
        createdTx: report.pureProxy.createdTx || null,
      };
    }
  }

  const tx = api.tx.proxy.createPure(
    manifest.proxy.pureProxyType,
    manifest.proxy.delay,
    manifest.proxy.index,
  );
  const receipt = await signAndSend(api, tx, controller.pair, 'proxy.createPure');
  const address = getPureCreatedAddress(receipt.events);
  if (!address) {
    throw new Error('proxy.createPure succeeded but PureCreated event was not found');
  }

  txLog.push({
    kind: 'proxy.createPure',
    txHash: receipt.txHash,
    blockNumber: receipt.blockNumber,
    address,
  });

  return {
    address,
    createdTx: {
      txHash: receipt.txHash,
      blockNumber: receipt.blockNumber,
    },
  };
}

function pickTransfer(api) {
  const balances = api.tx?.balances;
  if (typeof balances?.transferKeepAlive === 'function') {
    return balances.transferKeepAlive.bind(balances);
  }
  if (typeof balances?.transferAllowDeath === 'function') {
    return balances.transferAllowDeath.bind(balances);
  }
  if (typeof balances?.transfer === 'function') {
    return balances.transfer.bind(balances);
  }
  throw new Error('balances transfer call is unavailable on this runtime');
}

async function getFreeBalance(api, address) {
  const accountInfo = await api.query.system.account(address);
  return toBigInt(accountInfo.data.free);
}

async function ensureBalance(api, funder, address, targetFreeRao, txLog, reason) {
  const free = await getFreeBalance(api, address);
  if (free >= targetFreeRao) {
    return null;
  }
  const amount = targetFreeRao - free;
  const transfer = pickTransfer(api);
  const receipt = await signAndSend(
    api,
    transfer(address, amount),
    funder.pair,
    `balances.transfer (${reason})`,
  );
  txLog.push({
    kind: 'balances.transfer',
    reason,
    txHash: receipt.txHash,
    blockNumber: receipt.blockNumber,
    address,
    amountRao: amount.toString(),
  });
  return receipt;
}

async function ensureBalanceFromFunders(api, funders, address, targetFreeRao, txLog, reason) {
  let free = await getFreeBalance(api, address);
  if (free >= targetFreeRao) {
    return null;
  }

  let remaining = targetFreeRao - free;
  let lastReceipt = null;
  const reservePerFunder = 5n * RAO_PER_TAO;

  for (const funder of funders) {
    const funderFree = await getFreeBalance(api, funder.address);
    if (funderFree <= reservePerFunder) {
      continue;
    }
    const spendable = funderFree - reservePerFunder;
    const amount = spendable >= remaining ? remaining : spendable;
    if (amount <= 0n) {
      continue;
    }
    lastReceipt = await ensureBalance(
      api,
      funder,
      address,
      free + amount,
      txLog,
      `${reason} via ${funder.label}`,
    );
    free += amount;
    remaining = targetFreeRao - free;
    if (remaining <= 0n) {
      break;
    }
  }

  if (free < targetFreeRao) {
    throw new Error(
      `unable to fund ${address} for ${reason}: short ${formatTao(targetFreeRao - free)}`,
    );
  }

  return lastReceipt;
}

async function ensureBalanceViaSudo(api, signer, address, targetFreeRao, txLog, reason) {
  const free = await getFreeBalance(api, address);
  if (free >= targetFreeRao) {
    return null;
  }
  if (!api.tx?.sudo?.sudo || !api.tx?.balances?.forceSetBalance) {
    throw new Error('sudo balances.forceSetBalance is unavailable on this runtime');
  }

  const receipt = await signAndSend(
    api,
    api.tx.sudo.sudo(api.tx.balances.forceSetBalance(address, targetFreeRao)),
    signer.pair,
    `sudo.forceSetBalance (${reason})`,
  );

  txLog.push({
    kind: 'sudo.balances.forceSetBalance',
    reason,
    txHash: receipt.txHash,
    blockNumber: receipt.blockNumber,
    address,
    targetFreeRao: targetFreeRao.toString(),
  });

  return receipt;
}

async function queryExistingNetuids(api) {
  const entries = await api.query.subtensorModule.networksAdded.entries();
  return entries
    .filter(([, value]) => value.isTrue)
    .map(([storageKey]) => Number(storageKey.args[0].toString()))
    .sort((left, right) => left - right);
}

async function isNetworkMember(api, netuid, hotkey) {
  const value = await api.query.subtensorModule.isNetworkMember(hotkey, netuid);
  return Boolean(value.valueOf());
}

async function getStakeInfoForColdkey(api, coldkey) {
  const raw = await api.call.stakeInfoRuntimeApi.getStakeInfoForColdkey(coldkey);
  const value = raw.toJSON();
  return Array.isArray(value) ? value : [];
}

async function querySubnetSnapshot(api, netuid) {
  const [taoRaw, alphaRaw, owner, ownerHotkey, firstEmission] = await Promise.all([
    api.query.subtensorModule.subnetTAO(netuid),
    api.query.subtensorModule.subnetAlphaIn(netuid),
    api.query.subtensorModule.subnetOwner(netuid),
    api.query.subtensorModule.subnetOwnerHotkey(netuid),
    api.query.subtensorModule.firstEmissionBlockNumber(netuid),
  ]);
  const taoRao = toBigInt(taoRaw);
  const alphaRao = toBigInt(alphaRaw);
  const firstEmissionString = firstEmission.toString();
  return {
    netuid,
    taoRao,
    alphaRao,
    impliedPrice: ratioFromReserves(taoRao, alphaRao),
    owner: owner.toString(),
    ownerHotkey: ownerHotkey.toString(),
    firstEmissionBlockNumber: firstEmissionString ? Number(firstEmissionString) : null,
  };
}

function stakeInfoToWalletPositions(stakeInfo, reservesByNetuid) {
  return stakeInfo.map((item) => {
    const alphaAmount = toBigInt(item.stake);
    const netuid = Number(item.netuid);
    const reserves = reservesByNetuid.get(netuid) || { taoRao: 0n, alphaRao: 0n };
    const taoEquivalent =
      netuid === 0 || reserves.alphaRao === 0n
        ? alphaAmount
        : (alphaAmount * reserves.taoRao) / reserves.alphaRao;

    return {
      netuid,
      hotkey: item.hotkey,
      coldkey: item.coldkey,
      alphaAmountRao: alphaAmount.toString(),
      taoEquivalentRao: taoEquivalent.toString(),
      emissionRao: String(item.emission),
      taoEmissionRao: String(item.taoEmission),
      isRegistered: Boolean(item.isRegistered),
    };
  });
}

async function summarizeWallet(api, address) {
  const freeRao = await getFreeBalance(api, address);
  const stakeInfo = await getStakeInfoForColdkey(api, address);
  const netuids = [...new Set(stakeInfo.map((item) => Number(item.netuid)))];
  const reservesByNetuid = new Map();

  if (netuids.length > 0) {
    const [taoList, alphaList] = await Promise.all([
      api.query.subtensorModule.subnetTAO.multi(netuids),
      api.query.subtensorModule.subnetAlphaIn.multi(netuids),
    ]);
    netuids.forEach((netuid, index) => {
      reservesByNetuid.set(netuid, {
        taoRao: toBigInt(taoList[index]),
        alphaRao: toBigInt(alphaList[index]),
      });
    });
  }

  const positions = stakeInfoToWalletPositions(stakeInfo, reservesByNetuid);
  const totalStakedRao = positions.reduce(
    (sum, position) => sum + BigInt(position.taoEquivalentRao),
    0n,
  );

  return {
    address,
    freeRao: freeRao.toString(),
    totalStakedTaoEquivalentRao: totalStakedRao.toString(),
    totalHoldingsRao: (freeRao + totalStakedRao).toString(),
    positions,
  };
}

function findWalletPosition(summary, hotkey, netuid) {
  return summary.positions.find(
    (position) => position.hotkey === hotkey && Number(position.netuid) === netuid,
  );
}

async function getCurrentPositionTaoEquivalent(api, coldkey, hotkey, netuid) {
  const summary = await summarizeWallet(api, coldkey);
  const position = findWalletPosition(summary, hotkey, netuid);
  return {
    summary,
    position,
    taoEquivalentRao: position ? BigInt(position.taoEquivalentRao) : 0n,
    alphaAmountRao: position ? BigInt(position.alphaAmountRao) : 0n,
  };
}

async function enableSubtokenIfNeeded(api, signer, netuid, txLog) {
  const enabled = await api.query.subtensorModule.subtokenEnabled(netuid);
  if (Boolean(enabled.valueOf())) {
    return false;
  }
  if (!api.tx?.sudo?.sudo || !api.tx?.system?.setStorage) {
    throw new Error('root subtoken is disabled and sudo.system.setStorage is unavailable');
  }

  const key = api.query.subtensorModule.subtokenEnabled.key(netuid).toString();
  const value = api.registry.createType('bool', true).toHex();
  const inner = api.tx.system.setStorage([[key, value]]);
  const receipt = await signAndSend(api, api.tx.sudo.sudo(inner), signer.pair, 'sudo.system.setStorage');

  txLog.push({
    kind: 'sudo.system.setStorage',
    txHash: receipt.txHash,
    blockNumber: receipt.blockNumber,
    key,
    value,
    netuid,
  });
  return true;
}

async function forceSubnetReserves(api, signer, netuid, targetTaoRao, targetAlphaInRao, txLog) {
  if (!api.tx?.sudo?.sudo || !api.tx?.system?.setStorage) {
    throw new Error('forced subnet reserve seeding requested but sudo.system.setStorage is unavailable');
  }

  const currentTao = await api.query.subtensorModule.subnetTAO(netuid);
  const currentAlpha = await api.query.subtensorModule.subnetAlphaIn(netuid);
  const entries = [
    [
      api.query.subtensorModule.subnetTAO.key(netuid).toString(),
      encodeStorageValue(api.registry.createType(currentTao.toRawType(), targetTaoRao)),
    ],
    [
      api.query.subtensorModule.subnetAlphaIn.key(netuid).toString(),
      encodeStorageValue(api.registry.createType(currentAlpha.toRawType(), targetAlphaInRao)),
    ],
  ];

  const receipt = await signAndSend(
    api,
    api.tx.sudo.sudo(api.tx.system.setStorage(entries)),
    signer.pair,
    `sudo.system.setStorage(subnet reserves ${netuid})`,
  );

  txLog.push({
    kind: 'sudo.system.setStorage',
    netuid,
    txHash: receipt.txHash,
    blockNumber: receipt.blockNumber,
    reserves: {
      taoRao: targetTaoRao.toString(),
      alphaRao: targetAlphaInRao.toString(),
    },
  });

  return querySubnetSnapshot(api, netuid);
}

async function forceSubnetLockCost(api, signer, targetLockCostRao, txLog) {
  if (!targetLockCostRao) {
    return false;
  }
  if (!api.tx?.sudo?.sudo || !api.tx?.system?.setStorage) {
    throw new Error('forced subnet lock cost requested but sudo.system.setStorage is unavailable');
  }

  const entries = [];
  for (const item of [
    { label: 'networkLastLockCost', query: api.query.subtensorModule.networkLastLockCost },
    { label: 'networkMinLockCost', query: api.query.subtensorModule.networkMinLockCost },
  ]) {
    const current = await item.query();
    const currentValue = toBigInt(current);
    if (currentValue === targetLockCostRao) {
      continue;
    }
    entries.push([
      item.query.key().toString(),
      encodeStorageValue(api.registry.createType(current.toRawType(), targetLockCostRao)),
    ]);
  }

  if (entries.length === 0) {
    return false;
  }

  const receipt = await signAndSend(
    api,
    api.tx.sudo.sudo(api.tx.system.setStorage(entries)),
    signer.pair,
    'sudo.system.setStorage(lock-cost)',
  );

  txLog.push({
    kind: 'sudo.system.setStorage',
    label: 'forceSubnetLockCost',
    txHash: receipt.txHash,
    blockNumber: receipt.blockNumber,
    targetLockCostRao: targetLockCostRao.toString(),
  });

  return true;
}

async function maybeStartSubnet(api, controller, netuid, txLog) {
  const snapshot = await querySubnetSnapshot(api, netuid);
  if (snapshot.firstEmissionBlockNumber !== null || snapshot.owner !== controller.address) {
    return snapshot;
  }
  const receipt = await signAndSend(
    api,
    api.tx.subtensorModule.startCall(netuid),
    controller.pair,
    `subtensorModule.startCall(${netuid})`,
  );
  txLog.push({
    kind: 'subtensorModule.startCall',
    netuid,
    txHash: receipt.txHash,
    blockNumber: receipt.blockNumber,
  });
  return querySubnetSnapshot(api, netuid);
}

function reportSkeleton(manifest, runtime, rpcUrl) {
  return {
    status: 'seeding',
    generatedAt: new Date().toISOString(),
    manifestPath: MANIFEST_PATH,
    rpcUrl,
    runtime,
    txLog: [],
    controller: null,
    pureProxy: null,
    addresses: {},
    proxyLinks: [],
    wallets: {},
    subnets: [],
  };
}

module.exports = {
  MANIFEST_PATH,
  PROJECT_ROOT,
  RAO_PER_TAO,
  REPORT_PATH,
  assertRuntimeContract,
  connectApi,
  decimalToScaledBigInt,
  decodeDispatchError,
  deriveAccounts,
  enableSubtokenIfNeeded,
  ensureBalance,
  ensureBalanceFromFunders,
  ensureBalanceViaSudo,
  forceSubnetReserves,
  forceSubnetLockCost,
  findWalletPosition,
  formatTao,
  getCurrentPositionTaoEquivalent,
  getFreeBalance,
  getOrCreatePureProxy,
  getSubnetTargetAlphaInRao,
  getSubnetTargetPrice,
  getSubnetTargetPriceScaled,
  getSubnetTargetTaoRao,
  getStakeInfoForColdkey,
  hasProxyDelegation,
  isBenignAlreadyExists,
  isNetworkMember,
  loadManifest,
  loadReport,
  maybeStartSubnet,
  normalizeError,
  priceTolerance,
  queryExistingNetuids,
  querySubnetSnapshot,
  ratioFromReserves,
  readJson,
  reportSkeleton,
  reserveTolerance,
  saveReport,
  signAndSend,
  sleep,
  summarizeWallet,
  toBigInt,
  waitForBlockProgress,
  withinBps,
  writeJson,
};
