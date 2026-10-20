const { spawn } = require('node:child_process');
const { readFile } = require('node:fs/promises');
const { join } = require('node:path');

const appDir = process.env.OMNIMOD_MARKET_APP_DIR || '/home/omniaeyu/crypto-bot';
const statusFile = process.env.OMNIMOD_MARKET_STATUS_FILE
  || '/home/omniaeyu/.omnimod-market-worker-status.json';
const workerScript = join(appDir, 'scripts', 'run-persistent-worker.sh');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function recordedWorkerPid() {
  const status = JSON.parse(await readFile(statusFile, 'utf8'));
  const pid = Number(status.processId);
  if (status.service !== 'omnimod-crypto-bot' || status.mode !== 'worker') {
    throw new Error('The status file does not describe the OmniMod market worker.');
  }
  if (!Number.isInteger(pid) || pid <= 1 || pid === process.pid) {
    throw new Error('The status file does not contain a safe worker PID.');
  }
  return pid;
}

async function processExists(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error?.code === 'ESRCH') return false;
    throw error;
  }
}

async function main() {
  let pid = 0;
  try {
    pid = await recordedWorkerPid();
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }

  if (pid && await processExists(pid)) {
    console.log(`Stopping recorded OmniMod market worker ${pid}.`);
    process.kill(pid, 'SIGTERM');
    for (let attempt = 0; attempt < 40 && await processExists(pid); attempt += 1) {
      await sleep(250);
    }
    if (await processExists(pid)) {
      throw new Error(`Worker ${pid} did not stop within 10 seconds.`);
    }
  }

  const child = spawn('/bin/sh', [workerScript], {
    cwd: appDir,
    detached: true,
    stdio: 'ignore',
    env: { ...process.env, OMNIMOD_WORKER_ONLY: '1' }
  });
  child.unref();
  console.log(`Replacement OmniMod market worker launched as ${child.pid}.`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
