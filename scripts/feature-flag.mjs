/**
 * 读部署配置，回答三个构建期问题：
 *
 *   1. 这次部署带不带图片功能 —— 判据只有一条：配置里有没有 r2_buckets。
 *      它与运行时的 env.BLOBS 同源，所以不存在第二个开关可以与之漂移。
 *      想切换版本就换一份配置（wrangler.jsonc 仅文字 / wrangler.images.jsonc 带图片）。
 *   2. 默认语言是什么 —— 判据是 vars.DEFAULT_LOCALE（缺省 zh）。
 *      构建期据此生成 src/i18n/active.ts，页面渲染也读同一处。
 *   3. 举报联系方式填了没有 —— 判据是 vars.ABUSE_CONTACT（缺省为空）。
 *      构建期据此生成 src/legal.ts。页脚的**用途告知文案是内置的**（字典键 foot.notice
 *      / foot.reportHint），不走配置：它是站点的固定组成部分，部署者只需要填联系方式。
 *
 * 读的是哪份配置：默认 wrangler.jsonc，可由 WRANGLER_CONFIG 覆盖（见下方 configPath）。
 * 两份配置都随仓库入库，所以不再做「缺失时自动生成」—— 缺了就是仓库不完整，直接报错。
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_CONFIG = 'wrangler.jsonc';
/** 仓库自带的图片版配置，只在报错信息里用来指路 */
const IMAGES_CONFIG = 'wrangler.images.jsonc';

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

/** 读取部署配置；默认文件缺失时给出恢复办法（两份配置都入库，正常不会缺） */
function loadConfig() {
  const path = configPath();
  const name = basename(path);

  if (!existsSync(path)) {
    // 用户显式指定的文件不存在时直接报错，免得悄悄用另一份配置构建出与预期不符的产物
    if (path !== resolve(root, DEFAULT_CONFIG)) {
      throw new Error(`指定的配置文件不存在：${name}（仓库自带 ${DEFAULT_CONFIG} 与 ${IMAGES_CONFIG}）`);
    }
    throw new Error(
      `找不到 ${DEFAULT_CONFIG} —— 它随仓库提供，请先恢复（git checkout ${DEFAULT_CONFIG}），` +
        `或改用图片版：npm run deploy -- -c ${IMAGES_CONFIG}`,
    );
  }

  try {
    return JSON.parse(stripTrailingCommas(stripJsonc(readFileSync(path, 'utf8'))));
  } catch (err) {
    /* 多行文本（比如 vars.LEGAL_NOTICE 写两句）最容易踩这个坑：
       JSON 字符串里不允许出现真正的换行，必须写成 \n 转义。这里直接说清楚。 */
    const hint = /control character/i.test(err.message)
      ? '\n     提示：字符串里的多行文本要写成 \\n 转义，不能直接换行。'
      : '';
    throw new Error(`${name} 不是合法 JSON：${err.message}${hint}`);
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

/* ------------------------------------------------------------------ */
/* 页脚：举报联系方式（可选，默认空）                                    */
/* ------------------------------------------------------------------ */

/** 联系方式长度上限 */
const CONTACT_MAX = 200;

/**
 * 读一个字符串型 vars。缺省 / null / 空串一律当成「没配」，返回 ''；
 * 类型不对（写成数字或数组）直接报错 —— 这类错误静默吞掉最贵。
 */
function readVar(name) {
  const raw = loadConfig().vars?.[name];
  if (raw === undefined || raw === null) return '';
  if (typeof raw !== 'string') {
    throw new Error(`${basename(configPath())} 的 vars.${name} 必须是字符串，当前是 ${JSON.stringify(raw)}`);
  }
  return raw.trim();
}

/**
 * 举报联系方式（vars.ABUSE_CONTACT）。
 *
 * 只接受两种形态：**邮箱** 或 **http(s) 网址**。构建期就卡住，免得页面上出现一个
 * 点不动的「举报滥用」。
 *
 * ⚠️ 填之前想清楚两件事（README 有完整说明）：
 *   1. 这必须是**你自己能持续收信**的地址 —— 收件方就是「接到举报后有义务处置」的人；
 *   2. 别填不是你的地址。
 *
 * 缺省为空 = 页脚不出现举报入口，build-client.mjs 会在构建日志里显著提醒。
 */
export function abuseContact() {
  const value = readVar('ABUSE_CONTACT');
  if (!value) return '';
  if (value.length > CONTACT_MAX) {
    throw new Error(`${basename(configPath())} 的 vars.ABUSE_CONTACT 太长（${value.length} 字 > ${CONTACT_MAX}）。`);
  }
  if (/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(value)) return value;
  if (/^https?:\/\/\S+$/.test(value)) return value;
  throw new Error(
    `${basename(configPath())} 的 vars.ABUSE_CONTACT 只能是邮箱或 http(s) 网址，当前是 ${JSON.stringify(value)}`,
  );
}

/** 举报链接的 href：邮箱补 mailto:，网址原样。构建期定死，运行期不再判断 */
export function abuseHref() {
  const value = abuseContact();
  if (!value) return '';
  return value.includes('@') && !/^https?:/i.test(value) ? `mailto:${value}` : value;
}

const LEGAL_FILE = resolve(root, 'src/legal.ts');

/**
 * 生成 src/legal.ts（不入库）。
 *
 * 这里只剩「部署者可配的那一个值」。页脚的用途告知是内置的（字典键 foot.notice /
 * foot.reportHint），不走配置 —— 它是站点的固定组成部分。
 *
 * 为什么联系方式走「生成文件 + 运行期建节点」，而不是构建期烤进 public/*.html：
 * 个人联系方式一旦写进 HTML，就成了**入库文件**的改动 —— git pull 会冲突，而这正是
 * 本项目要求「自己的域名、桶名只留在 wrangler.<自定义>.jsonc」的那条规矩。
 * 生成文件与 src/i18n/active.ts 同类：由配置派生、不入库、每次构建重写。
 *
 * 代价：禁用脚本时举报入口不显示。可以接受 —— 它本来就是给「看得到页面的人」看的。
 */
export function writeLegalConfig() {
  const href = abuseHref();
  const name = basename(configPath());

  const source = `/**
 * 构建期生成的文件 —— **请勿手改**，下次构建会被覆盖。
 *
 * 由 scripts/feature-flag.mjs 依据 ${name} 的 vars.ABUSE_CONTACT 生成。
 * 页脚的**用途告知文案不在这里** —— 它是内置的，见字典键 foot.notice / foot.reportHint。
 *
 * 留空时的状态：ABUSE_CONTACT 与 ABUSE_HREF 都是空串，页脚不生成举报入口
 * （见 src/client/footer.ts），构建日志里会有显著提醒。**这是默认状态**，
 * 所以本仓库不会把任何人的联系方式带给下游部署者。
 *
 * 改动方式：改部署配置里的 vars.ABUSE_CONTACT，然后重新构建（见 scripts/run.mjs）。
 * 自己的实例请把值写进 wrangler.<自定义>.jsonc（已被 .gitignore 忽略）。
 *
 * 两个常量都显式标注 \`: string\`，别去掉：空串会被推导成字面量类型 ""，
 * 于是 \`if (ABUSE_HREF)\` 分支里的值被收窄成 never，tsc 会直接报错。
 */
export const ABUSE_CONTACT: string = ${JSON.stringify(abuseContact())};

export const ABUSE_HREF: string = ${JSON.stringify(href)};
`;

  writeFileSync(LEGAL_FILE, source);
  return { report: href !== '' };
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

