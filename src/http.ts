import type { ApiError } from './types';

/* ------------------------------------------------------------------ */
/* 安全响应头                                                          */
/* ------------------------------------------------------------------ */

/**
 * 严格 CSP：脚本/样式全部自托管，图片只允许 self / data: / blob:。
 * connect-src 'self' —— 密文只回自己的服务器，不向任何第三方外发。
 */
export const CONTENT_SECURITY_POLICY = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data: blob:",
  "font-src 'self'",
  "connect-src 'self'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  "object-src 'none'",
].join('; ');

export const BASE_SECURITY_HEADERS: ReadonlyArray<readonly [string, string]> = [
  ['X-Content-Type-Options', 'nosniff'],
  ['Referrer-Policy', 'no-referrer'],
  ['Cross-Origin-Opener-Policy', 'same-origin'],
  ['Cross-Origin-Resource-Policy', 'same-origin'],
  ['X-Frame-Options', 'DENY'],
  /*
   * `no-transform` 不是可选项：自定义域名（zone 级）上 Cloudflare 会往 HTML 里
   * 自动注入 RUM 探针 static.cloudflareinsights.com/beacon.min.js。它被我们的 CSP
   * 挡下（脚本从未发起请求，无数据外泄），但注入本身就是对端到端加密承诺的破坏——
   * 解密后的明文就在同源 DOM 里，任何第三方脚本都等于把明文交给了服务器侧。
   * 按 Cloudflare 文档，`no-transform` 声明后代理不得改写响应体，注入随之失效。
   */
  ['Cache-Control', 'no-store, no-transform'],
];

/** 给任意响应套上安全响应头；`csp` 为 true 时追加严格 CSP（仅 HTML 需要） */
export function secure(res: Response, csp = false): Response {
  const out = new Response(res.body, res);
  for (const [k, v] of BASE_SECURITY_HEADERS) out.headers.set(k, v);
  if (csp) out.headers.set('Content-Security-Policy', CONTENT_SECURITY_POLICY);
  return out;
}

/* ------------------------------------------------------------------ */
/* JSON 响应                                                           */
/* ------------------------------------------------------------------ */

export function json(data: unknown, status = 200): Response {
  return secure(
    new Response(JSON.stringify(data), {
      status,
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
    }),
  );
}

export function fail(status: number, error: string, message: string): Response {
  const body: ApiError = { error, message };
  return json(body, status);
}

/* ------------------------------------------------------------------ */
/* base64url                                                           */
/* ------------------------------------------------------------------ */

const B64U_RE = /^[A-Za-z0-9_-]+$/;

/** 严格校验（无填充）的 base64url 字符串；expectedBytes 可选，用于校验解码长度 */
export function isValidB64u(value: unknown, expectedBytes?: number): value is string {
  if (typeof value !== 'string' || value.length === 0) return false;
  if (value.length > 32 * 1024 * 1024) return false;
  if (!B64U_RE.test(value)) return false;
  if (expectedBytes === undefined) return true;
  return b64uToBytes(value).byteLength === expectedBytes;
}

/** base64url → Uint8Array（无填充） */
export function b64uToBytes(value: string): Uint8Array {
  let s = value.replace(/-/g, '+').replace(/_/g, '/');
  const pad = s.length % 4;
  if (pad === 1) throw new Error('invalid base64url length');
  if (pad) s += '='.repeat(4 - pad);
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out;
}

/** Uint8Array → base64url（无填充） */
export function bytesToB64u(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 1) bin += String.fromCharCode(bytes[i] as number);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** 定长编码字节数 → base64url 字符数（无填充） */
export function b64uLength(byteLength: number): number {
  return Math.ceil((byteLength * 4) / 3);
}

/* ------------------------------------------------------------------ */
/* 其它工具                                                            */
/* ------------------------------------------------------------------ */

/** 定长时间比较，避免通过响应时间侧信道推断 verifier */
export function timingSafeEqual(a: string, b: string): boolean {
  const x = new TextEncoder().encode(a);
  const y = new TextEncoder().encode(b);
  // 长度不同也要走完全程，避免提前返回泄露长度
  let diff = x.length ^ y.length;
  const n = Math.max(x.length, y.length);
  for (let i = 0; i < n; i += 1) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

const ID_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

/** 生成不可枚举的消息 ID（默认 20 字符 ≈ 120 bit 熵） */
export function randomId(length: number): string {
  const buf = new Uint8Array(length);
  crypto.getRandomValues(buf);
  let out = '';
  for (let i = 0; i < length; i += 1) {
    // 256 % 64 === 0，取模无偏
    out += ID_ALPHABET[(buf[i] as number) % 64];
  }
  return out;
}

/** 解析并限制请求体大小 */
export async function readJsonBody(req: Request, maxBytes: number): Promise<unknown> {
  const len = Number(req.headers.get('content-length') ?? '0');
  if (Number.isFinite(len) && len > maxBytes) throw new HttpError(413, 'too_large', 'Message over the size limit');
  const buf = await req.arrayBuffer();
  if (buf.byteLength > maxBytes) throw new HttpError(413, 'too_large', 'Message over the size limit');
  try {
    return JSON.parse(new TextDecoder().decode(buf));
  } catch {
    throw new HttpError(400, 'bad_json', 'Request body is not valid JSON');
  }
}

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

/** 客户端 IP（本地 wrangler dev 没有 CF-Connecting-IP） */
export function clientKey(req: Request): string {
  const cf = req.headers.get('cf-connecting-ip');
  if (cf) return cf;
  const xff = req.headers.get('x-forwarded-for');
  if (xff) return (xff.split(',')[0] ?? '').trim() || 'local';
  return 'local';
}
