/**
 * 客户端构建：esbuild 打包 src/client/*.ts → public/assets/
 *
 * 产物契约（public/index.html 与 public/m.html 按固定文件名引用，不能带 hash）：
 *   create.js   创建页入口
 *   view.js     查看页入口
 *   chunk-*.js  两个入口共享的代码（marked / dompurify / crypto 等），
 *               以及运行期才 import 的模块（另一种语言、已创建屏的二维码）
 *   styles.css  由 src/styles.css 直接复制
 *
 * 因为 styles.css 是直接复制而非经过打包器，页面里没有内联样式，
 * CSP 的 style-src 'self' 才能站得住。
 *
 * 图片功能开关：feature-flag.mjs 读部署配置（有没有 r2_buckets）后经 esbuild define
 * 注入 __ENABLE_IMAGES__。关闭时图片相关的代码整块被死代码消除。
 */
import { copyFile, mkdir, readdir, rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import * as esbuild from 'esbuild';

import { imagesEnabled, writeActiveLocale } from './feature-flag.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outdir = resolve(root, 'public/assets');
const withImages = imagesEnabled();

/*
 * 语言这件事的接线口：先按部署配置生成 src/i18n/active.ts，
 * 之后 esbuild 打出来的包里「默认语言静态进主 chunk、另一种进独立 chunk」
 * 就由那份生成文件的内容直接保证（见 scripts/feature-flag.mjs）。
 */
const locale = writeActiveLocale();

/*
 * esbuild 只覆盖同名文件、不清理输出目录。
 * 上一次构建留下的旧 chunk 不会被删掉，HTML 也可能指向过期入口，
 * 所以每次都重建整个目录。public/assets/ 已在 .gitignore 中，删除是安全的。
 */
await rm(outdir, { recursive: true, force: true });
await mkdir(outdir, { recursive: true });

await esbuild.build({
  absWorkingDir: root,
  entryPoints: {
    create: 'src/client/create.ts',
    view: 'src/client/view.ts',
  },
  outdir,
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: 'es2022',
  splitting: true, // 两页共享 chunk，避免把 marked + dompurify 各打包一份
  entryNames: '[name]', // 固定名，HTML 里写死
  chunkNames: 'chunk-[hash]',
  minify: true,
  sourcemap: false,
  legalComments: 'none',
  // 保留 UTF-8：默认的 ascii 会把每个中文字符写成 6 个字符的 \uXXXX 转义，
  // 产物直接膨胀一倍多；gzip 后两者几乎一样，但 utf8 让首屏更小、产物也可读。
  charset: 'utf8',
  // 构建期常量：与部署配置同源（都看 r2_buckets 有没有）
  define: { __ENABLE_IMAGES__: String(withImages) },
});

await copyFile(resolve(root, 'src/styles.css'), resolve(outdir, 'styles.css'));

const files = (await readdir(outdir)).sort();
console.log(`[build] 图片功能：${withImages ? '已启用' : '已关闭'}`);
console.log(`[build] 默认语言：${locale}`);
console.log(`[build] 客户端构建完成 → public/assets/`);
console.log(`[build] 产物：${files.join('、')}`);
