/**
 * 读部署配置，回答两个构建期问题：
 *
 *   1. 这次部署带不带图片功能 —— 判据只有一条：配置里有没有 r2_buckets。
 *      它与运行时的 env.BLOBS 同源，所以不存在第二个开关可以与之漂移。
 *      想切换版本就换一份模板（wrangler.jsonc.example / .example.r2）。
 *   2. 默认语言是什么 —— 判据是 vars.DEFAULT_LOCALE（缺省 zh）。
 *      构建期据此生成 src/i18n/active.ts，页面渲染也读同一处。
 *
 * 读的是哪份配置：默认 wrangler.jsonc，可由 WRANGLER_CONFIG 覆盖（见下方 configPath）。
 * 顺带负责：默认配置缺失时从模板（不带图片）生成一份。
 */
import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_CONFIG = 'wrangler.jsonc';
const PLAIN_TEMPLATE = resolve(root, 'wrangler.jsonc.example');
const R2_TEMPLATE = resolve(root, 'wrangler.jsonc.example.r2');

/**
 * 本次构建该读哪份部署配置：默认 wrangler.jsonc，可由环境变量 WRANGLER_CONFIG 覆盖。
 *
 * 为什么要留这个口子：`npm run deploy -- -c <file>` 里的参数**到不了构建脚本**
 * （npm 只把它追加到脚本命令末尾，链首的 build 收不到）。若这里把路径写死，
 * 就会出现「构建按 A 配置、部署按 B 配置」的漂移 —— 恰好是本模块要消灭的那种漂移。
 * `scripts/run.mjs` 站在链首接住 `-c`，把它写成这个环境变量，两条链路因此同源；
 * 不经过该入口（比如直接 `wrangler deploy`）时行为与从前完全一样。
 */
function configPath() {
  return resolve(root, process.env.WRANGLER_CONFIG ?? DEFAULT_CONFIG);
}

/** 当前生效的配置文件名，只用于日志与报错信息 */
export function configFileName() {
  return basename(configPath());
}

/**
 * 剥离 JSONC 注释。用状态机而不是正则：配置里到处都是中文说明，而自定义域名、
 * 桶名都可能出现 `//`（例如 https://…），正则很容易把字符串内容一起吃掉。
 */
function stripJsonc(text) {
  let out = '';
  let inString = false;

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];

    if (inString) {
      out += ch;
      if (ch === '\\') {
        out += text[i + 1] ?? '';
        i += 1;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }

    if (ch === '"') {
      inString = true;
      out += ch;
    } else if (ch === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i += 1;
      out += '\n';
    } else if (ch === '/' && text[i + 1] === '*') {
      i += 2;
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i += 1;
      i += 1;
      out += ' ';
    } else {
      out += ch;
    }
  }

  return out;
}

/** JSONC 允许尾随逗号，JSON.parse 不允许 */
const stripTrailingCommas = (text) => text.replace(/,(\s*[}\]])/g, '$1');

/** 读取部署配置；用默认文件名且文件缺失时，从默认模板生成一份 */
function loadConfig() {
  const path = configPath();
  const name = basename(path);

  if (!existsSync(path)) {
    // 只有「默认文件缺失」才自动生成；用户显式指定的文件不存在时直接报错，
    // 免得悄悄用另一份配置构建出与预期不符的产物
    if (path !== resolve(root, DEFAULT_CONFIG)) {
      throw new Error(`指定的配置文件不存在：${name}`);
    }
    copyFileSync(PLAIN_TEMPLATE, path);
    console.log(`[config] 已生成 ${name} —— 不带图片的版本`);
    console.log(`[config] 想发图片：cp ${basename(R2_TEMPLATE)} ${name}（需先开通 R2）`);
  }

  try {
    return JSON.parse(stripTrailingCommas(stripJsonc(readFileSync(path, 'utf8'))));
  } catch (err) {
    throw new Error(`${name} 不是合法 JSON：${err.message}`);
  }
}

/** 图片功能是否启用：配置里声明了 r2_buckets 就是启用 */
export function imagesEnabled() {
  const buckets = loadConfig().r2_buckets;
  return Array.isArray(buckets) && buckets.length > 0;
}

/* ------------------------------------------------------------------ */
/* 默认语言                                                            */
/* ------------------------------------------------------------------ */

/** 支持的语言。加语言要同时改 src/i18n/ 下的字典与这里的白名单 */
export const LOCALES = ['zh', 'en'];

/**
 * 部署默认语言：读部署配置的 vars.DEFAULT_LOCALE。
 *
 * 与图片开关同样的思路 —— 判据只有一处（部署配置），构建期与页面渲染都读它，
 * 所以不存在「配置说英文、产物却是中文」这种漂移。
 * 缺省或空值按 zh 处理，非法值直接让构建失败：宁可现在报错，也不要静默发布一个
 * 语言不明的站点。
 */
export function defaultLocale() {
  const raw = loadConfig().vars?.DEFAULT_LOCALE;
  if (raw === undefined || raw === null || raw === '') return 'zh';
  const value = String(raw).trim().toLowerCase();
  if (LOCALES.includes(value)) return value;
  throw new Error(
    `${basename(configPath())} 的 vars.DEFAULT_LOCALE 只能是 ${LOCALES.map((l) => `"${l}"`).join(' 或 ')}，当前是 ${JSON.stringify(raw)}`,
  );
}

const ACTIVE_LOCALE = resolve(root, 'src/i18n/active.ts');

/**
 * 生成 src/i18n/active.ts（不入库）。
 *
 * 为什么要有这个文件：默认语言的字典必须**静态**进主 chunk，另一种必须留在
 * 独立 chunk 里按需加载。靠「生成一份只静态引用其中一方的模块」来保证这件事，
 * 比指望打包器消除 `if (__DEFAULT_LOCALE__ === 'zh')` 这样的死分支可靠得多。
 */
export function writeActiveLocale() {
  const locale = defaultLocale();
  const other = locale === 'zh' ? 'en' : 'zh';

  const source = `/**
 * 构建期生成的文件 —— **请勿手改**，下次构建会被覆盖。
 *
 * 由 scripts/feature-flag.mjs 依据 ${basename(configPath())} 的 vars.DEFAULT_LOCALE 生成，
 * 调用方：scripts/build-client.mjs 与 npm run typecheck（scripts/sync-locale.mjs）。
 *
 * 当前默认语言：${locale}
 * 改动方式：改部署配置的 vars.DEFAULT_LOCALE，然后重新构建（见 scripts/run.mjs）。
 */
import type { MsgKey } from './zh';
import { ${locale} } from './${locale}';

export const locale = '${locale}' as const;

export type Locale = 'zh' | 'en';

/** 默认语言的字典：静态引用 → 进主 chunk，首屏即可用，零额外请求 */
export const dict: Record<MsgKey, string> = ${locale};

/** 另一种语言：只在用户点了右上角切换按钮时才下载 */
export async function loadOther(): Promise<Record<MsgKey, string>> {
  const mod = await import('./${other}');
  return mod.${other};
}
`;

  writeFileSync(ACTIVE_LOCALE, source);
  return locale;
}

