/**
 * 1tmsg · Worker 入口与路由
 *
 * 路由表（spec §19 / §24）：
 *   POST   /api/messages                 创建消息（唯一写入点，带限流）
 *   GET    /api/messages/:id             读取元数据（不消耗查看次数、不含密文）
 *   POST   /api/messages/:id/consume      原子消费并取回文本密文 + 一次性读取令牌
 *   POST   /api/messages/:id/finalize     附件全部就位后把消息推进到 active
 *   PUT    /api/messages/:id/att/:aid     写入图片密文（Bearer 上传令牌）→ R2
 *   GET    /api/messages/:id/att/:aid     读取图片密文（Bearer 读取令牌）← R2
 *   DELETE /api/messages/:id             主动销毁（可选）
 *   GET    /m/:id                        返回查看页（不消费）
 *   其它                                 → 静态资源
 *
 * 两条密文通路刻意分离：
 *   文本密文（note + markdown + 附件清单）→ Durable Object SQLite
 *   图片密文（每张一个对象）            → R2，键 `msg/<id>/<aid>`
 * 两者都用 AES-GCM，但**密钥不同**（图片密钥由 K_msg 经 HKDF 域分隔派生）。
 *
 * 图片功能整体可关：部署配置里不声明 r2_buckets 即可（见 wrangler.jsonc 与 wrangler.images.jsonc）。
 * 此时 env.BLOBS 为 undefined —— /att 两条路由 404，创建接口拒绝带附件的请求。
 * 「绑定是否存在」是唯一判据，前端构建期也看同一处，两边不会漂移。
 *
 * R2 桶保持私有：不配置公开域名、不签发 presigned URL。所有对象读写都要先过
 * DO 的令牌校验，再由 Worker 流式转发 —— 否则密文可被无限次重复下载，
 * 「阅后即焚」就只剩个说法。
 *
 * 静态资源优先命中，未命中的路径才落到这里；因此 /api/* 与 /m/* 必然由本文件处理。
 */
import {
  ATTACHMENT_ID_MAX,
  DEFAULT_TTL_SECONDS,
  IV_BYTES,
  KEY_BYTES,
  MAX_ATTACHMENTS,
  MAX_ATTACHMENT_BYTES,
  MAX_MESSAGE_BYTES,
  MAX_TOTAL_ATTACHMENT_BYTES,
  MAX_TTL_SECONDS,
  MAX_VIEWS,
  MESSAGE_ID_LENGTH,
  MIN_TTL_SECONDS,
  MIN_VIEWS,
  PBKDF2_SALT_BYTES,
  RATE_LIMIT_MAX_CREATES,
  RATE_LIMIT_WINDOW_MS,
} from './config';
import type { Env } from './env';
import {
  b64uToBytes,
  clientKey,
  fail,
  HttpError,
  isValidB64u,
  json,
  randomId,
  readJsonBody,
  secure,
} from './http';
import { MessageBox } from './message-box';
import { RateLimiter } from './rate-limiter';
import type {
  AttachmentSpec,
  ConsumeRequest,
  ConsumeResponse,
  CreateMessageRequest,
} from './types';
import { r2Key } from './types';

export { MessageBox, RateLimiter };

const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
/** 附件 ID 的形状约束 —— 它会成为 R2 对象键的一段，必须严格 */
const AID_RE = new RegExp(`^[A-Za-z0-9_-]{1,${ATTACHMENT_ID_MAX}}$`);

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    try {
      if (url.pathname.startsWith('/api/')) return await routeApi(req, env, url);
      if (url.pathname === '/m' || url.pathname.startsWith('/m/')) return await viewPage(env, url);
      return await env.ASSETS.fetch(req);
    } catch (err) {
      if (err instanceof HttpError) return fail(err.status, err.code, err.message);
      console.error('[1tmsg] unhandled error', err);
      return fail(500, 'internal', 'Internal server error');
    }
  },
} satisfies ExportedHandler<Env>;

/* ------------------------------------------------------------------ */
/* 页面                                                                */
/* ------------------------------------------------------------------ */

/** GET /m/:id —— 只返回查看页外壳，不含任何消息数据，也不消耗查看次数 */
async function viewPage(env: Env, url: URL): Promise<Response> {
  const assetUrl = new URL('/m.html', url.origin);
  const res = await env.ASSETS.fetch(new Request(assetUrl, { method: 'GET' }));
  if (!res.ok) return fail(500, 'asset_missing', 'Page asset missing');
  const out = secure(
    new Response(res.body, {
      status: 200,
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
    }),
    true,
  );
  out.headers.set('X-Robots-Tag', 'noindex, nofollow, noarchive');
  return out;
}

/* ------------------------------------------------------------------ */
/* API 路由                                                            */
/* ------------------------------------------------------------------ */

async function routeApi(req: Request, env: Env, url: URL): Promise<Response> {
  // ['api','messages', id?, action?, aid?]
  const seg = url.pathname.split('/').filter(Boolean);
  if (seg[0] !== 'api' || seg[1] !== 'messages') {
    return fail(404, 'not_found', 'No such endpoint');
  }

  const id = seg[2];
  const action = seg[3];
  const aid = seg[4];

  /* POST /api/messages */
  if (id === undefined) {
    if (seg.length !== 2) return fail(404, 'not_found', 'No such endpoint');
    if (req.method !== 'POST') return methodNotAllowed('POST');
    return createMessage(req, env);
  }

  if (!ID_RE.test(id)) return fail(404, 'not_found', 'No such message');

  const stub = env.MESSAGE_BOX.get(env.MESSAGE_BOX.idFromName(id));

  /* /api/messages/:id */
  if (action === undefined) {
    if (seg.length !== 3) return fail(404, 'not_found', 'No such endpoint');
    if (req.method === 'GET') {
      const meta = await stub.meta();
      if (!meta) return fail(404, 'not_found', 'Message not found or already destroyed');
      return json(meta);
    }
    if (req.method === 'DELETE') {
      const ok = await stub.destroy();
      return ok ? json({ destroyed: true }) : fail(404, 'not_found', 'Message not found or already destroyed');
    }
    return methodNotAllowed('GET, DELETE');
  }

  if (seg.length > 5) return fail(404, 'not_found', 'No such endpoint');

  /* /api/messages/:id/consume */
  if (action === 'consume' && seg.length === 4) {
    if (req.method !== 'POST') return methodNotAllowed('POST');
    const body = await readOptionalJson<ConsumeRequest>(req, 4096);
    const verifier = typeof body.verifier === 'string' ? body.verifier : undefined;
    const result = await stub.consume(verifier);
    if (!result.ok) return consumeFailure(result.reason);
    return json(result.data satisfies ConsumeResponse);
  }

  /* /api/messages/:id/finalize */
  if (action === 'finalize' && seg.length === 4) {
    if (req.method !== 'POST') return methodNotAllowed('POST');
    const token = bearer(req);
    if (!token) return fail(401, 'unauthorized', 'Missing upload token');
    const result = await stub.finalize(token);
    if (!result.ok) return finalizeFailure(result.reason);
    return json({ status: result.status });
  }

  /* /api/messages/:id/att/:aid —— 未启用图片功能时这条通路整体不存在 */
  if (action === 'att' && seg.length === 5 && aid !== undefined) {
    if (!imagesEnabled(env)) return fail(404, 'not_found', 'No such endpoint');
    if (!AID_RE.test(aid)) return fail(404, 'not_found', 'No such attachment');
    if (req.method === 'PUT') return uploadAttachment(req, env, stub, id, aid);
    if (req.method === 'GET') return downloadAttachment(req, env, stub, id, aid);
    return methodNotAllowed('GET, PUT');
  }

  return fail(404, 'not_found', 'No such endpoint');
}

/** 图片功能是否可用。以 R2 绑定是否存在为准 —— 配置层与运行时不会各说各话 */
function imagesEnabled(env: Env): boolean {
  return env.BLOBS !== undefined;
}

function methodNotAllowed(allow: string): Response {
  const res = fail(405, 'method_not_allowed', 'Method not allowed');
  res.headers.set('Allow', allow);
  return res;
}

function consumeFailure(reason: string): Response {
  switch (reason) {
    case 'not_found':
      return fail(404, 'not_found', 'Message not found or already destroyed');
    case 'gone':
      return fail(410, 'gone', 'Message destroyed or expired');
    case 'not_ready':
      return fail(409, 'not_ready', 'Message is still uploading. Try again shortly.');
    case 'password_required':
      return fail(401, 'password_required', 'This message requires a password');
    case 'bad_password':
      return fail(401, 'bad_password', 'Wrong password');
    case 'locked':
      return fail(423, 'locked', 'Too many wrong passwords - message locked');
    default:
      return fail(500, 'internal', 'Internal server error');
  }
}

function finalizeFailure(reason: string): Response {
  switch (reason) {
    case 'gone':
      return fail(410, 'gone', 'Message destroyed or expired');
    case 'bad_token':
      return fail(401, 'unauthorized', 'Invalid upload token');
    case 'incomplete':
      return fail(409, 'incomplete', 'Some attachments have not finished uploading');
    default:
      return fail(500, 'internal', 'Internal server error');
  }
}

function uploadFailure(reason: string): Response {
  switch (reason) {
    case 'gone':
      return fail(410, 'gone', 'Message destroyed or expired');
    case 'bad_token':
      return fail(401, 'unauthorized', 'Invalid upload token');
    case 'bad_aid':
      return fail(404, 'not_found', 'No such attachment');
    case 'too_large':
      return fail(413, 'too_large', 'Attachment over the size limit');
    default:
      return fail(500, 'internal', 'Internal server error');
  }
}

/** 从 `Authorization: Bearer <token>` 取出令牌 */
function bearer(req: Request): string | null {
  const raw = req.headers.get('authorization');
  if (!raw) return null;
  const matched = /^Bearer\s+(\S+)$/i.exec(raw.trim());
  return matched?.[1] ?? null;
}

/* ------------------------------------------------------------------ */
/* 创建                                                                */
/* ------------------------------------------------------------------ */

async function createMessage(req: Request, env: Env): Promise<Response> {
  const maxBytes = Number(env.MAX_MESSAGE_BYTES) || MAX_MESSAGE_BYTES;
  const maxAttachmentBytes = Number(env.MAX_ATTACHMENT_BYTES) || MAX_ATTACHMENT_BYTES;

  /*
   * 先校验、后限流。
   * 被拒绝的畸形请求不应该消耗调用方自己的限流额度 —— 否则一次写错客户端的
   * 重试风暴会把自己锁在门外。解析成本由 readJsonBody 的体积上限兜住。
   */
  const raw = await readJsonBody(req, Math.ceil((maxBytes * 4) / 3) + 8192);
  const input = validateCreate(raw, maxBytes, maxAttachmentBytes, imagesEnabled(env));

  const maxCreates = Number(env.RATE_LIMIT_MAX_CREATES) || RATE_LIMIT_MAX_CREATES;
  const limiter = env.RATE_LIMITER.get(env.RATE_LIMITER.idFromName(clientKey(req)));
  const limit = await limiter.hit(maxCreates, RATE_LIMIT_WINDOW_MS);
  if (!limit.ok) {
    const retryAfter = Math.max(1, Math.ceil((limit.resetAt - Date.now()) / 1000));
    const res = fail(429, 'rate_limited', `Too many messages created. Retry in ${retryAfter} seconds.`);
    res.headers.set('Retry-After', String(retryAfter));
    return res;
  }

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const id = randomId(MESSAGE_ID_LENGTH);
    const stub = env.MESSAGE_BOX.get(env.MESSAGE_BOX.idFromName(id));
    if (await stub.exists()) continue;
    const created = await stub.create(id, input);
    return json(created, 201);
  }
  return fail(503, 'id_collision', 'Could not allocate a message id. Try again.');
}

/** 服务端校验：只检查形状、长度与边界，看不懂也解不开内容 */
function validateCreate(
  raw: unknown,
  maxBytes: number,
  maxAttachmentBytes: number,
  withImages: boolean,
): CreateMessageRequest {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new HttpError(400, 'bad_request', 'Malformed request body');
  }
  const b = raw as Record<string, unknown>;

  /* 文本密文 */
  if (typeof b.ciphertext !== 'string' || b.ciphertext.length === 0) {
    throw new HttpError(400, 'bad_request', 'Missing ciphertext');
  }
  const ciphertext = b.ciphertext;
  let ciphertextBytes: number;
  try {
    ciphertextBytes = b64uToBytes(ciphertext).byteLength;
  } catch {
    throw new HttpError(400, 'bad_request', 'Invalid ciphertext encoding');
  }
  // AES-GCM 至少要有 16 字节 tag
  if (ciphertextBytes < 17) throw new HttpError(400, 'bad_request', 'Ciphertext too short');
  if (ciphertextBytes > maxBytes) throw new HttpError(413, 'too_large', 'Message over the size limit');

  /* 文本 IV */
  if (!isValidB64u(b.iv, IV_BYTES)) {
    throw new HttpError(400, 'bad_request', 'Invalid IV length');
  }
  const iv = b.iv;

  /* 密码相关：salt 与 verifier 必须成对出现 */
  const hasSalt = b.salt !== null && b.salt !== undefined;
  const hasVerifier = b.verifier !== null && b.verifier !== undefined;
  if (hasSalt !== hasVerifier) {
    throw new HttpError(400, 'bad_request', 'salt and verifier must be provided together');
  }

  let salt: string | null = null;
  let verifier: string | null = null;
  let kdfIterations: number | null = null;

  if (hasSalt) {
    if (!isValidB64u(b.salt, PBKDF2_SALT_BYTES)) {
      throw new HttpError(400, 'bad_request', 'Invalid salt length');
    }
    if (!isValidB64u(b.verifier, KEY_BYTES)) {
      throw new HttpError(400, 'bad_request', 'Invalid verifier length');
    }
    const iterations = Number(b.kdfIterations);
    if (!Number.isInteger(iterations) || iterations < 10_000 || iterations > 1_000_000) {
      throw new HttpError(400, 'bad_request', 'Invalid PBKDF2 iteration count');
    }
    salt = b.salt as string;
    verifier = b.verifier as string;
    kdfIterations = iterations;
  }

  /* 生命周期 */
  const rawViews = b.maxViews === undefined ? 1 : Number(b.maxViews);
  if (!Number.isInteger(rawViews) || rawViews < MIN_VIEWS || rawViews > MAX_VIEWS) {
    throw new HttpError(400, 'bad_request', `maxViews must be between ${MIN_VIEWS} and ${MAX_VIEWS}`);
  }
  const rawTtl = b.expiresInSeconds === undefined ? DEFAULT_TTL_SECONDS : Number(b.expiresInSeconds);
  if (!Number.isFinite(rawTtl) || rawTtl < MIN_TTL_SECONDS || rawTtl > MAX_TTL_SECONDS) {
    throw new HttpError(400, 'bad_request', 'Expiry out of the allowed range');
  }

  return {
    ciphertext,
    iv,
    salt,
    verifier,
    kdfIterations,
    expiresInSeconds: Math.floor(rawTtl),
    maxViews: rawViews,
    attachments: validateAttachments(b.attachments, maxAttachmentBytes, withImages),
  };
}

/**
 * 附件清单校验。
 *
 * 这里只检查「形状」：数量、ID 形状、申报体积。**服务端完全看不到图片内容**，
 * 它连密文都不在这条请求里 —— 图片密文随后由 PUT /att/:aid 单独送进 R2。
 * 申报的 size 用于给上传预留上限，防止有人借上传令牌往桶里灌任意大的对象。
 */
function validateAttachments(
  raw: unknown,
  maxAttachmentBytes: number,
  withImages: boolean,
): AttachmentSpec[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw new HttpError(400, 'bad_request', 'Malformed attachment list');
  if (raw.length === 0) return [];
  // 未启用图片功能时不该有附件；直接调 API 的客户端需要明确报错，而不是收到一条没图的「成功」
  if (!withImages) throw new HttpError(400, 'images_disabled', 'This deployment does not have images enabled');
  if (raw.length > MAX_ATTACHMENTS) {
    throw new HttpError(400, 'bad_request', `At most ${MAX_ATTACHMENTS} attachments`);
  }

  const out: AttachmentSpec[] = [];
  const seen = new Set<string>();
  let total = 0;

  for (const item of raw) {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) {
      throw new HttpError(400, 'bad_request', 'Malformed attachment entry');
    }
    const a = item as Record<string, unknown>;
    if (typeof a.id !== 'string' || !AID_RE.test(a.id)) {
      throw new HttpError(400, 'bad_request', 'Invalid attachment id');
    }
    if (seen.has(a.id)) throw new HttpError(400, 'bad_request', 'Duplicate attachment id');
    seen.add(a.id);

    const size = Number(a.size);
    if (!Number.isInteger(size) || size <= 0) {
      throw new HttpError(400, 'bad_request', 'Invalid attachment size');
    }
    if (size > maxAttachmentBytes) throw new HttpError(413, 'too_large', 'Attachment over the size limit');
    total += size;
    if (total > MAX_TOTAL_ATTACHMENT_BYTES) {
      throw new HttpError(413, 'too_large', 'Attachments exceed the total size limit');
    }

    out.push({ id: a.id, size });
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* 附件：上传与下载                                                    */
/* ------------------------------------------------------------------ */

type MessageBoxStub = ReturnType<Env['MESSAGE_BOX']['get']>;

/** PUT /api/messages/:id/att/:aid —— 图片密文写入 R2 */
async function uploadAttachment(
  req: Request,
  env: Env,
  stub: MessageBoxStub,
  id: string,
  aid: string,
): Promise<Response> {
  // 路由层已经拦下了未启用图片功能的请求，这里再判一次让函数自身不依赖调用方
  const blobs = env.BLOBS;
  if (!blobs) return fail(404, 'not_found', 'No such endpoint');

  const token = bearer(req);
  if (!token) return fail(401, 'unauthorized', 'Missing upload token');

  const maxAttachmentBytes = Number(env.MAX_ATTACHMENT_BYTES) || MAX_ATTACHMENT_BYTES;
  const declared = Number(req.headers.get('content-length') ?? '0');
  if (!Number.isFinite(declared) || declared <= 0) {
    return fail(411, 'length_required', 'Content-Length required');
  }
  // 密文比明文多 16 字节 GCM tag，再留一点余量
  if (declared > maxAttachmentBytes + 64) {
    return fail(413, 'too_large', 'Attachment over the size limit');
  }

  // 先过 DO 的令牌与槽位校验，再落对象 —— 否则任何人都能往桶里写任意键
  const auth = await stub.authorizeUpload(token, aid, declared);
  if (!auth.ok) return uploadFailure(auth.reason);

  const body = req.body;
  if (body === null) return fail(400, 'bad_request', 'Empty request body');

  const object = await blobs.put(r2Key(id, aid), body, {
    httpMetadata: { contentType: 'application/octet-stream' },
  });
  if (!object) return fail(500, 'internal', 'Failed to write attachment');

  await stub.markUploaded(aid, object.size);
  return json({ ok: true, size: object.size });
}

/**
 * GET /api/messages/:id/att/:aid —— 图片密文从 R2 流式读出。
 *
 * 走 Worker 而不是直链：桶一旦公开或改用 presigned URL，密文就能被无限次重复下载，
 * 「阅后即焚」就失效了。这里每次都要过 DO 的一次性令牌（过期即拒），
 * 字节流由 Worker 直接从 R2 转给浏览器，不经过 DO，避免大对象二次拷贝。
 */
async function downloadAttachment(
  req: Request,
  env: Env,
  stub: MessageBoxStub,
  id: string,
  aid: string,
): Promise<Response> {
  const blobs = env.BLOBS;
  if (!blobs) return fail(404, 'not_found', 'No such endpoint');

  const token = bearer(req);
  if (!token) return fail(401, 'unauthorized', 'Missing read token');

  if (!(await stub.authorizeAttachment(token, aid))) {
    return fail(403, 'forbidden', 'Token invalid or expired');
  }

  const object = await blobs.get(r2Key(id, aid));
  if (!object) return fail(404, 'not_found', 'No such attachment');

  const headers = new Headers({
    'Content-Type': 'application/octet-stream',
    'Content-Length': String(object.size),
    ETag: object.httpEtag,
  });
  return secure(new Response(object.body, { status: 200, headers }));
}

/** 允许空 body 的 JSON 读取（consume 可以不带 body） */
async function readOptionalJson<T>(req: Request, maxBytes: number): Promise<Partial<T>> {
  const text = await req.text();
  if (text.trim().length === 0) return {};
  const bytes = new TextEncoder().encode(text).byteLength;
  if (bytes > maxBytes) throw new HttpError(413, 'too_large', 'Request body too large');
  try {
    const parsed = JSON.parse(text) as unknown;
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};
    return parsed as Partial<T>;
  } catch {
    throw new HttpError(400, 'bad_json', 'Request body is not valid JSON');
  }
}
