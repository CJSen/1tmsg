/**
 * 全项目共享类型与常量（服务端 + 浏览器端）
 * 这里只放纯类型与纯常量/纯函数，不引用任何运行时 API，保证两端 tsconfig 都能编译。
 */

/** 消息生命周期状态 */
export type MessageStatus = 'pending' | 'active' | 'destroyed';

/** 文本密文 payload 版本号（图片内嵌在密文里） */
export const PAYLOAD_VERSION = 1;
/** payload 版本号：图片密文外置到 R2，清单只存元信息与 IV */
export const PAYLOAD_VERSION_R2 = 2;

/** URL Fragment 版本前缀：`#v1.<K_link>` */
export const FRAGMENT_VERSION = 'v1';

/** HKDF info：消息加密密钥 K_msg，隔离不同用途的派生结果 */
export const HKDF_INFO_MESSAGE_KEY = '1tmsg/v1/message-key';
/**
 * HKDF info 前缀：每张图片一个独立密钥
 *   K_att = HKDF(ikm = K_msg, info = "1tmsg/v1/attachment/" + aid)
 * 确定性派生 —— 图片密钥不需要任何额外存储，清单里不放密钥材料。
 */
export const HKDF_INFO_ATTACHMENT = '1tmsg/v1/attachment/';
/** 密码校验器 HMAC 的域分隔串 */
export const PW_VERIFIER_CONTEXT = '1tmsg/v1/pw-verify';

/**
 * R2 对象键前缀：`msg/<id>/<aid>`
 * 服务端按消息维度做 list/delete 的唯一依据，必须保持可前缀匹配。
 */
export const R2_KEY_PREFIX = 'msg/';

/** R2 对象键 */
export function r2Key(id: string, aid: string): string {
  return `${R2_KEY_PREFIX}${id}/${aid}`;
}

/* ------------------------------------------------------------------ */
/* 服务端存储                                                          */
/* ------------------------------------------------------------------ */

/** 客户端在创建请求里申报的附件，服务端据此分配上传槽位（只报形状，不报内容） */
export interface AttachmentSpec {
  id: string;
  /** 图片明文字节数。服务端按它预留上限，不做内容检查也看不到内容 */
  size: number;
}

/** Durable Object 中保存的一条消息。服务端永远只看到这些字段。 */
export interface MessageRecord {
  id: string;
  version: number;
  status: MessageStatus;
  /** base64url(12 字节 IV)，只服务文本 payload —— 图片各自有独立 IV */
  iv: string;
  /** base64url(16 字节 PBKDF2 salt)；无密码消息为 null */
  salt: string | null;
  /** PBKDF2 迭代次数；无密码消息为 null */
  kdfIterations: number | null;
  /**
   * 密码校验器 = HMAC-SHA256(K_password, PW_VERIFIER_CONTEXT)。
   * 只用于「先验密码、再决定是否消耗查看次数」，无密码消息为 null。
   * 注意：它不参与任何密钥派生，服务端拿到它也无法解密。
   */
  verifier: string | null;
  createdAt: number;
  expiresAt: number;
  maxViews: number;
  views: number;
  failedAttempts: number;
  /** 上传令牌，仅在 pending 阶段有效；无附件消息为 null */
  uploadToken: string | null;
  /** 一次性读取令牌，仅在 readTokenExpires 之前有效；每次 consume 换发 */
  readToken: string | null;
  readTokenExpires: number | null;
  /** R2 对象待清理标记。为 1 时 Alarm 会持续重试，直到对象清干净 */
  purgePending: number;
}

/** 服务端对外暴露的消息元数据（不含密文、不含附件标识） */
export interface MessageMeta {
  id: string;
  status: MessageStatus;
  expired: boolean;
  hasPassword: boolean;
  createdAt: number;
  expiresAt: number;
  maxViews: number;
  views: number;
  /** 剩余可查看次数 */
  remaining: number;
  /** 附件数量，仅用于界面提示 */
  attachmentCount: number;
  /**
   * PBKDF2 salt / 迭代次数。salt 本身不是机密（与 KDF 参数一起属于必须公开的派生参数，
   * 否则客户端无法在解密前算出 K_password）；密文不在这个接口里返回。
   */
  salt: string | null;
  kdfIterations: number | null;
}

/* ------------------------------------------------------------------ */
/* API 契约                                                            */
/* ------------------------------------------------------------------ */

/** POST /api/messages 请求体 —— 服务端只能看到这些 */
export interface CreateMessageRequest {
  /** 文本 payload 的密文（note + markdown + 附件清单） */
  ciphertext: string;
  iv: string;
  salt: string | null;
  kdfIterations: number | null;
  verifier: string | null;
  expiresInSeconds: number;
  maxViews: number;
  /** 空数组表示纯文本消息，直接进入 active；非空则先进入 pending */
  attachments: AttachmentSpec[];
}

export interface CreateMessageResponse {
  id: string;
  expiresAt: number;
  maxViews: number;
  /** 上传全部附件时使用的 Bearer 令牌；无附件时为 null */
  uploadToken: string | null;
}

/** POST /api/messages/:id/consume 请求体 */
export interface ConsumeRequest {
  /** 密码消息必须带上，服务端先验后消耗 */
  verifier?: string;
}

export interface ConsumeResponse {
  ciphertext: string;
  iv: string;
  salt: string | null;
  kdfIterations: number | null;
  /** 本次消费后剩余次数（0 表示已被销毁） */
  remaining: number;
  expiresAt: number;
  destroyed: boolean;
  /**
   * 拉取附件密文用的一次性令牌（`Authorization: Bearer`）。
   * 每次 consume 重新签发，旧令牌立即作废；无附件或已销毁时为 null。
   */
  readToken: string | null;
}

export interface ApiError {
  error: string;
  message: string;
  /**
   * 仅 `bad_password` 会带：锁定前还剩几次尝试机会（≥1）。
   * 归零那一次不再走这条错误，而是直接返回 `locked`（消息即刻进入锁定态）。
   */
  attemptsRemaining?: number;
}

/* ------------------------------------------------------------------ */
/* 客户端 payload（加密前 / 解密后）                                    */
/* ------------------------------------------------------------------ */

/**
 * 附件在解密后的 payload 里的形态。
 *
 * v1（改造前）：图片字节内嵌在密文里，走 `data`。
 * v2：图片密文是 R2 上的独立对象，这里只带元信息与 IV；密钥由 K_msg 确定性派生。
 * 两个字段都保留，是为了让 view.ts 能打开改造前的历史消息。
 */
export interface Attachment {
  id: string;
  name: string;
  type: string;
  size: number;
  /** v1：base64url(原始字节) */
  data?: string;
  /** v2：base64url(12 字节 IV) */
  iv?: string;
}

export interface MessagePayload {
  version: number;
  note: string;
  content: string;
  attachments: Attachment[];
}
