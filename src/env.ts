/**
 * Worker 绑定（只含类型，无运行时依赖）
 */
import type { MessageBox } from './message-box';
import type { RateLimiter } from './rate-limiter';
import type { StorageGuard } from './storage-guard';

export interface Env {
  /** 每条消息一个实例，名称 = 消息 ID */
  MESSAGE_BOX: DurableObjectNamespace<MessageBox>;
  /** 按 IP 分片的创建限流器 */
  RATE_LIMITER: DurableObjectNamespace<RateLimiter>;
  /** 全局容量计数器（单例，实例名固定为 'global'）。图片总量红线的唯一真源 */
  STORAGE_GUARD: DurableObjectNamespace<StorageGuard>;
  /** 静态资源绑定 */
  ASSETS: Fetcher;
  /**
   * 图片密文的对象存储，桶必须保持私有（不暴露域名、不签发 presigned URL）。
   * 可选：关闭图片功能时部署配置里不声明 r2_buckets，这里就是 undefined ——
   * 它是「图片功能是否可用」的唯一判据。
   */
  BLOBS?: R2Bucket;
  /** 文本密文体积上限（字符串形式的字节数，来自 wrangler vars） */
  MAX_MESSAGE_BYTES: string;
  /** 单张图片密文体积上限（字符串形式的字节数，来自 wrangler vars） */
  MAX_ATTACHMENT_BYTES?: string;
  /** 每 IP 每窗口的创建次数上限（可运维调整，缺省用 config 里的值） */
  RATE_LIMIT_MAX_CREATES?: string;
  /**
   * 全局预留容量上限，**以 GB 为单位**（字符串形式的数字，支持小数，如 "0.5"）。
   * 缺省用 src/config.ts 的 MAX_R2_STORAGE_GB（5 GB）—— 这里留口子是为了让部署者
   * 能按实例规模收紧，也让自动化测试能把上限压到 1 MB 以下。
   * `"0"` 是合法值：等于不再接受任何带图片的消息。
   */
  MAX_R2_STORAGE_GB?: string;
  /**
   * 计数器首次建立时一次性计入的历史占用，**以 GB 为单位**（支持小数）。
   * 升级已在运行的实例时填桶的当前用量（R2 控制台按 GB 显示），详见 src/config.ts 的注释。
   */
  INITIAL_RESERVED_GB?: string;
  /**
   * 「等附件传完」的上传窗口（毫秒）。缺省用 config 的 PENDING_TTL_MS（10 分钟）。
   * 这个口子只服务于自动化测试：把窗口压到几秒，才能在测试里真的跑完
   * 「上传超时 → 清理 → 释放预留」这条链路，而不用干等十分钟。
   */
  PENDING_TTL_MS?: string;
  /**
   * 销毁后仍允许下载附件的宽限期（毫秒）。缺省用 config 的 READ_TOKEN_TTL_MS（5 分钟）。
   * 同样是给测试用的：压到几秒就能验证「宽限期结束 → 清 R2 → 释放预留」。
   */
  READ_TOKEN_TTL_MS?: string;
}
