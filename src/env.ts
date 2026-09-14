/**
 * Worker 绑定（只含类型，无运行时依赖）
 */
import type { MessageBox } from './message-box';
import type { RateLimiter } from './rate-limiter';

export interface Env {
  /** 每条消息一个实例，名称 = 消息 ID */
  MESSAGE_BOX: DurableObjectNamespace<MessageBox>;
  /** 按 IP 分片的创建限流器 */
  RATE_LIMITER: DurableObjectNamespace<RateLimiter>;
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
}
