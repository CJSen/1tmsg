/**
 * 全局 R2 容量保险（StorageGuard）的端到端测试。
 *
 * 为什么是端到端而不是单元测试：这个功能的价值全在「并发下也不超额」，
 * 而原子性来自 Durable Object 单线程执行 + 单条 SQL 的条件更新 —— 这两样只有
 * 真跑在 workerd 里才成立。用假 storage 写单测，测的是我自己写的模拟器，没意义。
 *
 * 断言方式：把容量上限压到 1 MiB，然后用「二分探测」精确读出计数器当前的值
 * （探测消息建了就删，不留痕迹）。这样每条断言都是确切的字节数，而不是
 * 「看起来大概没超」。
 *
 * 上限为什么要写成小数 GB：配置里的 `MAX_R2_STORAGE_GB` 支持小数，而
 * 1 MiB = 2^-10 GB = 0.0009765625 —— 2 的幂分数能被十进制**精确**表示，
 * 换算回字节不会出现 1048575 这种差一错误（见 toGb 处的注释）。
 *
 * 覆盖：
 *   1. 正常预留
 *   2. 恰好用满上限
 *   3. 超过上限 → 507 storage_capacity_reached
 *   4. 并发争抢：8×256KiB 抢 1MiB，只能成功 4 条
 *   5. release：销毁即归还
 *   6. 不可能重复释放（销毁两次、事后反复观察已销毁消息）
 *   7. 上传超时清理 → 归还（Alarm 链路）
 *   8. 阅后即焚：下载宽限期结束 → 清 R2 → 归还（Alarm 链路）
 *   9. 被容量拒绝时不留下悬空预留（拒绝后额度不变）
 *  10. 历史存量：INITIAL_RESERVED_GB 只在计数器首次建立时计入一次
 *
 * 运行：npm run test        （会自己起一个本地 wrangler dev，跑完自动关掉）
 *       PORT=9123 npm run test
 *
 * 依赖的测试专用 vars（见 src/env.ts）：MAX_R2_STORAGE_GB / INITIAL_RESERVED_GB /
 * PENDING_TTL_MS / READ_TOKEN_TTL_MS —— 前两个是运维口子，后两个只为了不用干等十分钟。
 */
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.PORT ?? 8798);
const BASE = `http://127.0.0.1:${PORT}`;
const WRANGLER = resolve(root, 'node_modules', '.bin', 'wrangler');
/**
 * 每个阶段一份独立的本地持久化目录，放在系统临时目录下（**每次运行新建**）。
 *
 * 刻意不复用 `.wrangler/state`，也不在跑之前清空任何目录：复用会让计数器带着
 * 上一轮的状态跑，断言全都失去意义；而删除目录属于破坏性操作，测试脚本不该做。
 * 新建 + 交给系统清理，最省心也更安全。
 */
const STATE_ROOT = mkdtempSync(join(tmpdir(), '1tmsg-storage-guard-'));

/** 把上限压到 1 MiB，才能用整数消息把边界卡到字节级 */
const CAP = 1024 * 1024;
/** 历史存量种子的测试值：0.5 MiB */
const SEED = 512 * 1024;
/**
 * 压缩后的上传窗口 / 下载宽限期。
 * 必须明显大于一次 measure()（约 20 个请求）的耗时 —— 否则测试自己造的探测消息
 * 会先超时，把要观察的额度一起还回去。
 */
const WINDOW_MS = 5000;
const WINDOW_WAIT = WINDOW_MS + 3500;

/**
 * 字节 → 配置里的 GB 字符串。
 * CAP 与 SEED 都是 2 的幂，除以 2^30 得到的是 2 的负幂（0.0009765625 / 0.00048828125），
 * 二进制与十进制都能精确表示；反向 `Math.floor(gb * 2^30)` 因此精确还原，不存在舍入误差。
 */
const toGb = (bytes) => String(bytes / 2 ** 30);
/** 字节 → 人看的短串，只用于日志 */
const human = (bytes) =>
  bytes >= 1024 * 1024 ? `${bytes / (1024 * 1024)} MiB` : bytes >= 1024 ? `${bytes / 1024} KiB` : `${bytes}B`;

/* ------------------------------------------------------------------ */
/* 迷你测试框架                                                        */
/* ------------------------------------------------------------------ */

let pass = 0;
let fail = 0;
const failures = [];

function check(label, ok, extra = '') {
  if (ok) {
    pass += 1;
    console.log(`  \u2713 ${label}${extra ? ` \u2014 ${extra}` : ''}`);
  } else {
    fail += 1;
    failures.push(label);
    console.log(`  \u2717 ${label}${extra ? ` \u2014 ${extra}` : ''}`);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------------------------------------------ */
/* 请求辅助                                                            */
/* ------------------------------------------------------------------ */

const b64u = (bytes) => Buffer.from(bytes).toString('base64url');
const rand = (n) => crypto.getRandomValues(new Uint8Array(n));
const att = (id, size) => ({ id, size });

/** 造一条形状合法的创建请求（内容无所谓，服务端只看形状） */
async function createMessage({ attachments = [], expiresInSeconds = 3600, maxViews = 1 } = {}) {
  const res = await fetch(`${BASE}/api/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      ciphertext: b64u(rand(32)),
      iv: b64u(rand(12)),
      salt: null,
      verifier: null,
      kdfIterations: null,
      expiresInSeconds,
      maxViews,
      attachments,
    }),
  });
  let body = null;
  try {
    body = await res.json();
  } catch {
    /* 非 JSON（边缘错误页）留空，调用方按状态码断言 */
  }
  return { status: res.status, body };
}

async function destroy(id) {
  const res = await fetch(`${BASE}/api/messages/${encodeURIComponent(id)}`, { method: 'DELETE' });
  return { status: res.status };
}

const metaOf = async (id) => (await fetch(`${BASE}/api/messages/${encodeURIComponent(id)}`)).json();

/** 探测过程中发现的异常（例如探测消息没能干净销毁），单独记账便于定位 */
const probeAnomalies = [];

/**
 * 读出计数器当前的值：二分探测「还能预留多少字节」。
 *
 * 探测消息建了就立刻销毁 —— 成功预留时销毁会把额度原样还回来，因此对被测状态无损。
 * 由于 reserve 只有一个阈值，可用字节数关于申报体积单调，二分是精确的。
 */
async function measure() {
  let lo = 0;
  let hi = CAP;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    const probe = await createMessage({ attachments: [att('probe', mid)] });
    if (probe.status === 201) {
      const del = await destroy(probe.body.id);
      if (del.status !== 200) probeAnomalies.push(`预留 ${mid}B 的探测消息销毁失败（HTTP ${del.status}）`);
      lo = mid;
    } else {
      hi = mid - 1;
    }
  }
  return { available: lo, used: CAP - lo };
}

/* ------------------------------------------------------------------ */
/* 启动 / 关闭本地 dev                                                 */
/* ------------------------------------------------------------------ */

const devLog = [];

function startDev(stateDir, vars) {
  const args = [
    'dev',
    '-c',
    'wrangler.images.jsonc',
    '--ip',
    '127.0.0.1',
    '--port',
    String(PORT),
    '--persist-to',
    stateDir,
    '--show-interactive-dev-session=false',
    '--log-level',
    'warn',
  ];
  for (const [key, value] of Object.entries(vars)) args.push('--var', `${key}:${value}`);

  const child = spawn(WRANGLER, args, { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
  for (const stream of [child.stdout, child.stderr]) {
    stream.setEncoding('utf8');
    stream.on('data', (chunk) => {
      for (const line of chunk.split('\n')) {
        if (line.trim().length > 0) devLog.push(line.trim());
      }
    });
  }
  return child;
}

/** 轮询直到能拿到 HTTP 响应（任何响应都说明 Worker 起来了） */
async function waitReady(timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await fetch(`${BASE}/api/messages/ping`);
      return true;
    } catch {
      await sleep(400);
    }
  }
  return false;
}

async function stopDev(child) {
  if (!child || child.exitCode !== null) return;
  await new Promise((done) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      done();
    }, 6000);
    child.once('exit', () => {
      clearTimeout(timer);
      done();
    });
    child.kill('SIGTERM');
  });
  // 让端口彻底释放，避免下一个阶段绑不上
  await sleep(1200);
}

/* ------------------------------------------------------------------ */
/* 阶段一：预留 / 边界 / 并发 / 释放                                    */
/* ------------------------------------------------------------------ */

async function phaseMain() {
  console.log(`\n=== A. 预留边界、并发争抢与释放（上限 ${human(CAP)}） ===`);

  const base = await measure();
  check('空计数器：可用 = 上限', base.used === 0 && base.available === CAP, `used=${base.used}`);

  /* 1) 正常预留 */
  const a = await createMessage({ attachments: [att('a1', 700_000)] });
  check('预留 700000B → 201', a.status === 201, `status=${a.status}`);
  const afterA = await measure();
  check('计数器记为 700000B', afterA.used === 700_000, `used=${afterA.used}`);

  /* 2) 恰好用满 */
  const rest = CAP - 700_000;
  const b = await createMessage({ attachments: [att('b1', rest)] });
  check(`再预留 ${rest}B 恰好用满 → 201`, b.status === 201, `status=${b.status}`);
  const full = await measure();
  check(`计数器记为上限 ${CAP}B`, full.used === CAP, `used=${full.used}`);

  /* 3) 超过上限 */
  const c = await createMessage({ attachments: [att('c1', 1)] });
  check('多 1 字节 → 507', c.status === 507, `status=${c.status}`);
  check('错误码为 storage_capacity_reached', c.body?.error === 'storage_capacity_reached', `error=${c.body?.error}`);
  const text = c.body?.message ?? '';
  check(
    '507 文案不泄露内部实现（不提上限、不提计数器）',
    text.length > 0 && !/\d/.test(text) && !/reserved|guard|usage/i.test(text),
    `message="${text}"`,
  );
  const afterReject = await measure();
  check('被拒绝不留悬空预留（仍恰好用满）', afterReject.used === CAP, `used=${afterReject.used}`);

  /* 清场：销毁后额度必须原样归还 */
  await destroy(a.body.id);
  await destroy(b.body.id);
  const cleared = await measure();
  check('两条都销毁 → 额度归零', cleared.used === 0, `used=${cleared.used}`);

  /* 4) 并发争抢：这是本次改造存在的理由 */
  const chunk = CAP / 4;
  const results = await Promise.all(
    Array.from({ length: 8 }, (_, i) => createMessage({ attachments: [att(`cc${i}`, chunk)] })),
  );
  const winners = results.filter((r) => r.status === 201);
  const rejected = results.filter((r) => r.status === 507);
  check(
    `并发 8×${chunk}B 抢 ${CAP}B：全部得到 201 或 507（无其它状态）`,
    winners.length + rejected.length === 8,
    results.map((r) => r.status).join(','),
  );
  check('恰好 4 条成功', winners.length === 4, `成功 ${winners.length} 条`);
  check('其余 4 条被 507 拒绝', rejected.length === 4, `拒绝 ${rejected.length} 条`);
  const concurrent = await measure();
  check('并发后计数恰好用满、未超额', concurrent.used === CAP, `used=${concurrent.used}`);
  for (const r of winners) await destroy(r.body.id);

  /* 5) release 恰好一次：额度不多不少 */
  const x = await createMessage({ attachments: [att('x1', 400_000)] });
  const y = await createMessage({ attachments: [att('y1', CAP - 400_000)] });
  check('两条消息占满上限', x.status === 201 && y.status === 201, `${x.status}/${y.status}`);
  const cFull = await createMessage({ attachments: [att('x2', 1)] });
  check('占满后 1B 也进不来 → 507', cFull.status === 507, `status=${cFull.status}`);

  const del1 = await destroy(x.body.id);
  check('销毁 x → 200', del1.status === 200, `status=${del1.status}`);
  const del2 = await destroy(x.body.id);
  check('再次销毁同一条 → 404（不重复释放）', del2.status === 404, `status=${del2.status}`);

  const afterX = await measure();
  check('只归还了 x 的 400000B', afterX.used === CAP - 400_000, `used=${afterX.used}`);

  const tooBig = await createMessage({ attachments: [att('x3', CAP - 400_000 + 1)] });
  check('再多要 1 字节就被拒 → 507（证明没有多还）', tooBig.status === 507, `status=${tooBig.status}`);

  /* 已销毁消息再被观察（消费 / 读元数据）都不应该再次释放 */
  await fetch(`${BASE}/api/messages/${x.body.id}/consume`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  });
  await metaOf(x.body.id);
  const afterObserve = await measure();
  check('重复观察已销毁消息后额度不变', afterObserve.used === CAP - 400_000, `used=${afterObserve.used}`);

  // 先把「此刻恰好还剩 400000B」钉死，再看下一次要同样大小能不能拿到 ——
  // 这样一旦计数漂移，失败信息会直接指向漂移本身，而不是一个孤立的 507
  const beforeW = await measure();
  check('创建前再确认一次：恰好还剩 400000B', beforeW.available === 400_000, `available=${beforeW.available}`);
  const w = await createMessage({ attachments: [att('x4', 400_000)] });
  check('此时再要 400000B → 201', w.status === 201, `status=${w.status}`);
  const wOver = await createMessage({ attachments: [att('x5', 1)] });
  check('再度用满后 1B 也被拒 → 507', wOver.status === 507, `status=${wOver.status}`);

  /* 纯文字消息不占容量：已满也照样能发 */
  const plain = await createMessage({ attachments: [] });
  check('容量已满时纯文字消息仍可创建 → 201', plain.status === 201, `status=${plain.status}`);
  check('纯文字消息不下发 uploadToken', plain.body?.uploadToken === null);

  await destroy(y.body.id);
  if (w.status === 201) await destroy(w.body.id);
  if (wOver.status === 201) await destroy(wOver.body.id);
  await destroy(plain.body.id);
  const final = await measure();
  check('全部销毁后额度归零（无泄漏、无负值）', final.used === 0, `used=${final.used}`);
}

/* ------------------------------------------------------------------ */
/* 阶段二：上传超时 / 阅后即焚 —— 清理即归还                            */
/* ------------------------------------------------------------------ */

async function phaseTiming() {
  console.log(`\n=== B. 超时清理与阅后即焚都会归还额度（窗口 ${WINDOW_MS}ms） ===`);

  /*
   * 注意这一段不能用「另建一条带附件的消息占住剩余额度」来观察：
   * 在这个阶段上传窗口只有几秒，那条消息自己也会超时作废、把额度还回去。
   * 所以一律用 measure() 读计数器。
   */

  /* 7) pending 超时：客户端传了一半就跑了 */
  const reserved = 400_000;
  const p = await createMessage({ attachments: [att('p1', 200_000), att('p2', 200_000)] });
  check(`创建带 2 张图的消息（预留 ${reserved}B）→ 201`, p.status === 201, `status=${p.status}`);
  await fetch(`${BASE}/api/messages/${p.body.id}/att/p1`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${p.body.uploadToken}` },
    body: rand(64),
  });
  check('上传窗口内额度被占着', (await measure()).used === reserved);
  const blocked = await createMessage({ attachments: [att('p3', CAP - reserved + 1)] });
  check('窗口内再多要 1 字节会被拒 → 507', blocked.status === 507, `status=${blocked.status}`);

  await sleep(WINDOW_WAIT);

  const pMeta = await metaOf(p.body.id);
  check('上传窗口结束后消息作废', pMeta.status === 'destroyed', `status=${pMeta.status}`);
  const pLate = await fetch(`${BASE}/api/messages/${p.body.id}/consume`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  });
  check('超时后 consume → 410', pLate.status === 410, `status=${pLate.status}`);

  const released = await measure();
  check(`超时清理把整份 ${reserved}B 预留还了回来`, released.used === 0, `used=${released.used}`);
  const full = await createMessage({ attachments: [att('p4', CAP)] });
  check('腾出的额度可以立刻用满 → 201', full.status === 201, `status=${full.status}`);
  await destroy(full.body.id);
  check('清场后归零', (await measure()).used === 0);

  /* 8) 阅后即焚：销毁后还有一段下载宽限期，宽限期结束才归还 */
  const r = await createMessage({ attachments: [att('r1', reserved)], maxViews: 1 });
  check(`创建阅后即焚消息（预留 ${reserved}B）→ 201`, r.status === 201, `status=${r.status}`);
  await fetch(`${BASE}/api/messages/${r.body.id}/att/r1`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${r.body.uploadToken}` },
    body: rand(64),
  });
  await fetch(`${BASE}/api/messages/${r.body.id}/finalize`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${r.body.uploadToken}` },
  });

  const consumed = await (
    await fetch(`${BASE}/api/messages/${r.body.id}/consume`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    })
  ).json();
  check('消费后 destroyed', consumed.destroyed === true);
  check('销毁后宽限期内额度仍被占着（R2 对象还在）', (await measure()).used === reserved);

  await sleep(WINDOW_WAIT);

  const afterBurn = await measure();
  check('宽限期结束（R2 已清）→ 整份预留归还', afterBurn.used === 0, `used=${afterBurn.used}`);
  const reuse = await createMessage({ attachments: [att('r2', CAP)] });
  check('归还后额度可再次用满 → 201', reuse.status === 201, `status=${reuse.status}`);
  await destroy(reuse.body.id);
  check('清场后归零', (await measure()).used === 0);
}

/* ------------------------------------------------------------------ */
/* 阶段三：历史存量初始化                                               */
/* ------------------------------------------------------------------ */

async function phaseSeed() {
  console.log('\n=== C. 升级已有实例：INITIAL_RESERVED_GB 一次性计入历史占用 ===');

  const seeded = await measure();
  check(`首次建立计数器即计入 ${SEED}B 历史占用`, seeded.used === SEED, `used=${seeded.used}`);

  const fits = await createMessage({ attachments: [att('s1', CAP - SEED)] });
  check(`剩余 ${CAP - SEED}B 仍可预留 → 201`, fits.status === 201, `status=${fits.status}`);
  const over = await createMessage({ attachments: [att('s2', 1)] });
  check('超过上限 → 507', over.status === 507, `status=${over.status}`);
  check('计数器被夹到上限，未越过', (await measure()).used === CAP);

  await destroy(fits.body.id);
  const cleared = await measure();
  check(`销毁新消息只归还它自己的 ${CAP - SEED}B，历史基线仍是 ${SEED}B`, cleared.used === SEED, `used=${cleared.used}`);
}

async function phaseReseed() {
  console.log('\n=== D. 重启后种子不重复播种 ===');

  // 同一份本地状态、换一个更大的 INITIAL_RESERVED_GB 重新部署：计数器必须纹丝不动。
  // 若种子被重复计入，SEED 会变成 min(上限, SEED + 新值) = 上限，这条断言就会挂。
  const again = await measure();
  check(`计数器没有被重新播种（仍是 ${SEED}B 基线）`, again.used === SEED, `used=${again.used}`);
  const fits = await createMessage({ attachments: [att('rs1', CAP - SEED)] });
  check(`可用额度仍是剩余的 ${CAP - SEED}B → 201`, fits.status === 201, `status=${fits.status}`);
  const over = await createMessage({ attachments: [att('rs2', 1)] });
  check('再要 1B 仍被拒 → 507', over.status === 507, `status=${over.status}`);
  await destroy(fits.body.id);
  check(`销毁后回到 ${SEED}B 基线`, (await measure()).used === SEED);
}

/* ------------------------------------------------------------------ */
/* 主线                                                                */
/* ------------------------------------------------------------------ */

const PHASES = [
  {
    name: 'main',
    vars: { MAX_R2_STORAGE_GB: toGb(CAP) },
    run: phaseMain,
  },
  {
    name: 'timing',
    vars: {
      MAX_R2_STORAGE_GB: toGb(CAP),
      PENDING_TTL_MS: WINDOW_MS,
      READ_TOKEN_TTL_MS: WINDOW_MS,
    },
    run: phaseTiming,
  },
  {
    name: 'seed',
    vars: { MAX_R2_STORAGE_GB: toGb(CAP), INITIAL_RESERVED_GB: toGb(SEED) },
    run: phaseSeed,
  },
  {
    // 复用 seed 的持久化状态，只把种子配置换掉
    name: 'reseed',
    reuse: 'seed',
    vars: { MAX_R2_STORAGE_GB: toGb(CAP), INITIAL_RESERVED_GB: toGb(CAP) },
    run: phaseReseed,
  },
];

async function main() {
  // 端口被占就没法跑：先确认它是空的
  try {
    await fetch(`${BASE}/`);
    console.error(
      `端口 ${PORT} 上已经有服务在跑。测试需要独占一个本地 wrangler dev ——\n` +
        `先停掉它，或用 PORT=9123 npm run test 换一个端口。`,
    );
    process.exit(2);
  } catch {
    /* 连不上正是我们要的 */
  }

  mkdirSync(STATE_ROOT, { recursive: true });
  console.log(`临时状态目录：${STATE_ROOT}`);
  console.log('（每个阶段一份独立子目录，跑完不删，交给系统清理）');

  for (const phase of PHASES) {
    const stateDir = resolve(STATE_ROOT, phase.reuse ?? phase.name);
    mkdirSync(stateDir, { recursive: true });

    console.log(
      `\n\u2500\u2500 阶段 ${phase.name}：启动 wrangler dev（--persist-to ${phase.reuse ?? phase.name}）\u2500\u2500`,
    );
    const child = startDev(stateDir, {
      // 限流会挡住并发测试，这里放宽（与容量保险互不干扰）
      RATE_LIMIT_MAX_CREATES: 100000,
      ...phase.vars,
    });

    try {
      const ready = await waitReady();
      if (!ready) {
        console.error(`阶段 ${phase.name} 启动失败，dev 日志末尾：`);
        console.error(devLog.slice(-25).join('\n'));
        process.exit(1);
      }
      await phase.run();
    } finally {
      await stopDev(child);
    }
  }

  console.log('');
  console.log(`结果：${pass} 通过 / ${fail} 失败`);
  if (probeAnomalies.length > 0) {
    console.log('探测期间的异常：');
    for (const item of probeAnomalies) console.log(`  - ${item}`);
  }
  if (fail > 0) {
    console.log('失败项：');
    for (const label of failures) console.log(`  - ${label}`);
    // storage guard 自己的告警是定位计数异常的第一手线索，全量打出来
    const guardLog = devLog.filter((line) => line.includes('storage guard'));
    if (guardLog.length > 0) {
      console.log('\nstorage guard 告警（全量）：');
      console.log(guardLog.join('\n'));
    }
    console.log('\ndev 日志末尾：');
    console.log(devLog.slice(-15).join('\n'));
  }
  process.exit(fail === 0 ? 0 : 1);
}

main().catch(async (err) => {
  console.error('storage guard test 异常终止：', err);
  if (devLog.length > 0) console.error(devLog.slice(-20).join('\n'));
  process.exit(1);
});
