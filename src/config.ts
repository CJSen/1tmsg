/**
 * 限制与默认配置 —— 服务端与浏览器端共用同一份数字，避免两侧漂移。
 */

/* 查看次数 */
export const MIN_VIEWS = 1;
export const MAX_VIEWS = 100;
export const DEFAULT_VIEWS = 5;

/* 过期时间（秒）。UI 上的档位按钮直接写死在页面里（data-ttl），
   文案由 i18n 生成（ttl.h1…与 unit.*），这里只保留上下限与默认值 */
export const MIN_TTL_SECONDS = 3 * 60; // 最短 3 分钟（再短会让收件人来不及打开）
export const MAX_TTL_SECONDS = 7 * 24 * 60 * 60; // 7 天
export const DEFAULT_TTL_SECONDS = 60 * 60; // 1 小时

/* 体积限制 */
export const MB = 1024 * 1024;
export const GB = 1024 * MB;
/**
 * 文本密文上限 10MB。
 * 改造后图片不再内嵌在文本 payload 里，这条限制只作用于 note + markdown，
 * 与图片体积彻底解耦。改造前两者共享同一个上限，而消息上限校验的是「已 base64 的
 * 明文」，于是 10MB 原图会先撞上消息上限 —— 图片实际只能发约 7.5MB。
 */
export const MAX_MESSAGE_BYTES = 10 * MB;
/**
 * 单张图片明文上限（图片密文作为独立对象存进 R2，不再受消息上限约束）。
 * 可在部署配置里用 `vars.MAX_ATTACHMENT_BYTES` 覆盖。
 */
export const MAX_ATTACHMENT_BYTES = 10 * MB;
/**
 * 单条消息所有图片明文合计上限。**硬编码，不走 vars**（见 wrangler 配置里的注释）。
 *
 * 它比「单张上限 × 最多张数」更紧：10MB × 8 张 = 80MB > 50MB，
 * 所以实际上「能发几张」取决于这条合计上限 —— 例如 5 张 10MB 就到顶了。
 * 这条限制同时决定了全局容量保险单条消息最多预留多少（≤ 50MB）。
 */
export const MAX_TOTAL_ATTACHMENT_BYTES = 50 * MB;
/** 备注长度上限 */
export const MAX_NOTE_LENGTH = 120;
/** 附件 ID 长度上限（服务端校验用） */
export const ATTACHMENT_ID_MAX = 64;

/* 密码 */
export const MIN_PASSWORD_LENGTH = 6;
export const PBKDF2_ITERATIONS = 210_000;
export const PBKDF2_SALT_BYTES = 16;
/**
 * **连续**验密失败达到该次数后锁定消息，防止在线爆破。
 * 成功验密会把计数清零，所以这是「连着输错几次」而非消息生命周期内的累计值。
 * 锁定的消息不再可查看、不可恢复，只能等到期后由 Alarm 销毁。
 */
export const MAX_FAILED_UNLOCK = 10;

/* 密钥字节数 */
export const KEY_BYTES = 32;
export const IV_BYTES = 12;

/* 消息 ID */
/** base64url 字符集下的长度，20 字符 ≈ 120 bit 熵，避免被枚举消费 */
export const MESSAGE_ID_LENGTH = 20;

/* 限流：每 IP 每个窗口允许的创建次数 */
export const RATE_LIMIT_WINDOW_MS = 60_000;
export const RATE_LIMIT_MAX_CREATES = 30;

/* 客户端交互限制 */
export const MAX_ATTACHMENTS = 8;
export const MAX_CONTENT_LENGTH = 60_000;

/* ------------------------------------------------------------------ */
/* 两段式写入与对象存储的时序参数（spec §24）                            */
/* ------------------------------------------------------------------ */

/**
 * 创建后等待全部图片上传完成的窗口。
 * 超时按「未完成」处理：直接销毁元数据并清掉已上传的对象，避免留下半条消息。
 */
export const PENDING_TTL_MS = 10 * 60 * 1000;
/**
 * 一次性读取令牌的有效期 —— 附件密文的可下载窗口。
 * 令牌不续期、不重用：每次 consume 都换发新的，旧令牌立即作废。
 */
export const READ_TOKEN_TTL_MS = 5 * 60 * 1000;
/** R2 对象清理失败后的重试间隔（由 Alarm 兜底） */
export const PURGE_RETRY_MS = 60 * 1000;
/** 上传令牌 / 读取令牌的字符数。字母表 64 字符、每字符恰好 6 bit，32 字符 = 192 bit */
export const TOKEN_CHARS = 32;

/* ------------------------------------------------------------------ */
/* 全局 R2 容量保险                                                     */
/* ------------------------------------------------------------------ */

/**
 * 整个桶允许被消息**预留**的总量上限，5 GB。
 *
 * 它不是 R2 的实时用量，而是「系统已经承诺给现存消息与在途上传的最大空间」：
 * 每条带附件的消息在创建**之前**按申报体积原子预留，消息销毁时释放。
 * 于是 `reservedBytes <= MAX_R2_STORAGE_BYTES` 恒成立，而 R2 的实际占用只会更少。
 *
 * 预留而非「上传完再统计」，是因为后者在并发下必然超额：
 * 若干请求同时看到「还差 100MB 到上限」，就会各自放行，总量一起越界。
 */
export const MAX_R2_STORAGE_GB = 5;
/** 上限的字节形式 —— 代码里一律用它比较，配置里则以 GB 为单位填（vars.MAX_R2_STORAGE_GB） */
export const MAX_R2_STORAGE_BYTES = MAX_R2_STORAGE_GB * GB;

/**
 * 计数器首次建立时一次性计入的「历史占用」，默认 0 —— 适用于全新部署。
 *
 * 为什么需要它：消息 ID 随机生成且不集中保存，没有任何地方能枚举出「现存消息
 * 各自预留了多少」，历史预留**无法从数据推回来**。升级一个已经在跑的实例时，
 * 先看桶的当前用量（R2 控制台就按 GB 显示），把它填进 vars.INITIAL_RESERVED_GB，
 * 再部署。它只在计数器第一次建立时生效 —— 之后改这个值不会重复计入。
 */
export const INITIAL_RESERVED_GB = 0;
/** 同上，字节形式 */
export const INITIAL_RESERVED_BYTES = INITIAL_RESERVED_GB * GB;

/**
 * 全局容量计数器 Durable Object 的固定实例名。
 * 容量是全局量，必须单例 —— 所有请求都落到这一个实例上，由它串行化 reserve/release。
 */
export const STORAGE_GUARD_NAME = 'global';
