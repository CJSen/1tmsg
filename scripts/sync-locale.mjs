/**
 * 按当前部署配置生成 src/i18n/active.ts。
 *
 * 单独成一个脚本是为了 npm run typecheck —— tsc 不跑构建，而 active.ts 不入库，
 * 没有这一步 typecheck 会在干净检出上直接报「找不到模块」。
 */
import { configFileName, defaultLocale, writeActiveLocale } from './feature-flag.mjs';

const locale = writeActiveLocale();
console.log(`[i18n] 默认语言：${locale} → src/i18n/active.ts`);
console.log(`[i18n] 另一种语言（${locale === 'zh' ? 'en' : 'zh'}）走按需加载，不进主包`);
console.log(
  `[i18n] 想改：编辑 ${configFileName()} 的 vars.DEFAULT_LOCALE（当前读取到 "${defaultLocale()}"）`,
);
