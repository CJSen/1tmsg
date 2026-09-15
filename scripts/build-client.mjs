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

import { imagesEnabled, writeActiveLocale, writeLegalConfig } from './feature-flag.mjs';

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
 * 页脚（内置用途告知 + 可选举报入口）：
 * 告知文案是内置的（字典键 foot.notice / foot.reportHint），配置只决定举报联系方式，
 * 生成到 src/legal.ts。留空时页脚不出现举报入口，footer.ts 也就不会建那个节点。
 */
const legal = writeLegalConfig();

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
console.log(`[build] 举报入口：${legal.report ? '已显示' : '⚠ 未配置（页脚不显示）'}`);
console.log(`[build] 客户端构建完成 → public/assets/`);
console.log(`[build] 产物：${files.join('、')}`);

/*
 * 没配举报联系方式时给一条显著提醒。
 *
 * **刻意不阻断构建**：README 写的是「最好填」，不是「必须填」。真做成硬性要求，
 * 那些不想开放举报渠道的人只会去填一个假地址 —— 那比空着更糟。
 * 页脚的用途告知文案是内置的，所以这里只提示联系方式这一项。
 */
if (!legal.report) {
  const rule = '─'.repeat(58);
  console.warn(
    [
      '',
      `  ⚠️  ${rule}`,
      '      未配置举报联系方式：vars.ABUSE_CONTACT 是空的',
      '',
      '      页脚因此不显示举报入口 —— 访客只看到「仅限合法用途」的告知，',
      '      却没有任何渠道向你报告违规内容（那句「下方方式」也不会出现）。',
      '      收到举报并及时处置，是「已履行管理职责」最直接的证明，建议填上。',
      '',
      '      怎么填（写进自己的配置，别改随仓库入库的那两份）：',
      '          "ABUSE_CONTACT": "abuse@example.com"     // 邮箱或 https 网址',
      '      然后：npm run deploy -- -c wrangler.me.jsonc',
      `  ⚠️  ${rule}`,
      '',
    ].join('\n'),
  );
}
