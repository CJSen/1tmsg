/**
 * 统一入口：接住配置文件路径 → 构建 → 交给 wrangler。
 *
 * 为什么需要这一层：`npm run deploy -- -c X` 里的参数只会被 npm 追加到脚本命令的
 * 末尾，复合脚本（`npm run build && wrangler deploy`）中的 build 收不到它 —— 于是
 * build 读 wrangler.jsonc、deploy 读 X，出现「前端关掉图片功能、后端却带 R2 绑定」
 * 的漂移（正是 scripts/feature-flag.mjs 想消灭的那种漂移）。
 * 这里站在链首把 -c 接住：转成环境变量 WRANGLER_CONFIG 喂给构建脚本，
 * 再原样传给 wrangler，两条链路必然读同一份配置。
 *
 * 用法：
 *   npm run deploy                            # 构建 + 部署，用 wrangler.jsonc
 *   npm run deploy -- -c wrangler.me.jsonc    # 构建 + 部署，两条链路都用它
 *   npm run dev                               # 构建 + 本地 dev（默认 0.0.0.0:8787）
 *   npm run dev -- -c wrangler.me.jsonc       # 本地 dev 也走同一份配置
 *   npm run dev -- --port 9000                # 覆盖默认监听端口
 *   npm run deploy -- --dry-run               # 其余参数原样透传给 wrangler
 *
 * 不带 -c 时行为与直接跑 `npm run build && wrangler deploy` 完全一致 —— 一键部署
 * （Deploy to Cloudflare 按钮）会不带参数地取 package.json 里的 deploy 脚本执行。
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, extname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { defaultLocale, imagesEnabled } from './feature-flag.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_CONFIG = 'wrangler.jsonc';

/** wrangler 靠扩展名判定配置格式，后缀不认识时它**静默忽略**整份配置（不报错），提前拦掉 */
const SUPPORTED_EXT = ['.jsonc', '.json', '.toml'];

function die(message) {
  console.error(`[run] ${message}`);
  process.exit(1);
}

/* ── 解析参数：--dev 选子命令，-c/--config 选配置，其余透传给 wrangler ── */

let mode = 'deploy';
let configArg = null;
const passthrough = [];

const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i += 1) {
  const arg = argv[i];
  const eq = arg.indexOf('=');
  const flag = eq === -1 ? arg : arg.slice(0, eq);
  const inlineValue = eq === -1 ? null : arg.slice(eq + 1);

  if (flag === '--dev') {
    mode = 'dev';
  } else if (flag === '-c' || flag === '--config') {
    let value = inlineValue;
    if (value === null) {
      i += 1;
      value = argv[i];
    }
    if (!value) die(`${flag} 后面缺配置文件路径`);
    configArg = value;
  } else {
    passthrough.push(arg);
  }
}

/* ── dev 的默认监听参数 ── */
/*
 * 默认值写在这里而不是 package.json，是因为 yargs 遇到重复的标量参数会**直接报错**
 * （`--port 8787 --port 9000` → "expects a single value, but received multiple"）。
 * 放在这里就能做到「用户没传才注入默认」，`npm run dev -- --port 9000` 即可干净覆盖。
 * 默认值与改造前 package.json 里的 `--ip 0.0.0.0 --port 8787` 一致。
 */
const DEV_DEFAULTS = [
  ['--ip', '0.0.0.0'],
  ['--port', '8787'],
];

const givenFlags = new Set(
  passthrough.filter((a) => a.startsWith('--')).map((a) => a.split('=')[0]),
);

const extraArgs =
  mode === 'dev'
    ? [
        ...DEV_DEFAULTS.filter(([flag]) => !givenFlags.has(flag)).flat(),
        ...passthrough,
      ]
    : passthrough;

/* ── 定位并校验配置文件 ── */

const isDefault = configArg === null;
const configPath = resolve(root, configArg ?? DEFAULT_CONFIG);
const configName = configPath.startsWith(root)
  ? relative(root, configPath)
  : configPath;
const ext = extname(configPath).toLowerCase();

if (!SUPPORTED_EXT.includes(ext)) {
  die(
    `配置文件后缀 ${ext || '(无)'} 不被 wrangler 识别，它只认 ${SUPPORTED_EXT.join(' / ')}；` +
      `不认识的后缀会被静默忽略（表现为追问项目名后报 Missing entry-point）。\n` +
      `      把 ${configName} 改成以 .jsonc 结尾的名字即可。`,
  );
}

if (!existsSync(configPath) && !isDefault) {
  die(
    `找不到指定的配置文件：${configName}\n` +
      `      仓库自带的是 wrangler.jsonc（仅文字）与 wrangler.images.jsonc（图片版）；\n` +
      `      要用图片版：npm run deploy -- -c wrangler.images.jsonc`,
  );
}

/*
 * 构建脚本按这个环境变量找配置。必须在 build 之前设好 —— 它是两条链路唯一的耦合点。
 * （默认文件缺失时不在这里拦：feature-flag.mjs 会给出恢复提示。）
 */
process.env.WRANGLER_CONFIG = configPath;

/* ── 先把本次生效的开关打出来，漂移一看便知 ── */

let images;
let locale;
try {
  images = imagesEnabled();
  locale = defaultLocale();
} catch (err) {
  die(`读配置失败：${err.message}`);
}

const target = mode === 'deploy' ? 'wrangler deploy' : 'wrangler dev';
console.log(
  `[run] 配置：${configName}｜图片：${images ? '启用' : '关闭'}｜默认语言：${locale}`,
);
console.log(
  `[run] 目标：${target}${extraArgs.length ? `｜参数：${extraArgs.join(' ')}` : ''}`,
);

/* ── 执行 ── */

const wranglerBin = resolve(
  root,
  'node_modules',
  '.bin',
  process.platform === 'win32' ? 'wrangler.cmd' : 'wrangler',
);

if (!existsSync(wranglerBin)) die('没找到本地 wrangler，先跑一次 npm install');

function run(command, args) {
  return new Promise((done) => {
    const child = spawn(command, args, {
      cwd: root,
      stdio: 'inherit',
      env: process.env,
      shell: process.platform === 'win32',
    });
    child.on('close', (code) => done(code ?? 1));
  });
}

// build 沿用 package.json 里的定义，避免构建步骤在仓库里出现第二份拷贝
const buildCode = await run('npm', ['run', 'build']);
if (buildCode !== 0) die(`构建失败（退出码 ${buildCode}），已中止，未交给 wrangler`);

process.exit(await run(wranglerBin, [mode, '-c', configPath, ...extraArgs]));
