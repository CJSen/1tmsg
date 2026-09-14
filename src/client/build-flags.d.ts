/**
 * 图片功能开关的构建期常量：scripts/feature-flag.mjs 看部署配置里有没有 r2_buckets，
 * build-client.mjs 把它用 esbuild define 替换成字面量。换了部署模板要重新构建。
 *
 * 之所以声明成全局标识符而不是普通模块导出：两个入口 + splitting 下，共用模块会进
 * 共享 chunk，常量就内联不进引用方，`if (__ENABLE_IMAGES__)` 也就压不掉了。
 */
declare const __ENABLE_IMAGES__: boolean;
