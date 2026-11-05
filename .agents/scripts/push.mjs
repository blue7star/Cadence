#!/usr/bin/env node
'use strict';
/**
 * 推送到 GitHub：自动挑一条能通的通道，都不通就把原因说清楚。
 *
 * 为什么需要这个文件：本机到 github 的通道会变，而且变的方式不止一种——
 *   1) 公司网络封 443 出站：HTTPS 直连全断（TCP 443 连不上）；
 *   2) 但同时 SSH 是活的：github.com:22 通、ssh.github.com:443 也通；
 *   3) 本地 7897 代理的**出口节点**会挂：国内站点 200、国外站点 TLS 握手失败，
 *      代理进程活着不代表能出网；
 *   4) WorkBuddy 会话还会注入 https_proxy=127.0.0.1:49381（内部代理，不转发 github）。
 * 每次手动删环境变量 + 换 -c 覆盖，既费事又容易漏掉某一层。
 *
 *   node .agents/scripts/push.mjs          探测 + 推送
 *   node .agents/scripts/push.mjs --check  只探测，不动远程
 *
 * 通道优先级：SSH（不受 443 封锁影响）→ HTTPS 直连 → HTTPS 走 7897 → HTTPS 走 SOCKS5。
 * 全部不通时，脚本会把「哪一层断了」打出来，而不是甩一句 network error。
 *
 * 2026-11-05 起公钥已加到 github 账号，SSH 是常态首选通道，remote 也已切成 SSH。
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(fileURLToPath(new URL('../../', import.meta.url)));
const CHECK_ONLY = process.argv.includes('--check');

const HTTPS_URL = 'https://github.com/blue7star/Cadence.git';
/* ~/.ssh/config 里 Host github.com 已指向 ssh.github.com:443，直接用短名即可 */
const SSH_URL = 'git@github.com:blue7star/Cadence.git';

const PROBE_TIMEOUT = 12000;
const PUSH_TIMEOUT = 180000;

/* WorkBuddy 注入的代理会盖住一切，先摘干净再按通道自己设置 */
const PROXY_ENV = ['http_proxy', 'https_proxy', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'all_proxy'];

function baseEnv() {
  const env = { ...process.env };
  for (const k of PROXY_ENV) delete env[k];
  return env;
}

function run(cmd, args, env, timeout) {
  const r = spawnSync(cmd, args, {
    cwd: ROOT,
    env,
    encoding: 'utf8',
    timeout,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const out = `${r.stdout || ''}${r.stderr || ''}`.trim();
  const timedOut = r.error && r.error.code === 'ETIMEDOUT';
  return { code: r.status, out, timedOut };
}

/* ── 通道探测 ────────────────────────────────────────────── */

/**
 * 推送只改变远端，本地 origin/main 引用要单独 fetch 才跟得上。
 * 不补这一步，`git status` 会一直显示 ahead 1 —— 明明推成功了，看着像没推。
 * 这里直接对 URL fetch 并写进 origin/main，不依赖 remote 当前配的是哪条通道。
 */
function syncRemoteRef(url) {
  run('git', ['fetch', url, 'main:refs/remotes/origin/main'], baseEnv(), PROBE_TIMEOUT);
}

function probeSsh() {
  /* github 不提供 shell，认证成功也返回 1，所以只看输出不看退出码 */
  const r = run('ssh', ['-T', '-o', 'ConnectTimeout=8', '-o', 'BatchMode=yes', 'git@github.com'],
    baseEnv(), PROBE_TIMEOUT);
  if (/successfully authenticated/i.test(r.out)) {
    const who = (/Hi ([^!]+)!/.exec(r.out) || [])[1] || '';
    return { ok: true, why: `认证为 ${who}` };
  }
  if (/Permission denied \(publickey\)/i.test(r.out)) {
    return { ok: false, why: '公钥没被 github 认（Permission denied）' };
  }
  if (r.timedOut) return { ok: false, why: '连 ssh.github.com 超时' };
  return { ok: false, why: r.out.split('\n').pop() || 'SSH 不通' };
}

function probeHttps(gitProxy, envPrefix = {}) {
  const env = { ...baseEnv(), ...envPrefix };
  const args = ['-c', `http.https://github.com.proxy=${gitProxy}`,
    'ls-remote', '--heads', HTTPS_URL];
  const r = run('git', args, env, PROBE_TIMEOUT);
  if (r.code === 0) return { ok: true, why: 'ls-remote 成功' };
  if (r.timedOut) return { ok: false, why: '连接超时' };
  const line = r.out.split('\n').find((l) => /fatal|error/i.test(l)) || r.out.split('\n').pop();
  return { ok: false, why: line || '连不上' };
}

const ROUTES = [
  {
    name: 'SSH（github.com → ssh.github.com:443）',
    kind: 'ssh',
    probe: () => probeSsh(),
  },
  {
    name: 'HTTPS 直连',
    kind: 'https',
    url: HTTPS_URL,
    probe: () => probeHttps(''),
  },
  {
    name: 'HTTPS 走 7897 代理',
    kind: 'https',
    url: HTTPS_URL,
    probe: () => probeHttps('http://127.0.0.1:7897', {
      http_proxy: 'http://127.0.0.1:7897', https_proxy: 'http://127.0.0.1:7897',
    }),
  },
  {
    name: 'HTTPS 走 7897 SOCKS5',
    kind: 'https',
    url: HTTPS_URL,
    probe: () => probeHttps('socks5h://127.0.0.1:7897'),
  },
];

/* ── 诊断：全都不通时，把断在哪一层讲明白 ─────────────────── */

function tcp(host, port) {
  /* 用 node 自带的 net 做 TCP 探测，不依赖 bash 的 /dev/tcp */
  const { createConnection } = process.getBuiltinModule('node:net');
  return new Promise((resolve) => {
    const s = createConnection({ host, port, timeout: 5000 });
    const done = (ok) => { try { s.destroy(); } catch {} resolve(ok); };
    s.on('connect', () => done(true));
    s.on('timeout', () => done(false));
    s.on('error', () => done(false));
  });
}

async function diagnose() {
  const lines = [];
  lines.push('  端口连通性：');
  for (const [host, port] of [['github.com', 443], ['github.com', 22], ['ssh.github.com', 443], ['gitee.com', 443]]) {
    lines.push(`    ${host}:${port}  ${await tcp(host, port) ? '通' : '不通'}`);
  }
  const dom = await tcp('www.baidu.com', 443);
  lines.push(`    国内对照 www.baidu.com:443  ${dom ? '通' : '不通'}`);
  lines.push('');
  lines.push('  怎么读：');
  lines.push('    · 443 不通 + 22 通 → 公司封了 HTTPS 出站，走 SSH 通道');
  lines.push('    · 国内通 + 国外全断 → 网络出口被限制，或代理节点失效（与 git 无关）');
  lines.push('    · SSH 报 Permission denied → 公钥没加到 github：');
  lines.push('        https://github.com/settings/keys  里 New SSH key，粘贴 ~/.ssh/id_ed25519.pub');
  return lines.join('\n');
}

/* ── 主流程 ──────────────────────────────────────────────── */

async function main() {
  console.log('\n[推送] Cadence\n');
  let sshOk = false;

  for (const route of ROUTES) {
    process.stdout.write(`探测 ${route.name} … `);
    const r = route.probe();
    console.log(r.ok ? `可用（${r.why}）` : `不可用（${r.why}）`);
    if (r.ok && !sshOk) {
      sshOk = true;
      if (route.kind === 'ssh') {
        if (CHECK_ONLY) { console.log('\n[通过] SSH 通道可用（--check 不动远程）\n'); return; }
        console.log(`\n用 SSH 推送 → ${SSH_URL}\n`);
        const p = run('git', ['push', SSH_URL, 'HEAD:main'], baseEnv(), PUSH_TIMEOUT);
        console.log(p.out || '（无输出）');
        if (p.code === 0) { syncRemoteRef(SSH_URL); console.log('\n[成功] 已推送到 main\n'); return; }
        console.log('\n[失败] SSH 探测通但推送失败，见上面的输出\n');
        process.exit(1);
      }
      if (CHECK_ONLY) { console.log('\n[通过] HTTPS 通道可用（--check 不动远程）\n'); return; }
      console.log(`\n用 ${route.name} 推送\n`);
      const env = route.name.includes('代理')
        ? { ...baseEnv(), http_proxy: 'http://127.0.0.1:7897', https_proxy: 'http://127.0.0.1:7897' }
        : baseEnv();
      const proxy = route.name.includes('SOCKS5') ? 'socks5h://127.0.0.1:7897'
        : route.name.includes('代理') ? 'http://127.0.0.1:7897' : '';
      const p = run('git', ['-c', `http.https://github.com.proxy=${proxy}`,
        'push', HTTPS_URL, 'HEAD:main'], env, PUSH_TIMEOUT);
      console.log(p.out || '（无输出）');
      if (p.code === 0) { syncRemoteRef(HTTPS_URL); console.log('\n[成功] 已推送到 main\n'); return; }
      console.log('\n[失败] 通道探测通但推送失败，见上面的输出\n');
      process.exit(1);
    }
  }

  console.log('\n[不通过] 四条通道全部不通\n');
  console.log(await diagnose());
  console.log('');
  process.exit(1);
}

main();
