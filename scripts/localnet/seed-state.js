#!/usr/bin/env node

const {
  assertRuntimeContract,
  connectApi,
  deriveAccounts,
  enableSubtokenIfNeeded,
  ensureBalanceFromFunders,
  ensureBalanceViaSudo,
  forceSubnetReserves,
  formatTao,
  forceSubnetLockCost,
  getCurrentPositionTaoEquivalent,
  getOrCreatePureProxy,
  getSubnetTargetAlphaInRao,
  getSubnetTargetPrice,
  getSubnetTargetTaoRao,
  hasProxyDelegation,
  isBenignAlreadyExists,
  isNetworkMember,
  loadManifest,
  loadReport,
  maybeStartSubnet,
  normalizeError,
  queryExistingNetuids,
  querySubnetSnapshot,
  reportSkeleton,
  saveReport,
  signAndSend,
  summarizeWallet,
  toBigInt,
  waitForBlockProgress,
} = require('./common');

async function addProxyIfMissing(api, delegator, pureProxyAddress, manifest, txLog) {
  const exists = await hasProxyDelegation(
    api,
    delegator.address,
    pureProxyAddress,
    manifest.proxy.delegatorProxyType,
  );
  if (exists) {
    return;
  }

  const receipt = await signAndSend(
    api,
    api.tx.proxy.addProxy(
      pureProxyAddress,
      manifest.proxy.delegatorProxyType,
      manifest.proxy.delay,
    ),
    delegator.pair,
    `proxy.addProxy(${delegator.label})`,
  );

  txLog.push({
    kind: 'proxy.addProxy',
    delegator: delegator.label,
    delegate: pureProxyAddress,
    txHash: receipt.txHash,
    blockNumber: receipt.blockNumber,
  });
}

async function registerSubnet(api, controller, sudoSigner, manifest, netuid, hotkey, label, txLog) {
  const existing = await queryExistingNetuids(api);
  if (existing.includes(netuid)) {
    return;
  }

  if (manifest.network.forcedSubnetLockCostRao) {
    await forceSubnetLockCost(
      api,
      sudoSigner,
      toBigInt(manifest.network.forcedSubnetLockCostRao),
      txLog,
    );
  }

  const receipt = await signAndSend(
    api,
    api.tx.subtensorModule.registerNetwork(hotkey.address),
    controller.pair,
    `subtensorModule.registerNetwork(${label})`,
  );
  txLog.push({
    kind: 'subtensorModule.registerNetwork',
    netuid,
    hotkey: hotkey.address,
    label,
    txHash: receipt.txHash,
    blockNumber: receipt.blockNumber,
  });

  const after = await queryExistingNetuids(api);
  const created = after.find((value) => !existing.includes(value));
  if (created !== netuid) {
    throw new Error(
      `expected subnet ${netuid} to be created for ${label}, but observed ${created}`,
    );
  }
}

async function setSubnetIdentity(api, controller, subnet, txLog) {
  const snapshot = await querySubnetSnapshot(api, subnet.netuid);
  if (snapshot.owner !== controller.address) {
    return;
  }

  const receipt = await signAndSend(
    api,
    api.tx.subtensorModule.setSubnetIdentity(
      subnet.netuid,
      subnet.label,
      'https://github.com/opentensor/subtensor',
      'localnet@trustedstake.local',
      `https://localnet/${subnet.label}`,
      'trustedstake-localnet',
      `Seeded subnet ${subnet.label}`,
      `https://localnet/assets/${subnet.label}.png`,
      '',
    ),
    controller.pair,
    `subtensorModule.setSubnetIdentity(${subnet.netuid})`,
  );

  txLog.push({
    kind: 'subtensorModule.setSubnetIdentity',
    netuid: subnet.netuid,
    txHash: receipt.txHash,
    blockNumber: receipt.blockNumber,
  });
}

async function ensureSubnetValidator(api, controller, netuid, hotkey, txLog) {
  if (await isNetworkMember(api, netuid, hotkey.address)) {
    return;
  }

  try {
    const receipt = await signAndSend(
      api,
      api.tx.subtensorModule.burnedRegister(netuid, hotkey.address),
      controller.pair,
      `subtensorModule.burnedRegister(${netuid}, ${hotkey.label})`,
    );
    txLog.push({
      kind: 'subtensorModule.burnedRegister',
      netuid,
      hotkey: hotkey.address,
      txHash: receipt.txHash,
      blockNumber: receipt.blockNumber,
    });
  } catch (error) {
    if (!isBenignAlreadyExists(error)) {
      throw error;
    }
  }
}

async function ensureRootHotkey(api, controller, rootHotkey, txLog) {
  if (await isNetworkMember(api, 0, rootHotkey.address)) {
    return;
  }
  try {
    const receipt = await signAndSend(
      api,
      api.tx.subtensorModule.rootRegister(rootHotkey.address),
      controller.pair,
      'subtensorModule.rootRegister',
    );
    txLog.push({
      kind: 'subtensorModule.rootRegister',
      hotkey: rootHotkey.address,
      txHash: receipt.txHash,
      blockNumber: receipt.blockNumber,
    });
  } catch (error) {
    if (!isBenignAlreadyExists(error)) {
      throw error;
    }
  }
}

async function addStakeUpTo(api, signer, hotkeyAddress, netuid, targetTaoRao, txLog, label) {
  const current = await getCurrentPositionTaoEquivalent(
    api,
    signer.address,
    hotkeyAddress,
    netuid,
  );
  if (current.taoEquivalentRao >= targetTaoRao) {
    return current;
  }

  const amountToAdd = targetTaoRao - current.taoEquivalentRao;
  const receipt = await signAndSend(
    api,
    api.tx.subtensorModule.addStake(hotkeyAddress, netuid, amountToAdd),
    signer.pair,
    `${label}.addStake`,
  );

  txLog.push({
    kind: 'subtensorModule.addStake',
    label,
    signer: signer.address,
    hotkey: hotkeyAddress,
    netuid,
    amountRao: amountToAdd.toString(),
    txHash: receipt.txHash,
    blockNumber: receipt.blockNumber,
  });

  return getCurrentPositionTaoEquivalent(api, signer.address, hotkeyAddress, netuid);
}

async function addStakeAmount(api, signer, hotkeyAddress, netuid, amountRao, txLog, label) {
  if (amountRao <= 0n) {
    return null;
  }

  const receipt = await signAndSend(
    api,
    api.tx.subtensorModule.addStake(hotkeyAddress, netuid, amountRao),
    signer.pair,
    `${label}.addStake`,
  );

  txLog.push({
    kind: 'subtensorModule.addStake',
    label,
    signer: signer.address,
    hotkey: hotkeyAddress,
    netuid,
    amountRao: amountRao.toString(),
    txHash: receipt.txHash,
    blockNumber: receipt.blockNumber,
  });

  return receipt;
}

async function primeSubnetLiquidity(api, subnet, seeder, validatorHotkey, manifest, txLog) {
  const bootstrapStakeRao = toBigInt(manifest.liquidity.bootstrapSeederStakeRao);
  await addStakeUpTo(
    api,
    seeder,
    validatorHotkey.address,
    subnet.netuid,
    bootstrapStakeRao,
    txLog,
    `liquidity:${subnet.netuid}:bootstrap`,
  );
  return querySubnetSnapshot(api, subnet.netuid);
}

function selectSubnetIds(index, manifest) {
  return manifest.portfolio.rotationOffsets.map(
    (offset) => ((index + offset) % 15) + 2,
  );
}

async function topUpDelegatorIfNeeded(api, sudoSigner, funders, delegator, manifest, txLog) {
  const summary = await summarizeWallet(api, delegator.address);
  const targetTotal = toBigInt(manifest.funding.delegatorTargetTotalRao);
  const tolerance = toBigInt(manifest.funding.delegatorTopUpToleranceRao);
  const currentTotal = BigInt(summary.totalHoldingsRao);
  if (currentTotal + tolerance >= targetTotal) {
    return summary;
  }
  const delta = targetTotal - currentTotal;
  const targetFree = BigInt(summary.freeRao) + delta;
  if (manifest.funding.useSudoForceSetBalance) {
    await ensureBalanceViaSudo(
      api,
      sudoSigner,
      delegator.address,
      targetFree,
      txLog,
      `delegator-total-topup:${delegator.label}`,
    );
  } else {
    await ensureBalanceFromFunders(
      api,
      funders,
      delegator.address,
      targetFree,
      txLog,
      `delegator-total-topup:${delegator.label}`,
    );
  }
  return summarizeWallet(api, delegator.address);
}

async function main() {
  const manifest = loadManifest();
  const previousReport = loadReport();
  const api = await connectApi(manifest.network.rpcUrl);

  try {
    await waitForBlockProgress(api, 2, 1500);
    const runtime = assertRuntimeContract(api);
    const accounts = await deriveAccounts(manifest);
    const report = reportSkeleton(manifest, runtime, manifest.network.rpcUrl);
    const txLog = report.txLog;

    report.controller = { address: accounts.controller.address };
    report.addresses = {
      controller: accounts.controller.address,
      funders: accounts.funders.map((entry) => ({
        label: entry.label,
        address: entry.address,
      })),
      rootHotkey: accounts.validatorByNetuid.get(0).address,
      delegators: accounts.delegators.map((entry) => ({
        label: entry.label,
        address: entry.address,
      })),
      seeders: accounts.seeders.map((entry) => ({
        label: entry.label,
        address: entry.address,
      })),
      validators: [...accounts.validatorByNetuid.entries()].map(([netuid, entry]) => ({
        netuid,
        label: entry.label,
        address: entry.address,
      })),
    };

    const ensureFunding = async (address, targetRao, reason) => {
      if (manifest.funding.useSudoForceSetBalance) {
        await ensureBalanceViaSudo(
          api,
          accounts.funder,
          address,
          targetRao,
          txLog,
          reason,
        );
        return;
      }
      await ensureBalanceFromFunders(
        api,
        accounts.funders,
        address,
        targetRao,
        txLog,
        reason,
      );
    };

    await ensureFunding(
      accounts.controller.address,
      toBigInt(manifest.funding.controllerTargetFreeRao),
      'controller bootstrap',
    );

    for (const subnet of manifest.subnets) {
      const seeder = accounts.seeders[subnet.netuid - 1];
      const targetSeederFree =
        toBigInt(manifest.liquidity.bootstrapSeederStakeRao) +
        toBigInt(manifest.funding.liquiditySeederBufferRao);
      await ensureFunding(
        seeder.address,
        targetSeederFree,
        `liquidity seeder ${seeder.label}`,
      );
    }

    for (const delegator of accounts.delegators) {
      await ensureFunding(
        delegator.address,
        toBigInt(manifest.funding.delegatorTargetTotalRao),
        `delegator ${delegator.label}`,
      );
    }

    const pureProxy = await getOrCreatePureProxy(
      api,
      accounts.controller,
      manifest,
      previousReport,
      txLog,
    );
    report.pureProxy = pureProxy;

    await ensureFunding(
      pureProxy.address,
      toBigInt(manifest.funding.pureProxyTargetFreeRao),
      'pure proxy rent',
    );

    for (const delegator of accounts.delegators) {
      await addProxyIfMissing(api, delegator, pureProxy.address, manifest, txLog);
    }

    if (manifest.root.enableSubtokenViaSudo) {
      await enableSubtokenIfNeeded(api, accounts.funder, 0, txLog);
    }

    await ensureRootHotkey(
      api,
      accounts.controller,
      accounts.validatorByNetuid.get(0),
      txLog,
    );

    for (const subnet of manifest.subnets.filter((entry) => entry.netuid >= 2)) {
      await registerSubnet(
        api,
        accounts.controller,
        accounts.funder,
        manifest,
        subnet.netuid,
        accounts.validatorByNetuid.get(subnet.netuid),
        subnet.label,
        txLog,
      );
      await setSubnetIdentity(api, accounts.controller, subnet, txLog);
      await maybeStartSubnet(api, accounts.controller, subnet.netuid, txLog);
    }

    for (const subnet of manifest.subnets) {
      if (manifest.root.enableSubtokenViaSudo) {
        await enableSubtokenIfNeeded(api, accounts.funder, subnet.netuid, txLog);
      }
      await ensureSubnetValidator(
        api,
        accounts.controller,
        subnet.netuid,
        accounts.validatorByNetuid.get(subnet.netuid),
        txLog,
      );
    }

    for (const subnet of manifest.subnets) {
      await primeSubnetLiquidity(
        api,
        subnet,
        accounts.seeders[subnet.netuid - 1],
        accounts.validatorByNetuid.get(subnet.netuid),
        manifest,
        txLog,
      );
    }

    for (let index = 0; index < accounts.delegators.length; index += 1) {
      const delegator = accounts.delegators[index];
      const subnetIds = selectSubnetIds(index, manifest);
      const amounts = [...manifest.portfolio.baseStakePlanRao];
      if ((index + 1) % manifest.portfolio.overweightEvery === 0) {
        amounts[0] = (
          toBigInt(amounts[0]) + toBigInt(manifest.portfolio.overweightExtraRao)
        ).toString();
      }

      for (let positionIndex = 0; positionIndex < subnetIds.length; positionIndex += 1) {
        const netuid = subnetIds[positionIndex];
        const targetRao = toBigInt(amounts[positionIndex]);
        await addStakeUpTo(
          api,
          delegator,
          accounts.validatorByNetuid.get(netuid).address,
          netuid,
          targetRao,
          txLog,
          `${delegator.label}:sn${netuid}`,
        );
      }

      if (index < manifest.root.rootStakeDelegatorCount) {
        await addStakeUpTo(
          api,
          delegator,
          accounts.validatorByNetuid.get(0).address,
          0,
          toBigInt(manifest.root.rootStakePerDelegatorRao),
          txLog,
          `${delegator.label}:root`,
        );
      }
    }

    report.subnets = [];
    for (const subnet of manifest.subnets) {
      const snapshot = manifest.liquidity.useSudoSetReserves
        ? await forceSubnetReserves(
          api,
          accounts.funder,
          subnet.netuid,
          getSubnetTargetTaoRao(subnet),
          getSubnetTargetAlphaInRao(subnet),
          txLog,
        )
        : await querySubnetSnapshot(api, subnet.netuid);
      report.subnets.push({
        netuid: subnet.netuid,
        label: subnet.label,
        depthTier: subnet.depthTier,
        targetPoolTao: subnet.targetPoolTao,
        targetAlphaPriceTao: subnet.targetAlphaPriceTao,
        validatorHotkey: accounts.validatorByNetuid.get(subnet.netuid).address,
        taoRao: snapshot.taoRao.toString(),
        alphaRao: snapshot.alphaRao.toString(),
        impliedPrice: snapshot.impliedPrice,
        targetImpliedPrice: getSubnetTargetPrice(subnet),
        owner: snapshot.owner,
        ownerHotkey: snapshot.ownerHotkey,
        firstEmissionBlockNumber: snapshot.firstEmissionBlockNumber,
      });
    }

    for (const delegator of accounts.delegators) {
      await topUpDelegatorIfNeeded(
        api,
        accounts.funder,
        accounts.funders,
        delegator,
        manifest,
        txLog,
      );
    }

    report.proxyLinks = accounts.delegators.map((delegator) => ({
      delegator: delegator.address,
      pureProxy: pureProxy.address,
      proxyType: manifest.proxy.delegatorProxyType,
      delay: manifest.proxy.delay,
    }));

    report.wallets.controller = await summarizeWallet(api, accounts.controller.address);
    report.wallets.delegators = [];
    for (const delegator of accounts.delegators) {
      report.wallets.delegators.push({
        label: delegator.label,
        ...(await summarizeWallet(api, delegator.address)),
      });
    }
    report.wallets.seeders = [];
    for (const seeder of accounts.seeders) {
      report.wallets.seeders.push({
        label: seeder.label,
        ...(await summarizeWallet(api, seeder.address)),
      });
    }

    report.status = 'seeded';
    report.generatedAt = new Date().toISOString();
    saveReport(report);

    const totalDelegatorHoldings = report.wallets.delegators.reduce(
      (sum, wallet) => sum + BigInt(wallet.totalHoldingsRao),
      0n,
    );
    console.log(
      `Seeded localnet with ${report.wallets.delegators.length} delegators, pure proxy ${pureProxy.address}, total delegator holdings ${formatTao(totalDelegatorHoldings)}`,
    );
  } finally {
    await api.disconnect();
  }
}

main().catch((error) => {
  console.error(normalizeError(error));
  process.exit(1);
});
