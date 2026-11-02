import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync, existsSync, chmodSync } from 'node:fs';
import { homedir, userInfo } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = dirname(fileURLToPath(import.meta.url));
const IMAGE = 'quanticdata-n8n-search-adapter:0.1.0';

export function selectNetwork(networks, selected) {
  const names = Object.keys(networks).filter(n => !['host', 'none', 'bridge'].includes(n));
  if (selected) {
    if (!names.includes(selected)) throw Error('The selected network is not attached to n8n.');
    return selected;
  }
  if (names.length === 1) return names[0];
  const defaults = names.filter(n => n.endsWith('_default'));
  if (defaults.length === 1) return defaults[0];
  throw Error('Select a user-defined n8n network with --network NAME.');
}

function docker(args) {
  return execFileSync('docker', args, { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

async function readKey() {
  if (process.env.QUANTICDATA_API_KEY) return process.env.QUANTICDATA_API_KEY.trim();
  if (!process.stdin.isTTY || !process.stdin.setRawMode) throw Error('Run in an interactive terminal or set QUANTICDATA_API_KEY.');
  process.stdout.write('QuanticData API key (input hidden): ');
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.setEncoding('utf8');
  return new Promise((resolve, reject) => {
    let key = '';
    function done(error) {
      process.stdin.off('data', onData);
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdout.write('\n');
      error ? reject(error) : resolve(key.trim());
    }
    function onData(data) {
      for (const char of data) {
        if (char === '\u0003') return done(new Error('Setup cancelled.'));
        if (char === '\r' || char === '\n') return done();
        if (char === '\u007f' || char === '\b') key = key.slice(0, -1);
        else if (char >= ' ' && char !== '\u001b') key += char;
      }
    }
    process.stdin.on('data', onData);
  });
}

function protectDirectory(dir) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (process.platform === 'win32') {
    const account = process.env.USERDOMAIN ? `${process.env.USERDOMAIN}\\${userInfo().username}` : userInfo().username;
    execFileSync('icacls.exe', [dir, '/inheritance:r', '/grant:r', `${account}:(OI)(CI)F`, '*S-1-5-18:(OI)(CI)F'], { windowsHide: true, stdio: 'pipe' });
  } else chmodSync(dir, 0o700);
}

export async function main(args = process.argv.slice(2)) {
  const opt = name => {
    const i = args.indexOf(name);
    if (i < 0) return undefined;
    if (!args[i + 1] || args[i + 1].startsWith('--')) throw Error(`Missing value for ${name}`);
    return args[i + 1];
  };
  if (args.includes('--help')) {
    console.log('node setup.mjs [--n8n CONTAINER] [--network NETWORK] [--check]\nRequires Node.js 22+, Docker in Linux-container mode and an existing running n8n container.');
    return;
  }
  if (Number(process.versions.node.split('.')[0]) < 22) throw Error('Install Node.js 22 or later.');
  let rows;
  try { rows = docker(['ps', '--format', '{{json .}}']).split('\n').filter(Boolean).map(s => JSON.parse(s)); }
  catch { throw Error('Docker is not available. Start Docker Desktop or Docker Engine and retry.'); }
  const named = opt('--n8n');
  const candidates = rows.filter(r => named ? r.Names === named : /(?:^|\/)n8n(?::|@|$)/.test(r.Image));
  if (candidates.length !== 1) throw Error('Select your running n8n container with: node setup.mjs --n8n CONTAINER');
  const instance = JSON.parse(docker(['inspect', candidates[0].ID]))[0];
  const network = selectNetwork(instance.NetworkSettings.Networks, opt('--network'));
  const networkInfo = JSON.parse(docker(['network', 'inspect', network]))[0];
  const attachedIds = Object.keys(networkInfo.Containers ?? {});
  const attached = attachedIds.length ? JSON.parse(docker(['inspect', ...attachedIds])) : [];
  const existing = attached.find(c => {
    const n = c.NetworkSettings.Networks[network];
    return c.Name === '/quanticdata-search' || (n?.Aliases ?? []).includes('quanticdata-search') || (n?.DNSNames ?? []).includes('quanticdata-search');
  });
  console.log(`n8n: ${candidates[0].Names}\nDocker network: ${network}`);
  if (existing) {
    if (!existing.Config.Image.startsWith('quanticdata-n8n-search-adapter:')) throw Error('The quanticdata-search network name is already used by another service.');
    console.log('A QuanticData search adapter is already attached. No changes made.');
    printConnection();
    return;
  }
  if (args.includes('--check')) {
    console.log('Preflight passed. No containers or files changed.');
    return;
  }
  const key = await readKey();
  if (!key || /[\r\n\x00-\x1f]/.test(key)) throw Error('A valid API key is required.');
  const state = join(homedir(), '.quanticdata-n8n-search', instance.Id.slice(0, 12));
  protectDirectory(state);
  const keyFile = join(state, 'api-key.env');
  if (existsSync(keyFile)) throw Error('A previous key file exists. Review the previous installation before replacing it.');
  writeFileSync(keyFile, 'QUANTICDATA_API_KEY=' + key + '\n', { mode: 0o600, flag: 'wx' });
  console.log('Building the adapter. Your n8n container will not be restarted.');
  const build = spawnSync('docker', ['build', '-t', IMAGE, ROOT], { windowsHide: true, stdio: 'inherit' });
  if (build.status !== 0) throw Error('Docker build failed. The private key file was retained for review.');
  const name = `quanticdata-search-${instance.Id.slice(0, 12)}`;
  docker(['run', '-d', '--name', name, '--restart', 'unless-stopped', '--network', network,
    '--network-alias', 'quanticdata-search', '--read-only', '--cap-drop', 'ALL',
    '--security-opt', 'no-new-privileges:true', '--pids-limit', '64', '--memory', '128m', '--cpus', '0.5',
    '--env-file', keyFile, IMAGE]);
  let healthy = false;
  for (let attempt = 0; attempt < 15; attempt++) {
    try {
      docker(['exec', name, 'node', '-e', "fetch('http://127.0.0.1:8080/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]);
      healthy = true; break;
    } catch { await new Promise(resolve => setTimeout(resolve, 1000)); }
  }
  if (!healthy) throw Error(`Adapter started but is not healthy. Inspect container ${name}.`);
  console.log(`Adapter ready. To stop it: docker stop ${name}`);
  printConnection();
}

function printConnection() {
  console.log('\nn8n Assistant > Web search > SearXNG\nInstance URL: http://quanticdata-search:8080\nSave, then test a public documentation query.');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    // child_process errors can contain command arguments: never print their output.
    console.error(error?.status !== undefined ? 'Setup command failed. Check Docker and local file permissions.' : error.message);
    process.exitCode = 1;
  });
}
