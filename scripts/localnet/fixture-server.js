#!/usr/bin/env node

const fs = require('fs');
const http = require('http');
const path = require('path');
const { spawn } = require('child_process');

const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
const MANIFEST_PATH = path.join(PROJECT_ROOT, 'configs', 'localnet', 'state-manifest.json');
const REPORT_PATH = path.join(PROJECT_ROOT, 'configs', 'localnet', 'state-report.json');
const PORT = Number(process.env.FIXTURE_PORT || '9080');
const NODE_DEPS_ROOT =
  process.env.NODE_PATH ||
  path.resolve(PROJECT_ROOT, '..', 'trusted-stake-api', 'node_modules');

let activeOperation = null;
let lastOperation = null;

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function maybeReadJson(filePath) {
  if (!fs.existsSync(filePath)) {
    return null;
  }
  return readJson(filePath);
}

function jsonResponse(res, statusCode, body) {
  const payload = JSON.stringify(body, null, 2) + '\n';
  res.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

function methodNotAllowed(res) {
  jsonResponse(res, 405, { ok: false, error: 'method_not_allowed' });
}

function run(command, args, options = {}) {
  const startedAt = new Date().toISOString();
  const child = spawn(command, args, {
    cwd: PROJECT_ROOT,
    env: {
      ...process.env,
      NODE_PATH: NODE_DEPS_ROOT,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    ...options,
  });

  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => {
    stdout += chunk.toString();
  });
  child.stderr.on('data', (chunk) => {
    stderr += chunk.toString();
  });

  return new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', (code, signal) => {
      const result = {
        command: [command, ...args].join(' '),
        startedAt,
        finishedAt: new Date().toISOString(),
        code,
        signal,
        stdout: stdout.trim(),
        stderr: stderr.trim(),
      };
      if (code === 0) {
        resolve(result);
      } else {
        const error = new Error(`${result.command} exited ${code}`);
        error.result = result;
        reject(error);
      }
    });
  });
}

async function withOperation(name, fn) {
  if (activeOperation) {
    const error = new Error(`operation ${activeOperation.name} already running`);
    error.statusCode = 409;
    throw error;
  }

  const operation = {
    name,
    startedAt: new Date().toISOString(),
  };
  activeOperation = operation;
  try {
    const result = await fn();
    lastOperation = {
      ...operation,
      finishedAt: new Date().toISOString(),
      ok: true,
    };
    return result;
  } catch (error) {
    lastOperation = {
      ...operation,
      finishedAt: new Date().toISOString(),
      ok: false,
      error: error.message,
      result: error.result || null,
    };
    throw error;
  } finally {
    activeOperation = null;
  }
}

function controllerUri(manifest, label) {
  if (label === 'controller') {
    return `${manifest.wallets.controllerMnemonic}//controller`;
  }
  const suffix = label.replace('controller-', '');
  return `${manifest.wallets.controllerMnemonic}//controller//${suffix}`;
}

function liquidityProfile(depthTier) {
  if (depthTier === 'mega-deep' || depthTier === 'deep') {
    return 'deep';
  }
  if (depthTier === 'mid') {
    return 'medium';
  }
  return 'shallow';
}

function buildFixture() {
  const manifest = readJson(MANIFEST_PATH);
  const report = maybeReadJson(REPORT_PATH);
  if (!report?.pureProxy?.address || !['seeded', 'verified'].includes(report.status)) {
    const error = new Error('fixture report is not available; run POST /init first');
    error.statusCode = 409;
    throw error;
  }

  const controllerAddress = report.addresses?.controller || report.controller?.address;
  const additionalControllers = report.addresses?.additionalControllers || [];
  const delegators =
    report.addresses?.delegators?.length > 0
      ? report.addresses.delegators
      : report.wallets?.delegators || [];
  const subnets = {};
  for (const subnet of report.subnets || []) {
    subnets[String(subnet.netuid)] = {
      validatorHotkey: subnet.validatorHotkey,
      liquidityProfile: liquidityProfile(subnet.depthTier),
      depthTier: subnet.depthTier,
      label: subnet.label,
      targetPoolTao: subnet.targetPoolTao,
      targetAlphaPriceTao: subnet.targetAlphaPriceTao,
      taoRao: subnet.taoRao,
      alphaRao: subnet.alphaRao,
      impliedPrice: subnet.impliedPrice,
    };
  }

  return {
    rpcUrl: process.env.LOCALNET_PUBLIC_RPC_URL || report.rpcUrl || manifest.network.rpcUrl,
    pureProxy: report.pureProxy.address,
    controllers: {
      single: [
        {
          label: 'controller',
          uri: controllerUri(manifest, 'controller'),
          address: controllerAddress,
        },
      ],
      parallel: additionalControllers.map((controller) => ({
        label: controller.label,
        uri: controllerUri(manifest, controller.label),
        address: controller.address,
      })),
    },
    delegators: delegators.map((delegator) => ({
      label: delegator.label,
      address: delegator.address,
    })),
    subnets,
  };
}

async function resetChain() {
  if (fs.existsSync(REPORT_PATH)) {
    fs.unlinkSync(REPORT_PATH);
  }
  const reset = await run('bash', ['scripts/localnet/bootstrap-chain.sh', 'reset']);
  return { reset };
}

async function initFixture() {
  const up = await run('bash', ['scripts/localnet/bootstrap-chain.sh', 'up']);
  const seed = await run('node', ['scripts/localnet/seed-state.js']);
  const verify = await run('node', ['scripts/localnet/verify-state.js']);
  return {
    up,
    seed,
    verify,
    fixture: buildFixture(),
  };
}

async function verifyFixture() {
  const verify = await run('node', ['scripts/localnet/verify-state.js']);
  return {
    verify,
    fixture: buildFixture(),
  };
}

async function handle(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  try {
    if (url.pathname === '/health') {
      if (req.method !== 'GET') return methodNotAllowed(res);
      return jsonResponse(res, 200, {
        ok: true,
        activeOperation,
        lastOperation,
        reportAvailable: Boolean(maybeReadJson(REPORT_PATH)?.pureProxy?.address),
      });
    }

    if (url.pathname === '/fixture') {
      if (req.method !== 'GET') return methodNotAllowed(res);
      return jsonResponse(res, 200, buildFixture());
    }

    if (url.pathname === '/reset') {
      if (req.method !== 'POST') return methodNotAllowed(res);
      const result = await withOperation('reset', resetChain);
      return jsonResponse(res, 200, { ok: true, ...result });
    }

    if (url.pathname === '/init') {
      if (req.method !== 'POST') return methodNotAllowed(res);
      const result = await withOperation('init', initFixture);
      return jsonResponse(res, 200, { ok: true, ...result });
    }

    if (url.pathname === '/reset-and-init') {
      if (req.method !== 'POST') return methodNotAllowed(res);
      const result = await withOperation('reset-and-init', async () => {
        const reset = await resetChain();
        const init = await initFixture();
        return { reset, init, fixture: init.fixture };
      });
      return jsonResponse(res, 200, { ok: true, ...result });
    }

    if (url.pathname === '/verify') {
      if (req.method !== 'GET') return methodNotAllowed(res);
      const result = await withOperation('verify', verifyFixture);
      return jsonResponse(res, 200, { ok: true, ...result });
    }

    return jsonResponse(res, 404, { ok: false, error: 'not_found' });
  } catch (error) {
    return jsonResponse(res, error.statusCode || 500, {
      ok: false,
      error: error.message,
      result: error.result || null,
      activeOperation,
      lastOperation,
    });
  }
}

const server = http.createServer((req, res) => {
  handle(req, res).catch((error) => {
    jsonResponse(res, 500, { ok: false, error: error.message });
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`localnet fixture server listening on ${PORT}`);
});
