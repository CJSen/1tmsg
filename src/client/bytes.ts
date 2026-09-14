/** 字节 / base64url / 字符串工具 —— 全部分块处理，避免大 payload（≈10MB）炸栈或卡死 */

/**
 * WebCrypto 只接受 ArrayBuffer 支撑的视图，而 TS 5.7+ 给 TypedArray 加了 buffer 类型参数。
 * 统一用这个别名，避免 `Uint8Array<ArrayBufferLike>` 与 `BufferSource` 不兼容的噪音。
 */
export type Bytes = Uint8Array<ArrayBuffer>;

const B64_ALPHABET_RE = /^[A-Za-z0-9_-]*$/;

/** Uint8Array → base64url（无填充） */
export function b64u(bytes: Uint8Array): string {
  let bin = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** base64url（无填充）→ Uint8Array；非法输入抛错 */
export function unb64u(value: string): Bytes {
  if (!B64_ALPHABET_RE.test(value)) throw new Error('invalid base64url');
  const norm = value.replace(/-/g, '+').replace(/_/g, '/');
  const pad = norm.length % 4;
  if (pad === 1) throw new Error('invalid base64url length');
  const bin = atob(pad ? norm + '='.repeat(4 - pad) : norm);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out;
}

/** 安全版本：解析失败返回 null */
export function tryUnb64u(value: string): Bytes | null {
  try {
    return unb64u(value);
  } catch {
    return null;
  }
}

export function concat(...parts: Bytes[]): Bytes {
  const total = parts.reduce((n, p) => n + p.byteLength, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.byteLength;
  }
  return out;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function utf8(s: string): Bytes {
  return encoder.encode(s);
}

export function fromUtf8(bytes: ArrayBufferView): string {
  return decoder.decode(bytes);
}

/**
 * 安全随机字节。
 * `crypto.getRandomValues` 单次上限是 65536 字节（超出会抛 QuotaExceededError），
 * 因此必须分块填充 —— 大附件随机化、以及将来任何 >64KB 的随机需求都会踩到这一点。
 */
export function randomBytes(n: number): Bytes {
  const out = new Uint8Array(n);
  const MAX = 65536;
  for (let offset = 0; offset < n; offset += MAX) {
    crypto.getRandomValues(out.subarray(offset, Math.min(offset + MAX, n)));
  }
  return out;
}

/** 字节数 → 人类可读 */
export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}
