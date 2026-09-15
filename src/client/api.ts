import type {
  ConsumeResponse,
  CreateMessageRequest,
  CreateMessageResponse,
  MessageMeta,
} from '../types';
import { t, type MsgKey, type TParams } from '../i18n';
import type { Bytes } from './bytes';

/**
 * 服务端返回的结构化错误。
 *
 * message 在抛出时就已经按当前语言取好文案：优先按 error code 查客户端字典，
 * 字典里没有的 code 才回落到服务端原文（服务端文案是英文的 API 兜底，见 src/index.ts）。
 * rate_limited 的秒数来自 Retry-After 响应头，随 retryAfter 一起带出来。
 * bad_password 的剩余机会次数来自响应体的 attemptsRemaining（服务端计数，客户端不自己算）。
 */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly retryAfter?: number,
    readonly attemptsRemaining?: number,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/** error code → 客户端文案键。没列进来的 code 一律回落服务端 message */
const CODE_KEYS: Record<string, MsgKey> = {
  bad_request: 'err.bad_request',
  bad_json: 'err.bad_json',
  too_large: 'err.too_large',
  not_found: 'err.not_found',
  gone: 'err.gone',
  not_ready: 'err.not_ready',
  password_required: 'err.password_required',
  bad_password: 'err.bad_password',
  locked: 'err.locked',
  unauthorized: 'err.unauthorized',
  forbidden: 'err.forbidden',
  images_disabled: 'err.images_disabled',
  incomplete: 'err.incomplete',
  rate_limited: 'err.rate_limited',
  storage_capacity_reached: 'err.storage_capacity_reached',
  id_collision: 'err.id_collision',
  method_not_allowed: 'err.method_not_allowed',
  length_required: 'err.length_required',
  asset_missing: 'err.asset_missing',
  internal: 'err.internal',
};

function localizedError(
  status: number,
  code: string,
  serverMessage: string,
  retryAfter?: number,
  attemptsRemaining?: number,
): ApiError {
  const key = CODE_KEYS[code];
  if (key === undefined) {
    const fallback = serverMessage.length > 0 ? serverMessage : t('err.unknown');
    return new ApiError(status, code, fallback, retryAfter, attemptsRemaining);
  }
  /* 两个 code 用同一个 n：rate_limited 取秒数，bad_password 取剩余机会次数 */
  const n = retryAfter ?? attemptsRemaining;
  const params: TParams | undefined = n === undefined ? undefined : { n };
  return new ApiError(status, code, t(key, params), retryAfter, attemptsRemaining);
}

/** Retry-After 头（秒）。缺省或非数字按没给处理 */
function retryAfterOf(res: Response): number | undefined {
  const raw = Number(res.headers.get('retry-after'));
  return Number.isFinite(raw) && raw > 0 ? raw : undefined;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      ...init,
      credentials: 'omit',
      cache: 'no-store',
      referrerPolicy: 'no-referrer',
      headers: { Accept: 'application/json', ...(init?.headers ?? {}) },
    });
  } catch {
    throw new ApiError(0, 'network', t('err.network'));
  }

  const text = await res.text();
  let data: unknown = null;
  if (text.length > 0) {
    try {
      data = JSON.parse(text);
    } catch {
      /* 非 JSON 响应（例如边缘错误页）留给下面按状态码处理 */
    }
  }

  if (!res.ok) {
    const body = (data ?? {}) as { error?: string; message?: string; attemptsRemaining?: number };
    const fallback = body.message ?? t('err.http', { status: res.status });
    const remaining = typeof body.attemptsRemaining === 'number' ? body.attemptsRemaining : undefined;
    throw localizedError(res.status, body.error ?? 'error', fallback, retryAfterOf(res), remaining);
  }
  if (data === null) throw new ApiError(res.status, 'bad_response', t('err.badResponse'));
  return data as T;
}

/** 从失败响应里还原结构化错误（用于二进制通道，响应体可能不是 JSON） */
async function toApiError(res: Response): Promise<ApiError> {
  let body: { error?: string; message?: string; attemptsRemaining?: number } = {};
  try {
    const text = await res.text();
    if (text.length > 0) body = JSON.parse(text) as typeof body;
  } catch {
    /* 边缘错误页等非 JSON 响应，退回状态码文案 */
  }
  const fallback = body.message ?? t('err.http', { status: res.status });
  const remaining = typeof body.attemptsRemaining === 'number' ? body.attemptsRemaining : undefined;
  return localizedError(res.status, body.error ?? 'error', fallback, retryAfterOf(res), remaining);
}

export const api = {
  createMessage(body: CreateMessageRequest): Promise<CreateMessageResponse> {
    return request<CreateMessageResponse>('/api/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  },

  /** 只读元数据：不会消耗查看次数，也不含密文 */
  getMeta(id: string): Promise<MessageMeta> {
    return request<MessageMeta>(`/api/messages/${encodeURIComponent(id)}`);
  },

  consume(id: string, verifier?: string): Promise<ConsumeResponse> {
    return request<ConsumeResponse>(`/api/messages/${encodeURIComponent(id)}/consume`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(verifier ? { verifier } : {}),
    });
  },

  /**
   * 创建流程中途失败时的回滚：销毁半条消息并清掉已上传的 R2 对象。
   * 尽力而为 —— 失败也只记日志，绝不覆盖用户真正需要看到的那条报错。
   */
  async discard(id: string): Promise<void> {
    try {
      await fetch(`/api/messages/${encodeURIComponent(id)}`, {
        method: 'DELETE',
        credentials: 'omit',
        cache: 'no-store',
        referrerPolicy: 'no-referrer',
      });
    } catch {
      /* 忽略：服务端那边还有 pending 超时与桶生命周期兜底 */
    }
  },

  /**
   * 上传单张图片密文。
   * 二进制直传，不走 JSON —— 密文本身已经是随机字节，base64 只会白白膨胀 1/3。
   */
  async uploadAttachment(
    id: string,
    aid: string,
    uploadToken: string,
    bytes: Bytes,
  ): Promise<void> {
    let res: Response;
    try {
      res = await fetch(
        `/api/messages/${encodeURIComponent(id)}/att/${encodeURIComponent(aid)}`,
        {
          method: 'PUT',
          credentials: 'omit',
          cache: 'no-store',
          referrerPolicy: 'no-referrer',
          headers: {
            'Content-Type': 'application/octet-stream',
            Authorization: `Bearer ${uploadToken}`,
          },
          body: bytes,
        },
      );
    } catch {
      throw new ApiError(0, 'network', t('err.uploadFailed'));
    }
    if (!res.ok) throw await toApiError(res);
  },

  /** 全部附件就位后才能被查看 —— 服务端会核对上传齐活情况 */
  async finalize(id: string, uploadToken: string): Promise<void> {
    await request<{ status: string }>(`/api/messages/${encodeURIComponent(id)}/finalize`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${uploadToken}` },
    });
  },

  /** 取回单张图片密文（原始字节，尚未解密） */
  async fetchAttachment(id: string, aid: string, readToken: string): Promise<Uint8Array> {
    let res: Response;
    try {
      res = await fetch(
        `/api/messages/${encodeURIComponent(id)}/att/${encodeURIComponent(aid)}`,
        {
          credentials: 'omit',
          cache: 'no-store',
          referrerPolicy: 'no-referrer',
          headers: { Authorization: `Bearer ${readToken}` },
        },
      );
    } catch {
      throw new ApiError(0, 'network', t('err.downloadFailed'));
    }
    if (!res.ok) throw await toApiError(res);
    return new Uint8Array(await res.arrayBuffer());
  },
};
