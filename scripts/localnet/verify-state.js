#!/usr/bin/env node

const {
  RAO_PER_TAO,
  assertRuntimeContract,
  connectApi,
  deriveAccounts,
  formatTao,
  getSubnetTargetPrice,
  getSubnetTargetPriceScaled,
  getSubnetTargetTaoRao,
  hasProxyDelegation,
  isNetworkMember,
  loadManifest,
  loadReport,
  queryExistingNetuids,
  querySubnetSnapshot,
  reportSkeleton,
  reserveTolerance,
  saveReport,
  sleep,
  summarizeWallet,
  toBigInt,
  waitForBlockProgress,
  withinBps,
  priceTolerance,
} = require('./common');

function fail(message) {
  throw new Error(message);
}

async function collectValidatorStake(wallets, validatorHotkey, netuid) {
  return wallets.reduce((sum, wallet) => {
    const position = wallet.positions.find(
      (entry) => entry.hotkey === validatorHotkey && Number(entry.netuid) === netuid,
    );
    return sum + BigInt(position ? position.alphaAmountRao : '0');
  }, 0n);
}

function distinctPriceBands(subnets) {
  const bands = new Set(
    subnets
      .map((subnet) => subnet.impliedPrice)
      .filter((value) => Number.isFinite(value) && value > 0)
      .map((value) => (Math.round(value * 1000) / 1000).toFixed(3)),
  );
  return bands.size;
}

async function main() {
  const manifest = loadManifest();
  const prior = loadReport();
  if (!prior?.pureProxy?.address) {
    fail('state-report.json does not contain a pure proxy address. Run localnet:seed first.');
  }

  const api = await connectApi(manifest.network.rpcUrl);
  try {
    await waitForBlockProgress(api, 2, 1500);
    const runtime = assertRuntimeContract(api);
    const accounts = await deriveAccounts(manifest);
    const report = reportSkeleton(manifest, runtime, manifest.network.rpcUrl);
    report.txLog = Array.isArray(prior.txLog) ? prior.txLog : [];
    report.pureProxy = prior.pureProxy;

    const pureProxyValid = await hasProxyDelegation(
      api,
      prior.pureProxy.address,
      accounts.controller.address,
      manifest.proxy.pureProxyType,
    );
    if (!pureProxyValid) {
      fail(`pure proxy ${prior.pureProxy.address} is not controlled by ${accounts.controller.address}`);
    }

    const proxyChecks = [];
    for (const delegator of accounts.delegators) {
      const ok = await hasProxyDelegation(
        api,
        delegator.address,
        prior.pureProxy.address,
        manifest.proxy.delegatorProxyType,
      );
      if (!ok) {
        fail(`delegator ${delegator.address} is missing its Staking proxy to ${prior.pureProxy.address}`);
      }
      proxyChecks.push({
        delegator: delegator.address,
        pureProxy: prior.pureProxy.address,
        proxyType: manifest.proxy.delegatorProxyType,
      });
    }

    const netuids = await queryExistingNetuids(api);
    for (let expected = 0; expected <= 16; expected += 1) {
      if (!netuids.includes(expected)) {
        fail(`expected subnet ${expected} to exist, but observed [${netuids.join(', ')}]`);
      }
    }

    const walletSummaries = {
      controller: await summarizeWallet(api, accounts.controller.address),
      delegators: [],
      seeders: [],
    };

    for (const delegator of accounts.delegators) {
      walletSummaries.delegators.push({
        label: delegator.label,
        ...(await summarizeWallet(api, delegator.address)),
      });
    }

    for (const seeder of accounts.seeders) {
      walletSummaries.seeders.push({
        label: seeder.label,
        ...(await summarizeWallet(api, seeder.address)),
      });
    }

    if (walletSummaries.delegators.length !== 20) {
      fail(`expected 20 delegators, found ${walletSummaries.delegators.length}`);
    }

    const expectedDelegatorTotal =
      BigInt(accounts.delegators.length) * toBigInt(manifest.funding.delegatorTargetTotalRao);
    const actualDelegatorTotal = walletSummaries.delegators.reduce(
      (sum, wallet) => sum + BigInt(wallet.totalHoldingsRao),
      0n,
    );
    const tolerance = toBigInt(manifest.verification.delegatorTotalToleranceRao);
    const delta =
      actualDelegatorTotal > expectedDelegatorTotal
        ? actualDelegatorTotal - expectedDelegatorTotal
        : expectedDelegatorTotal - actualDelegatorTotal;
    if (delta > tolerance) {
      fail(
        `delegator holdings drifted too far from target: expected ${formatTao(expectedDelegatorTotal)}, got ${formatTao(actualDelegatorTotal)}`,
      );
    }

    const subnets = [];
    for (const subnet of manifest.subnets) {
      const snapshot = await querySubnetSnapshot(api, subnet.netuid);
      if (snapshot.taoRao <= 0n || snapshot.alphaRao <= 0n) {
        fail(`subnet ${subnet.netuid} has zero reserves`);
      }

      const expectedTaoRao = getSubnetTargetTaoRao(subnet);
      if (!withinBps(snapshot.taoRao, expectedTaoRao, reserveTolerance(manifest))) {
        fail(
          `subnet ${subnet.netuid} tao reserve drifted: expected ${formatTao(expectedTaoRao)}, got ${formatTao(snapshot.taoRao)}`,
        );
      }

      const actualPriceScaled = (snapshot.taoRao * RAO_PER_TAO) / snapshot.alphaRao;
      const expectedPriceScaled = getSubnetTargetPriceScaled(subnet);
      if (!withinBps(actualPriceScaled, expectedPriceScaled, priceTolerance(manifest))) {
        fail(
          `subnet ${subnet.netuid} alpha price drifted: expected ${getSubnetTargetPrice(subnet).toFixed(6)} TAO, got ${snapshot.impliedPrice.toFixed(6)} TAO`,
        );
      }

      const validatorHotkey = accounts.validatorByNetuid.get(subnet.netuid).address;
      const member = await isNetworkMember(api, subnet.netuid, validatorHotkey);
      if (!member) {
        fail(`validator hotkey ${validatorHotkey} is not registered on subnet ${subnet.netuid}`);
      }

      const alphaBackedStake =
        (await collectValidatorStake(walletSummaries.delegators, validatorHotkey, subnet.netuid)) +
        (await collectValidatorStake(walletSummaries.seeders, validatorHotkey, subnet.netuid)) +
        BigInt(
          walletSummaries.controller.positions
            .find((position) => position.hotkey === validatorHotkey && Number(position.netuid) === subnet.netuid)
            ?.alphaAmountRao || '0',
        );

      if (alphaBackedStake <= 0n) {
        fail(`validator hotkey ${validatorHotkey} on subnet ${subnet.netuid} has zero tracked stake`);
      }

      subnets.push({
        netuid: subnet.netuid,
        label: subnet.label,
        depthTier: subnet.depthTier,
        targetPoolTao: subnet.targetPoolTao,
        targetAlphaPriceTao: subnet.targetAlphaPriceTao,
        validatorHotkey,
        taoRao: snapshot.taoRao.toString(),
        alphaRao: snapshot.alphaRao.toString(),
        impliedPrice: snapshot.impliedPrice,
        owner: snapshot.owner,
        ownerHotkey: snapshot.ownerHotkey,
        firstEmissionBlockNumber: snapshot.firstEmissionBlockNumber,
        totalTrackedValidatorAlphaRao: alphaBackedStake.toString(),
      });
    }

    const rootWallets = walletSummaries.delegators.filter((wallet) =>
      wallet.positions.some((position) => Number(position.netuid) === 0),
    );
    if (rootWallets.length < 1) {
      fail('expected at least one delegator to hold root stake (netuid 0)');
    }

    const taoReserves = subnets.map((subnet) => BigInt(subnet.taoRao));
    const maxTao = taoReserves.reduce((max, value) => (value > max ? value : max), 0n);
    const minTao = taoReserves.reduce((min, value) => (min === 0n || value < min ? value : min), 0n);
    if (minTao === 0n || maxTao < minTao * 10n) {
      fail(`liquidity variance check failed: max/min subnetTAO < 10x (${maxTao}/${minTao})`);
    }

    const priceBands = distinctPriceBands(subnets);
    if (priceBands < 4) {
      fail(`expected at least 4 distinct price bands, observed ${priceBands}`);
    }

    report.status = 'verified';
    report.generatedAt = new Date().toISOString();
    report.controller = { address: accounts.controller.address };
    report.addresses = {
      controller: accounts.controller.address,
      pureProxy: prior.pureProxy.address,
      rootHotkey: accounts.validatorByNetuid.get(0).address,
    };
    report.proxyLinks = proxyChecks;
    report.wallets = walletSummaries;
    report.subnets = subnets;
    report.summary = {
      totalDelegatorHoldingsRao: actualDelegatorTotal.toString(),
      expectedDelegatorHoldingsRao: expectedDelegatorTotal.toString(),
      totalDelegatorHoldingsTao: Number(actualDelegatorTotal) / Number(RAO_PER_TAO),
      reserveVarianceRatio: Number(maxTao) / Number(minTao),
      distinctPriceBands: priceBands,
      rootStakeDelegatorCount: rootWallets.length,
    };

    saveReport(report);
    console.log(
      `Verified ${walletSummaries.delegators.length} delegators, pure proxy ${prior.pureProxy.address}, reserve variance ${(Number(maxTao) / Number(minTao)).toFixed(2)}x`,
    );
  } finally {
    await api.disconnect();
  }
}

main().catch((error) => {
  console.error(String(error.message || error));
  process.exit(1);
});
