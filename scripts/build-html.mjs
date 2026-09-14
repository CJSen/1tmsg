/**
 * 页面文案的构建期注入：把 public/*.html 里挂着的 data-i18n 按**默认语言**烤一遍。
 *
 * 为什么在构建期做，而不是等脚本跑起来再替换：
 *   1. 页面在脚本执行前就是完整可读的 —— 极差网络下 HTML 一到就有内容，
 *      而且文案与语言不会闪一下再变。
 *   2. JS 没跑起来（禁用脚本、资源没下完）时页面仍是默认语言，不是一堆占位键。
 *   3. 首屏体积不因此变大：文案本来就在 HTML 里，只是换了语种。
 *
 * 约定（脚本会强制校验，违约直接构建失败）：
 *   - `data-i18n="key"`        → 替换该元素的**文本**。元素内容必须是纯文本，
 *                                不能有子元素。需要局部加粗/斜体时，拆成相邻的
 *                                多个键 + 相邻元素（原因见 src/i18n/index.ts）。
 *   - `data-i18n-<attr>="key"` → 替换该属性，用于 placeholder / title /
 *                                aria-label / content 这类属性文案。
 *   - `<html lang>`            → 按语言自动改写为 zh-CN / en。
 *
 * 本脚本是幂等的：跑第二遍不产生任何字节变化，也不会写盘（避免无意义的 mtime 变动）。
 */
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import * as esbuild from 'esbuild';

import { LOCALES, defaultLocale } from './feature-flag.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PAGES = ['index.html', 'm.html'];
const LANG_TAG = { zh: 'zh-CN', en: 'en' };

/**
 * 把字典当数据读进来。
 * 字典是 .ts（要保留注释、并且靠类型卡住漏译），Node 直接 import 不了，
 * 所以借已经装好的 esbuild 转一道 —— 顺带也就验证了字典本身能编译。
 */
async function loadDict(locale) {
  const built = await esbuild.build({
    entryPoints: [resolve(root, `src/i18n/${locale}.ts`)],
    bundle: true,
    write: false,
    format: 'esm',
    platform: 'neutral',
    target: 'es2022',
  });
  const dir = mkdtempSync(join(tmpdir(), '1tmsg-i18n-'));
  const file = join(dir, `${locale}.mjs`);
  writeFileSync(file, built.outputFiles[0].text);
  const mod = await import(pathToFileURL(file).href);
  return mod[locale];
}

const escapeAttr = (value) =>
  value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/\n/g, '&#10;');

const escapeText = (value) =>
  value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** 注释 或 开始标签；注释分支 m[1] 为 undefined */
const TOKEN_RE = /<!--[\s\S]*?-->|<([a-zA-Z][a-zA-Z0-9-]*)((?:"[^"]*"|'[^']*'|[^>"'])*)>/g;
const TEXT_KEY_RE = /\sdata-i18n="([^"]*)"/;
const ATTR_KEY_RE = /data-i18n-([a-z-]+)="([^"]*)"/g;

function renderPage(html, dict, locale, file) {
  const used = new Set();
  const lookup = (key) => {
    const value = dict[key];
    if (value === undefined) {
      throw new Error(`${file}: data-i18n 引用了字典里没有的键 "${key}"`);
    }
    used.add(key);
    return value;
  };

  let out = '';
  let cursor = 0;
  TOKEN_RE.lastIndex = 0;

  for (let m = TOKEN_RE.exec(html); m !== null; m = TOKEN_RE.exec(html)) {
    if (m[1] === undefined) continue; // 注释：原样留给后面的切片复制

    const name = m[1];
    const attrs = m[2] ?? '';
    let tag = m[0];

    if (attrs.includes('data-i18n-')) {
      /*
       * 属性文案：`data-i18n-title="editor.mdBold"` 的意思是「把 title 写成字典里的
       * editor.mdBold」。标记属性本身必须保持键名不动 —— 改了它，第二遍就找不到键了，
       * 幂等性随之失效（这里吃过一次亏）。
       */
      ATTR_KEY_RE.lastIndex = 0;
      for (const match of attrs.matchAll(ATTR_KEY_RE)) {
        const attr = match[1];
        const key = match[2];
        const value = escapeAttr(lookup(key));
        const targetRe = new RegExp(`\\s${attr}="[^"]*"`);
        if (!targetRe.test(tag)) {
          throw new Error(
            `${file}: <${name}> 挂了 data-i18n-${attr}="${key}"，但标签上没有 ${attr} 属性。` +
              `本脚本只改属性值、不代建属性，请把 ${attr}="..." 一并写上。`,
          );
        }
        tag = tag.replace(targetRe, ` ${attr}="${value}"`);
      }
    }
    if (name === 'html') tag = tag.replace(/lang="[^"]*"/, `lang="${LANG_TAG[locale]}"`);

    out += html.slice(cursor, m.index) + tag;
    cursor = m.index + m[0].length;

    const textKey = TEXT_KEY_RE.exec(attrs)?.[1];
    if (textKey === undefined) continue;

    const close = html.indexOf(`</${name}>`, cursor);
    if (close < 0) throw new Error(`${file}: <${name} data-i18n="${textKey}"> 没有对应的闭合标签`);

    const inner = html.slice(cursor, close);
    if (inner.includes('<')) {
      throw new Error(
        `${file}: <${name} data-i18n="${textKey}"> 的内容里有子元素。` +
          `data-i18n 只能放在纯文本元素上 —— 需要局部加粗/斜体时，拆成相邻的多个键与相邻元素。`,
      );
    }

    out += escapeText(lookup(textKey));
    cursor = close; // 跳过原文案，闭合标签由循环外的切片补上
  }

  out += html.slice(cursor);
  return { html: out, used };
}

/* ------------------------------------------------------------------ */

const locale = defaultLocale();
const dict = await loadDict(locale);

/* 切换语言时用的是另一份字典，所以两边的键必须都全 —— 少一条就会在切换后露出键名 */
const others = LOCALES.filter((l) => l !== locale);
const otherDicts = new Map(await Promise.all(others.map(async (l) => [l, await loadDict(l)])));

let changed = 0;
const allUsed = new Set();

for (const page of PAGES) {
  const path = resolve(root, 'public', page);
  const source = readFileSync(path, 'utf8');
  const { html, used } = renderPage(source, dict, locale, page);
  for (const key of used) allUsed.add(key);

  for (const [other, otherDict] of otherDicts) {
    for (const key of used) {
      if (otherDict[key] === undefined) {
        throw new Error(`${page}: 键 "${key}" 在 ${other}.ts 里缺失 —— 切到 ${other} 会露出键名`);
      }
    }
  }

  if (html === source) {
    console.log(`[i18n] ${page}：已是 ${locale}，无需改动`);
  } else {
    writeFileSync(path, html);
    changed += 1;
    console.log(`[i18n] ${page}：已渲染为 ${locale}`);
  }
}

console.log(`[i18n] 页面文案：${locale}，用到 ${allUsed.size} 个键，改动 ${changed}/${PAGES.length} 个文件`);
