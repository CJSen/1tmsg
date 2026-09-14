/**
 * 浏览器端加密与密钥派生 —— 对应 spec §7 / §8 / §12 / §24。
 *
 *   K_link     = 32B CSPRNG（只存在于 URL Fragment，永不发给服务器）
 *   K_password = PBKDF2-HMAC-SHA256(password, salt, 210000)  （16B salt 随密文存储）
 *   K_msg      = HKDF-SHA256(ikm = K_link ‖ K_password?, info = "1tmsg/v1/message-key")
 *   K_att(i)   = HKDF-SHA256(ikm = K_msg, info = "1tmsg/v1/attachment/<aid>")
 *   verifier   = HMAC-SHA256(K_password, "1tmsg/v1/pw-verify")
 *
 * 两条密文通路用**不同密钥**：文本 payload 用 K_msg，每张图片用各自的 K_att。
 * HKDF 的 info 做了域分隔，所以 K_att 推不出 K_msg，某一张图片的密钥也推不出另一张。
 * K_att 是确定性派生 —— 图片密钥无需任何额外存储，R2 上只有密文。
 *
 * verifier 只用于「先验密码、再决定是否消耗查看次数」，不参与任何密钥派生，
 * 因此服务器即使拿到它也无法解密（spec §12 要求密码错误不消耗查看次数）。
 */
import { KEY_BYTES } from '../config';
import {
  HKDF_INFO_ATTACHMENT,
  HKDF_INFO_MESSAGE_KEY,
  PW_VERIFIER_CONTEXT,
} from '../types';
import type { Attachment, MessagePayload } from '../types';
import { b64u, concat, fromUtf8, randomBytes, tryUnb64u, utf8 } from './bytes';
import type { Bytes } from './bytes';

/* ------------------------------------------------------------------ */
/* 密钥派生                                                            */
/* ------------------------------------------------------------------ */

async function importHkdf(ikm: Bytes): Promise<CryptoKey> {
  // 传副本，避免被底层 detach
  return crypto.subtle.importKey('raw', new Uint8Array(ikm), 'HKDF', false, ['deriveBits']);
}

/** 导入为不可导出的 AES-GCM 密钥 */
export async function importAesKey(bits: Bytes): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', new Uint8Array(bits), { name: 'AES-GCM' }, false, [
    'encrypt',
    'decrypt',
  ]);
}

/**
 * K_msg 原始字节。无密码时仅由 K_link 派生，有密码时由 K_link ‖ K_password 派生。
 *
 * 返回原始字节而不是直接返回 CryptoKey，是因为图片密钥要从它再派生一层：
 *   K_att = HKDF(ikm = K_msg, info = "1tmsg/v1/attachment/<aid>")
 * 需要加密／解密文本时自己 importAesKey() 一次即可。
 */
export async function deriveMessageKeyBits(
  kLink: Bytes,
  kPassword: Bytes | null,
): Promise<Bytes> {
  const ikm = kPassword ? concat(kLink, kPassword) : kLink;
  const base = await importHkdf(ikm);
  const bits = await crypto.subtle.deriveBits(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: new Uint8Array(0),
      info: utf8(HKDF_INFO_MESSAGE_KEY),
    },
    base,
    KEY_BYTES * 8,
  );
  return new Uint8Array(bits);
}

/**
 * 每张图片一个独立密钥，由 K_msg 经 HKDF 域分隔派生。
 *
 * 确定性派生意味着：图片密钥不需要任何额外存储，清单里也不放密钥材料 ——
 * 拿到 R2 的对象列表与 DO 的元数据表，也推不出任何密钥。
 */
export async function deriveAttachmentKey(kMsg: Bytes, aid: string): Promise<CryptoKey> {
  const base = await importHkdf(kMsg);
  const bits = await crypto.subtle.deriveBits(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: new Uint8Array(0),
      info: utf8(HKDF_INFO_ATTACHMENT + aid),
    },
    base,
    KEY_BYTES * 8,
  );
  return crypto.subtle.importKey('raw', bits, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

/** K_password = PBKDF2-HMAC-SHA256(password, salt, iterations) */
export async function derivePasswordKey(
  password: string,
  salt: Bytes,
  iterations: number,
): Promise<Bytes> {
  const base = await crypto.subtle.importKey(
    'raw',
    utf8(password.normalize('NFKC')),
    'PBKDF2',
    false,
    ['deriveBits'],
  );
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: new Uint8Array(salt), iterations, hash: 'SHA-256' },
    base,
    KEY_BYTES * 8,
  );
  return new Uint8Array(bits);
}

/** 服务器用来「先验密码、后消耗」的凭证；不含密码本身，也不泄露 K_msg */
export async function computeVerifier(kPassword: Bytes): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new Uint8Array(kPassword),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, utf8(PW_VERIFIER_CONTEXT));
  return b64u(new Uint8Array(sig));
}

/* ------------------------------------------------------------------ */
/* 加解密                                                              */
/* ------------------------------------------------------------------ */

export interface Ciphertext {
  ciphertext: string;
  iv: string;
}

export async function encryptPayload(key: CryptoKey, plaintext: Bytes): Promise<Ciphertext> {
  const iv = randomBytes(12);
  const ct = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: new Uint8Array(iv), tagLength: 128 },
    key,
    new Uint8Array(plaintext),
  );
  return { ciphertext: b64u(new Uint8Array(ct)), iv: b64u(iv) };
}

/** 解密失败（含 GCM tag 校验失败）会抛错 —— 这就是「密码错误」的判定依据 */
export async function decryptPayload(
  key: CryptoKey,
  ciphertext: string,
  iv: string,
): Promise<Bytes> {
  const ct = tryUnb64u(ciphertext);
  const ivBytes = tryUnb64u(iv);
  if (!ct || !ivBytes) throw new Error('ciphertext-corrupt');
  const pt = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: new Uint8Array(ivBytes), tagLength: 128 },
    key,
    new Uint8Array(ct),
  );
  return new Uint8Array(pt);
}

/**
 * 加密任意字节 —— 图片密文走这条。
 * 与文本 payload 的区别只是输入输出不是 base64：图片密文直接作为二进制对象存进 R2。
 */
export async function encryptBytes(
  key: CryptoKey,
  data: Bytes,
): Promise<{ bytes: Bytes; iv: string }> {
  const iv = randomBytes(12);
  const ct = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: new Uint8Array(iv), tagLength: 128 },
    key,
    new Uint8Array(data),
  );
  return { bytes: new Uint8Array(ct), iv: b64u(iv) };
}

/** 解密图片密文；GCM tag 校验失败会抛错（说明密钥不对或密文被改过） */
export async function decryptBytes(
  key: CryptoKey,
  data: Uint8Array,
  iv: string,
): Promise<Bytes> {
  const ivBytes = tryUnb64u(iv);
  if (!ivBytes) throw new Error('iv-corrupt');
  const pt = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: new Uint8Array(ivBytes), tagLength: 128 },
    key,
    new Uint8Array(data),
  );
  return new Uint8Array(pt);
}

/* ------------------------------------------------------------------ */
/* Payload                                                             */
/* ------------------------------------------------------------------ */

const PAYLOAD_VERSION_LOCAL = 1;

export function buildPayload(
  note: string,
  content: string,
  attachments: Attachment[],
  version: number = PAYLOAD_VERSION_LOCAL,
): MessagePayload {
  return { version, note, content, attachments };
}

export function serializePayload(payload: MessagePayload): Bytes {
  return utf8(JSON.stringify(payload));
}

/**
 * 解析解密后的 payload，字段缺失时给出安全默认值。
 *
 * 同时兼容两代结构：
 *   v1（改造前）附件自带 `data`，图片字节就内嵌在密文里；
 *   v2 附件自带 `iv`，图片密文是 R2 上的独立对象。
 * 两者只要有一个满足就保留 —— 历史消息必须还能打开。
 */
export function parsePayload(bytes: Uint8Array | Bytes): MessagePayload {
  const raw: unknown = JSON.parse(fromUtf8(bytes));
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new Error('payload-invalid');
  const p = raw as Partial<MessagePayload>;
  return {
    version: typeof p.version === 'number' ? p.version : PAYLOAD_VERSION_LOCAL,
    note: typeof p.note === 'string' ? p.note : '',
    content: typeof p.content === 'string' ? p.content : '',
    attachments: Array.isArray(p.attachments)
      ? p.attachments.filter((a): a is Attachment => {
          if (typeof a !== 'object' || a === null) return false;
          const att = a as Attachment;
          if (typeof att.id !== 'string') return false;
          return typeof att.iv === 'string' || typeof att.data === 'string';
        })
      : [],
  };
}

/* ------------------------------------------------------------------ */
/* URL Fragment（spec §8）                                             */
/* ------------------------------------------------------------------ */

export const FRAGMENT_PREFIX = 'v1.';

/** `v1.<base64url(K_link)>` */
export function buildFragment(kLink: Bytes): string {
  return FRAGMENT_PREFIX + b64u(kLink);
}

/** 解析 fragment；格式不对返回 null。K_link 必须是 32 字节。 */
export function parseFragment(hash: string): Bytes | null {
  const clean = hash.startsWith('#') ? hash.slice(1) : hash;
  if (!clean.startsWith(FRAGMENT_PREFIX)) return null;
  const key = tryUnb64u(clean.slice(FRAGMENT_PREFIX.length));
  if (!key || key.byteLength !== KEY_BYTES) return null;
  return key;
}
