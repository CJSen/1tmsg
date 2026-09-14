/**
 * i18n 运行期 —— 全部逻辑都在这里，页面代码只调 t() / initLocale()。
 *
 * 体积策略（这块的取舍都在「让极差网络下的首屏尽量小」上）：
 *
 *   默认语言的字典 → **静态**进主 chunk（就是这个文件 import 的那份）
 *   另一种语言     → **动态 import**，只有用户点了切换按钮时才下载，
 *                    esbuild 的 splitting 会把它切成独立 chunk
 *                    （不做浏览器语言自动跟随 —— 站点语言就是 DEFAULT_LOCALE）
 *
 * 「哪份是默认」不在源码里写死，也不是靠打包器消除死分支 —— 而是由
 * scripts/feature-flag.mjs 按 wrangler.jsonc 的 vars.DEFAULT_LOCALE 生成
 * src/i18n/active.ts（该文件不入库）。生成式而非条件分支，是这里刻意的选择：
 * 「静态引一份、动态引另一份」由文件内容直接保证，不依赖打包器的优化程度。
 *
 * HTML 里的静态文案走 data-i18n 属性，**构建期**已按默认语言烤进 HTML
 * （scripts/build-html.mjs），所以脚本没跑起来时页面也是完全可读的默认语言。
 * 这个文件里的 applyToDom() 只在切换语言时把它改写成另一种语言。
 */
import { dict, loadOther, locale as buildLocale, type Locale } from './active';
import type { MsgKey } from './zh';

export type { Locale, MsgKey };

/** 部署时选定的默认语言（来自 wrangler.jsonc，构建期固定） */
export const defaultLocale: Locale = buildLocale;

/** `<html lang>` 用的完整标记 */
const LANG_TAG: Record<Locale, string> = { zh: 'zh-CN', en: 'en' };

/** 用户手动切换后记住的选择。只存语言偏好，不含任何密钥或消息内容 */
const STORAGE_KEY = '1tmsg:locale';

let table: Record<MsgKey, string> = dict;
let active: Locale = buildLocale;
const listeners = new Set<() => void>();

/* ------------------------------------------------------------------ */
/* 取值为文案                                                          */
/* ------------------------------------------------------------------ */

export type TParams = Record<string, string | number>;

/**
 * 单复数：值里用 `||` 分成「单数形||复数形」，由 params.n 挑选。
 * 没有 `||` 的值（中文条目的常态）直接原样返回。
 */
function pickForm(raw: string, params?: TParams): string {
  const split = raw.split('||');
  if (split.length < 2) return raw;
  const n = typeof params?.n === 'number' ? params.n : 1;
  return (n === 1 ? split[0] : split[1]) as string;
}

/** `{name}` 占位替换。没给值的占位符原样保留，便于一眼看出漏传参数 */
function fill(raw: string, params?: TParams): string {
  if (!params) return raw;
  return raw.replace(/\{(\w+)\}/g, (whole, name: string) => {
    const value = params[name];
    return value === undefined ? whole : String(value);
  });
}

/**
 * 取文案。
 * @param key    文案键（都在 src/i18n/zh.ts 里）
 * @param params 占位符与单复数驱动值（n）
 */
export function t(key: MsgKey, params?: TParams): string {
  const raw = (table as Record<string, string | undefined>)[key];
  if (raw === undefined) {
    // 键写错不该让页面白屏：把键名显示出来，控制台留线索
    console.warn('[1tmsg] missing message key:', key);
    return key;
  }
  return fill(pickForm(raw, params), params);
}

/* ------------------------------------------------------------------ */
/* 作用于 DOM                                                          */
/* ------------------------------------------------------------------ */

/**
 * 把当前语言的文案写进 DOM。两类约定：
 *   `data-i18n="key"`             → 替换该元素的文本（约定：元素内容必须是纯文本）
 *   `data-i18n-<attr>="key"`      → 替换该属性（placeholder / title / aria-label / content …）
 *
 * 文本用 textContent 而不是 innerHTML —— 与 spec「永不把未清理的内容塞进
 * innerHTML」保持一致，代价是需要局部加粗的地方得拆成相邻的多个键。
 *
 * 由 JS 自己维护文本的元素（倒计时、摘要条、错误提示等**带参数**的）不挂
 * data-i18n，改由各自的页面代码在语言变化时重算，见 onLocaleChange。
 */
export function applyToDom(): void {
  document.documentElement.lang = LANG_TAG[active];

  for (const node of Array.from(document.querySelectorAll<HTMLElement>('[data-i18n]'))) {
    const key = node.dataset.i18n as MsgKey | undefined;
    if (key) node.textContent = t(key);
  }

  for (const node of Array.from(document.querySelectorAll<HTMLElement>('*'))) {
    for (const attr of Array.from(node.attributes)) {
      if (!attr.name.startsWith('data-i18n-')) continue;
      const target = attr.name.slice('data-i18n-'.length);
      node.setAttribute(target, t(attr.value as MsgKey));
    }
  }
}

/* ------------------------------------------------------------------ */
/* 语言状态                                                            */
/* ------------------------------------------------------------------ */

export function currentLocale(): Locale {
  return active;
}

/** 语言变化时的回调：带参数、由 JS 自己维护的文案靠它重算 */
export function onLocaleChange(cb: () => void): void {
  listeners.add(cb);
}

function recall(): Locale | null {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    return saved === 'zh' || saved === 'en' ? saved : null;
  } catch {
    // 无痕模式等场景下 localStorage 会抛异常，当作没记住处理
    return null;
  }
}

function remember(next: Locale): void {
  try {
    localStorage.setItem(STORAGE_KEY, next);
  } catch {
    /* 存不下就算了，不影响本次使用 */
  }
}

/** 该用哪种语言：用户手动选过就听用户的，否则就是部署默认值。
 *  **不自动跟随浏览器语言** —— DEFAULT_LOCALE 是站点的语言，不是首屏的暂态；
 *  自动切换会让语言不匹配的访客看到一次「先默认后切换」的闪烁，
 *  而且部署者选定的语言对稳定受众来说才是可预期的行为。想换语言？右上角按钮。 */
export function detect(): Locale {
  return recall() ?? buildLocale;
}

/** 换语言。默认语言用常驻的那份字典，另一种按需下载 */
export async function setLocale(next: Locale, persist = true): Promise<void> {
  if (next !== active) {
    table = next === buildLocale ? dict : await loadOther();
    active = next;
  }
  applyToDom();
  if (persist) remember(active);
  for (const cb of listeners) cb();
}

/**
 * 页面入口该调的第一件事：恢复用户手动选过的语言（如有）、接上切换按钮。
 * 这里**不做**浏览器语言探测 —— 见 detect() 的注释。
 *
 * `persist = false`：恢复出来的选择不回写存储，只有用户主动点击才记。
 */
export async function initLocale(): Promise<void> {
  await setLocale(detect(), false);
  mountSwitcher();
}

/* ------------------------------------------------------------------ */
/* 切换按钮                                                            */
/* ------------------------------------------------------------------ */

/**
 * 顶栏的切换按钮：固定显示「中文 / EN」两个候选 —— 当前语言高亮、另一个置灰，
 * 点一下整颗按钮就切到另一种。
 *
 * 创建页、已创建屏、查看页各有一颗，全部用 `.lang` 类选中：
 * 一次绑定、一起刷新（它们在同一个文档里，只是随屏幕切换显隐）。
 */
export function mountSwitcher(): void {
  const buttons = Array.from(document.querySelectorAll<HTMLButtonElement>('button.lang'));
  if (buttons.length === 0) return;

  const render = (): void => {
    for (const button of buttons) {
      const seg = (locale: Locale, text: string): HTMLElement => {
        const span = document.createElement('span');
        span.className = locale === active ? 'cur' : 'alt';
        span.textContent = text;
        return span;
      };
      const sep = document.createElement('span');
      sep.className = 'sep';
      sep.setAttribute('aria-hidden', 'true');
      sep.textContent = '/';
      button.replaceChildren(seg('zh', '中文'), sep, seg('en', 'EN'));

      const target: Locale = active === 'zh' ? 'en' : 'zh';
      const hint = t(target === 'en' ? 'lang.toEnglish' : 'lang.toChinese');
      button.setAttribute('aria-label', hint);
      button.title = hint;
    }
  };

  render();
  onLocaleChange(render);
  for (const button of buttons) {
    button.addEventListener('click', () => {
      void setLocale(active === 'zh' ? 'en' : 'zh');
    });
  }
}

/* ------------------------------------------------------------------ */
/* 展示型异常                                                          */
/* ------------------------------------------------------------------ */

/**
 * 文案已经过 t() 的异常 —— 页面拿到它可以直接把 message 显示给用户。
 * 用来把「技术性异常」（例如 crypto 抛的 ciphertext-corrupt）与
 * 「给用户看的话」区分开，避免前者被原样展示出来。
 */
export class LocaleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LocaleError';
  }
}
