// ─────────────────────────────────────────────────────────────────────────────
// 1tmsg · 部署配置模板 —— 带图片功能
//
// 复制为 wrangler.jsonc 即可（首次构建也会自动生成；wrangler 只认这个文件名，
// 生成出来的正式文件不入库）。默认值开箱即用：npm install && npm run deploy
//
// 前提：本账号已开通 R2（控制台左侧 R2 → 按提示开通，需绑定支付方式），
// 且已建好下面那个桶。不想绑卡请改用 wrangler.jsonc.example ——
// 两份模板只差一段 r2_buckets 声明，本文件的存在本身就是「启用图片」的标志。
//
// ⚠️ 标「代码耦合」的字段与 src/ 里的绑定名、导出类名一一对应，不要改名，
//    否则运行时会报 "Cannot read properties of undefined"。
// ─────────────────────────────────────────────────────────────────────────────
{
  "$schema": "node_modules/wrangler/config-schema.json",

  "name": "1tmsg", // 同一账号下需唯一，也决定 *.workers.dev 地址的前缀
  "main": "src/index.ts",
  "compatibility_date": "2025-08-01",
  "compatibility_flags": ["nodejs_compat"],

  // 自定义域名（默认关闭，只走 *.workers.dev）。域名需已托管在 Cloudflare；
  // 启用后证书与 DNS 记录会自动创建，不要再手动为它建 A/CNAME 记录。
  // "routes": [{ "pattern": "1tmsg.example.com", "custom_domain": true }],

  // 启用上面的 routes 后本项会被默认关闭；只想走自定义域名就删掉这一行
  "workers_dev": true,

  "assets": {
    "directory": "./public",
    "binding": "ASSETS", // 代码耦合：env.ASSETS
    "not_found_handling": "none"
  },

  // 图片密文的对象存储；有这一段就是「带图片的版本」。桶必须保持私有
  // （不配公开域名、不签发 presigned URL），否则密文可被无限次下载。
  // 建桶（桶名需与下面一致）：
  //   npx wrangler r2 bucket create 1tmsg-blobs
  //   npx wrangler r2 bucket lifecycle add 1tmsg-blobs expire-old --expire-days 7
  //   （第二条是 7 天清理兜底；正常清理由 Durable Object Alarm 完成）
  "r2_buckets": [{ "binding": "BLOBS", "bucket_name": "1tmsg-blobs" }],

  "vars": {
    // 站点默认语言："zh" | "en"。构建期据此生成 src/i18n/active.ts 与页面文案，
    // 缺省按 zh 处理；不做浏览器语言自动跟随 —— 站点语言就是这个值，访客可用右上角按钮手动切换
    "DEFAULT_LOCALE": "zh",
    "MAX_MESSAGE_BYTES": "10485760",
    "MAX_ATTACHMENT_BYTES": "104857600", // 单张图片上限；合计上限（200MB）硬编码在 src/config.ts
    "RATE_LIMIT_MAX_CREATES": "30" // 每 IP 每分钟的创建上限
  },

  // 代码耦合：name 是 env 上的绑定名，class_name 必须与 src/ 导出的类名一致
  "durable_objects": {
    "bindings": [
      { "name": "MESSAGE_BOX", "class_name": "MessageBox" },
      { "name": "RATE_LIMITER", "class_name": "RateLimiter" }
    ]
  },

  // 首次部署据此创建 SQLite 存储的 DO 命名空间；已有线上数据时不要回改本段
  "migrations": [
    {
      "tag": "v1",
      "new_sqlite_classes": ["MessageBox", "RateLimiter"]
    }
  ],

  "observability": {
    "enabled": true
  }
}
