import { DurableObject } from 'cloudflare:workers';

import {
  MAX_FAILED_UNLOCK,
  MAX_VIEWS,
  MIN_VIEWS,
  PENDING_TTL_MS,
  PURGE_RETRY_MS,
  READ_TOKEN_TTL_MS,
  STORAGE_GUARD_NAME,
  TOKEN_CHARS,
} from './config';
import type { Env } from './env';
import { randomId, timingSafeEqual } from './http';
import type {
  AttachmentSpec,
  ConsumeResponse,
  CreateMessageRequest,
  CreateMessageResponse,
  MessageMeta,
  MessageStatus,
} from './types';
import { PAYLOAD_VERSION_R2, R2_KEY_PREFIX } from './types';

/** SQLite 行（snake_case 列名） */
interface Row {
  id: string;
  version: number;
  status: string;
  iv: string;
  salt: string | null;
  kdf_iterations: number | null;
  verifier: string | null;
  created_at: number;
  expires_at: number;
  max_views: number;
  views: number;
  failed_attempts: number;
  upload_token: string | null;
  read_token: string | null;
  read_token_expires: number | null;
  purge_pending: number;
  /** 本消息在全局容量计数器里占的字节数（= 创建时申报的附件体积合计） */
  reserved_bytes: number;
  /** 幂等闩：1 = 这份预留已经释放过（或正在释放），绝不再释放第二次 */
  reservation_released: number;
}

/** consume 失败原因，映射到 HTTP 状态码由 Worker 层决定 */
export type ConsumeFailure =
  | 'not_found'
  | 'gone'
  | 'not_ready'
  | 'password_required'
  | 'bad_password'
  | 'locked';

export type ConsumeResult =
  | { ok: true; data: ConsumeResponse }
  /* 密码错误但还有机会：带上剩余次数，供界面提示「还有 n 次将锁定」 */
  | { ok: false; reason: 'bad_password'; attemptsRemaining: number }
  | { ok: false; reason: Exclude<ConsumeFailure, 'bad_password'> };

/** 上传阶段的失败原因 */
export type UploadFailure = 'gone' | 'bad_token' | 'bad_aid' | 'too_large';
export type UploadResult = { ok: true } | { ok: false; reason: UploadFailure };

export type FinalizeResult =
  | { ok: true; status: MessageStatus }
  | { ok: false; reason: 'gone' | 'bad_token' | 'incomplete' };

/**
 * 每条 chunk 行承载的密文长度（base64url 字符数）。
 *
 * Durable Object 的 SQLite 有**单行/单值上限**（实测 4 MiB 报 SQLITE_TOOBIG），
 * 所以大密文不可能塞进一个 TEXT 列 —— 必须切片分行存。
 * 图片密文改造后已外置到 R2，这里只承载文本 payload（实际只有几 KB），
 * 分片能力保留是为了不把上限重新钉死在单行上。
 */
const CHUNK_CHARS = 1024 * 1024;

/** 毫秒级窗口：配置值合法且为正就用它，否则用缺省常量 */
function positiveOr(configured: string | undefined, fallback: number): number {
  const raw = Number(configured);
  return Number.isFinite(raw) && raw > 0 ? raw : fallback;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS message (
  id                 TEXT PRIMARY KEY,
  version            INTEGER NOT NULL,
  status             TEXT NOT NULL DEFAULT 'pending',
  iv                 TEXT NOT NULL,
  salt               TEXT,
  kdf_iterations     INTEGER,
  verifier           TEXT,
  created_at         INTEGER NOT NULL,
  expires_at         INTEGER NOT NULL,
  max_views          INTEGER NOT NULL,
  views              INTEGER NOT NULL DEFAULT 0,
  failed_attempts    INTEGER NOT NULL DEFAULT 0,
  upload_token       TEXT,
  read_token         TEXT,
  read_token_expires INTEGER,
  purge_pending      INTEGER NOT NULL DEFAULT 0,
  reserved_bytes     INTEGER NOT NULL DEFAULT 0,
  reservation_released INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS chunk (
  idx                INTEGER PRIMARY KEY,
  data               TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS attachment (
  aid                TEXT PRIMARY KEY,
  expected_bytes     INTEGER NOT NULL,
  bytes              INTEGER NOT NULL DEFAULT 0,
  uploaded           INTEGER NOT NULL DEFAULT 0
);
`;

/**
 * 一条消息 = 一个 Durable Object 实例。
 *
 * 职责边界（严格对齐 spec §23）：只保存文本密文、维护过期与查看次数、原子消费、删除。
 * 不解密、不验证明文密码、不解析内容 —— 服务器拿到的 verifier 也推不出任何密钥。
 *
 * 存储划分：
 *   message 表       元数据 + 状态机 + 令牌
 *   chunk 表         文本密文（R2 改造后已很轻）
 *   attachment 表    附件清单槽位与上传进度；**图片密文在 R2，不在这里**
 *
 * 生命周期：
 *   pending   （有附件时）等待全部附件上传 → finalize → active
 *   active    可消费
 *   destroyed tombstone；purge_pending=1 时 Alarm 会持续重试清理 R2 对象
 *
 * 并发：Durable Object 单线程串行执行，且 `storage.sql.exec` 是同步的，
 * 因此 consume 的 "读 → 判断 → 写" 之间不会被打断，天然满足原子性要求。
 * 所有 `await` 都安排在上述临界区**之后**，临界区的判定结果已经落库。
 */
export class MessageBox extends DurableObject<Env> {
  private readonly sql: SqlStorage;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;

    // 开发期 schema 迁移：改造前后 message 表都没有 status 列（旧版用 state，
    // 更早的版本把密文放在 message.ciphertext 单列里）。检测到旧结构直接重建 ——
    // 旧行读出来也是残缺的，没有需要保留的语义。
    if (this.isLegacySchema()) {
      this.sql.exec('DROP TABLE IF EXISTS message');
      this.sql.exec('DROP TABLE IF EXISTS chunk');
      this.sql.exec('DROP TABLE IF EXISTS attachment');
    }
    this.sql.exec(SCHEMA);
    this.ensureColumns();
  }

  /** message 表存在但没有 status 列 → 改造前的旧结构 */
  private isLegacySchema(): boolean {
    let exists = false;
    for (const r of this.sql.exec("SELECT name FROM pragma_table_info('message')")) {
      exists = true;
      if (String(r.name) === 'status') return false;
    }
    return exists;
  }

  /**
   * 给「结构兼容、只差新列」的已上线实例补列。
   *
   * `CREATE TABLE IF NOT EXISTS` 对已存在的表什么都不做，所以新增列不会自动出现在
   * 老实例上 —— 不补的话，INSERT 会直接报 no such column。
   * 这里补的两列都带默认值，因此老消息读出来是 `reserved_bytes = 0 /
   * reservation_released = 0`，含义正好是「这条消息没占过全局容量，不需要释放」。
   */
  private ensureColumns(): void {
    const have = new Set<string>();
    for (const r of this.sql.exec("SELECT name FROM pragma_table_info('message')")) {
      have.add(String(r.name));
    }
    if (have.size === 0) return; // 表刚由 SCHEMA 建好，列一定齐全
    if (!have.has('reserved_bytes')) {
      this.sql.exec('ALTER TABLE message ADD COLUMN reserved_bytes INTEGER NOT NULL DEFAULT 0');
    }
    if (!have.has('reservation_released')) {
      this.sql.exec('ALTER TABLE message ADD COLUMN reservation_released INTEGER NOT NULL DEFAULT 0');
    }
  }

  /* ------------------------------------------------------------------ */
  /* 读取原语                                                            */
  /* ------------------------------------------------------------------ */

  /** 取回完整文本密文（分片拼接，顺序由主键保证） */
  private readCiphertext(): string {
    const parts: string[] = [];
    for (const r of this.sql.exec('SELECT data FROM chunk ORDER BY idx')) {
      parts.push(String(r.data));
    }
    return parts.join('');
  }

  /** 取出唯一一行（tombstone 也算存在） */
  private row(): Row | null {
    for (const r of this.sql.exec('SELECT * FROM message LIMIT 1')) {
      return r as unknown as Row;
    }
    return null;
  }

  private attachmentCount(): number {
    const row = this.sql.exec('SELECT COUNT(*) AS n FROM attachment').one();
    return Number(row?.n ?? 0);
  }

  /* ------------------------------------------------------------------ */
  /* 时序参数                                                            */
  /* ------------------------------------------------------------------ */

  /**
   * 部署配置可覆盖的两个窗口。都只取「合法且为正的有限数」，其余（缺省、0、NaN、
   * 负数、非数字）一律回落到 config 里的常量 —— 这才是生产环境的默认行为，
   * 覆盖口子只用来让自动化测试把窗口压到几秒，把「超时 → 清理 → 释放」跑完整。
   */
  private pendingTtlMs(): number {
    return positiveOr(this.env.PENDING_TTL_MS, PENDING_TTL_MS);
  }

  private readTokenTtlMs(): number {
    return positiveOr(this.env.READ_TOKEN_TTL_MS, READ_TOKEN_TTL_MS);
  }

  /* ------------------------------------------------------------------ */
  /* 销毁与清理                                                          */
  /* ------------------------------------------------------------------ */

  /**
   * 抹掉文本密文并置为 tombstone。**同步**，因此可以安全地嵌在 consume 的临界区里。
   *
   * 不碰 attachment 表：R2 对象还在，宽限期内的下载仍需要 aid 清单来鉴权。
   * attachment 行由 purgeAsync 在对象清干净之后一并删除。
   *
   * @param grace 销毁后仍允许下载附件的窗口（阅后即焚时用）。不传则立即失去读取权。
   */
  private wipe(grace?: { token: string; expires: number }): void {
    this.sql.exec('DELETE FROM chunk');
    this.sql.exec(
      `UPDATE message
          SET status = 'destroyed',
              iv = '',
              salt = NULL,
              kdf_iterations = NULL,
              verifier = NULL,
              upload_token = NULL,
              purge_pending = 1
        WHERE status <> 'destroyed'`,
    );
    this.sql.exec(
      'UPDATE message SET read_token = ?, read_token_expires = ?',
      grace?.token ?? null,
      grace?.expires ?? null,
    );
  }

  /**
   * 删除本消息在 R2 上的全部对象。
   * 键统一为 `msg/<id>/<aid>`，所以一次前缀 list + 批量 delete 就能清干净。
   */
  private async purgeBlobs(id: string): Promise<boolean> {
    // 未启用图片功能时桶不存在，直接算清理完成 —— 不短路的话 list() 会对着 undefined
    // 抛 TypeError，让 Alarm 一直重试
    const blobs = this.env.BLOBS;
    if (!blobs) return true;

    const prefix = `${R2_KEY_PREFIX}${id}/`;
    try {
      let cursor: string | undefined;
      do {
        const listed = await blobs.list({ prefix, cursor, limit: 1000 });
        if (listed.objects.length > 0) {
          await blobs.delete(listed.objects.map((o) => o.key));
        }
        cursor = listed.truncated ? listed.cursor : undefined;
      } while (cursor);
      return true;
    } catch (err) {
      console.warn('[1tmsg] r2 purge failed', err);
      return false;
    }
  }

  /**
   * 把本消息在全局容量计数器里占的额度还回去。
   *
   * ## 为什么每条消息最多只会释放一次
   *
   * `reservation_released` 就是那个幂等闩，且**先落闩、再做异步释放**：
   *
   *   - 闩是同步写下的（`sql.exec` + DO 单线程），因此两个并发的清理事件里
   *     只有一个能读到 `reservation_released = 0`，另一个必然读到 1 并直接返回；
   *   - 顺序不能反。若先发释放请求再落闩，一旦在两者之间崩溃（或被驱逐），
   *     重试时闩还是 0 → 又释放一次 → 计数器越飘越小，等于凭空放大可用容量。
   *     反过来（落了闩但释放请求没发出去）只会让计数偏大，方向是保守的：
   *     少收几条，而不是悄悄越过红线。
   *
   * 注意方法内**重新读了一次行**，而不是复用调用方的快照 —— 快照可能是
   * await 之前拿到的，用它判断闩会漏掉「另一个清理流程刚刚已经释放过」的情况。
   */
  private async releaseReservation(id: string): Promise<void> {
    const r = this.row();
    if (!r || r.id !== id || r.reserved_bytes <= 0 || r.reservation_released !== 0) return;

    // 1) 先落闩（同步、原子）
    this.sql.exec('UPDATE message SET reservation_released = 1 WHERE id = ?', id);

    // 2) 再释放。失败只记日志：额度会偏大（保守方向），且下一次部署/清理不会重放
    const namespace = this.env.STORAGE_GUARD;
    if (!namespace) {
      console.warn('[1tmsg] storage guard 未绑定，跳过预留释放');
      return;
    }
    try {
      const guard = namespace.get(namespace.idFromName(STORAGE_GUARD_NAME));
      await guard.release(r.reserved_bytes);
    } catch (err) {
      console.warn(`[1tmsg] storage guard release(${r.reserved_bytes}) failed`, err);
    }
  }

  /**
   * 清 R2 → 释放全局预留 → 删 attachment 行 → 收掉 Alarm。失败则重新武装 Alarm 稍后重试；
   * 即使 DO 被驱逐、Alarm 丢失，桶的生命周期规则仍会把孤儿对象清掉。
   *
   * 释放的时机刻意定在**对象真的清干净之后**：只要 R2 上还留着本消息的密文，
   * 那些字节就仍在占用桶，额度就不该还回去。
   */
  private async purgeAsync(): Promise<void> {
    const r = this.row();
    if (!r || r.purge_pending !== 1) return;

    if (!(await this.purgeBlobs(r.id))) {
      await this.ctx.storage.setAlarm(Date.now() + PURGE_RETRY_MS);
      return;
    }
    await this.releaseReservation(r.id);
    this.sql.exec('DELETE FROM attachment');
    this.sql.exec(
      `UPDATE message
          SET purge_pending = 0, read_token = NULL, read_token_expires = NULL
        WHERE purge_pending = 1`,
    );
    await this.ctx.storage.deleteAlarm();
  }

  /* ------------------------------------------------------------------ */
  /* 元数据                                                              */
  /* ------------------------------------------------------------------ */

  private toMeta(r: Row, now: number): MessageMeta {
    const expired = r.expires_at <= now;
    const status: MessageStatus = r.status as MessageStatus;
    const hasPassword = r.salt !== null && r.verifier !== null;
    return {
      id: r.id,
      status,
      expired,
      hasPassword,
      createdAt: r.created_at,
      expiresAt: r.expires_at,
      maxViews: r.max_views,
      views: r.views,
      remaining: status === 'active' ? Math.max(0, r.max_views - r.views) : 0,
      attachmentCount: this.attachmentCount(),
      // salt 是 KDF 的公开参数，客户端必须在解密前拿到它才能算 K_password
      salt: hasPassword ? r.salt : null,
      kdfIterations: hasPassword ? r.kdf_iterations : null,
    };
  }

  /** 是否已存在（用于防止 ID 碰撞覆盖已有消息） */
  exists(): boolean {
    return this.row() !== null;
  }

  /** 只读元数据 —— 不消耗查看次数、不返回密文 */
  meta(): MessageMeta | null {
    const now = Date.now();
    const r = this.row();
    if (!r) return null;
    if (r.status === 'active' && r.expires_at <= now) {
      this.wipe();
      void this.ctx.waitUntil(this.purgeAsync());
      return this.toMeta({ ...r, status: 'destroyed' }, now);
    }
    return this.toMeta(r, now);
  }

  /* ------------------------------------------------------------------ */
  /* 写入                                                                */
  /* ------------------------------------------------------------------ */

  /**
   * 写入一条新消息。
   * 无附件 → 直接 active；有附件 → pending，返回上传令牌，等 finalize 才可消费。
   *
   * @param reservedBytes 本次已在全局容量计数器里预留的字节数（= 申报附件体积合计）。
   *   落库保存，销毁时据此释放；纯文字消息为 0，不参与容量保险。
   */
  async create(
    id: string,
    input: CreateMessageRequest,
    reservedBytes = 0,
  ): Promise<CreateMessageResponse> {
    const now = Date.now();
    const expiresAt = now + input.expiresInSeconds * 1000;
    const maxViews = Math.min(MAX_VIEWS, Math.max(MIN_VIEWS, Math.trunc(input.maxViews)));

    const specs: AttachmentSpec[] = input.attachments;
    const hasAttachments = specs.length > 0;
    const uploadToken = hasAttachments ? randomId(TOKEN_CHARS) : null;
    const status: MessageStatus = hasAttachments ? 'pending' : 'active';
    const reserved = Number.isSafeInteger(reservedBytes) && reservedBytes > 0 ? reservedBytes : 0;

    // 分片写入必须整体成功或整体失败，否则会留下半条读不出来的密文
    this.ctx.storage.transactionSync(() => {
      this.sql.exec('DELETE FROM chunk');
      this.sql.exec('DELETE FROM attachment');
      const ciphertext = input.ciphertext;
      for (let i = 0, idx = 0; i < ciphertext.length; i += CHUNK_CHARS, idx += 1) {
        this.sql.exec(
          'INSERT INTO chunk (idx, data) VALUES (?, ?)',
          idx,
          ciphertext.slice(i, i + CHUNK_CHARS),
        );
      }
      this.sql.exec(
        `INSERT INTO message
           (id, version, status, iv, salt, kdf_iterations, verifier,
            created_at, expires_at, max_views, views, failed_attempts,
            upload_token, read_token, read_token_expires, purge_pending,
            reserved_bytes, reservation_released)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?, NULL, NULL, 0, ?, 0)`,
        id,
        PAYLOAD_VERSION_R2,
        status,
        input.iv,
        input.salt,
        input.kdfIterations,
        input.verifier,
        now,
        expiresAt,
        maxViews,
        uploadToken,
        reserved,
      );
      for (const spec of specs) {
        this.sql.exec(
          'INSERT INTO attachment (aid, expected_bytes, bytes, uploaded) VALUES (?, ?, 0, 0)',
          spec.id,
          spec.size,
        );
      }
    });

    // pending 时 Alarm 定在「消息到期」与「上传窗口结束」中较早的那个
    const alarmAt = hasAttachments ? Math.min(expiresAt, now + this.pendingTtlMs()) : expiresAt;
    await this.ctx.storage.setAlarm(Math.max(alarmAt, now + 1000));
    return { id, expiresAt, maxViews, uploadToken };
  }

  /**
   * 校验上传令牌与附件 ID。通过后才允许往 R2 写对象 ——
   * 否则任何人都能往桶里塞任意键。
   */
  authorizeUpload(token: string, aid: string, bytes: number): UploadResult {
    const r = this.row();
    if (!r || r.status !== 'pending') return { ok: false, reason: 'gone' };
    if (!r.upload_token || !timingSafeEqual(token, r.upload_token)) {
      return { ok: false, reason: 'bad_token' };
    }
    let expected: number | null = null;
    for (const row of this.sql.exec('SELECT expected_bytes FROM attachment WHERE aid = ?', aid)) {
      expected = Number(row.expected_bytes);
    }
    if (expected === null) return { ok: false, reason: 'bad_aid' };
    // 密文 = 明文 + 16 字节 GCM tag，留一点余量给估算误差
    if (bytes <= 0 || bytes > expected + 64) return { ok: false, reason: 'too_large' };
    return { ok: true };
  }

  /**
   * 对象已成功写入 R2，登记实际字节数。
   * 这里不改 status —— 是否齐活由 finalize 判定，避免上传过程中被消费到半条消息。
   */
  markUploaded(aid: string, bytes: number): void {
    this.sql.exec('UPDATE attachment SET uploaded = 1, bytes = ? WHERE aid = ?', bytes, aid);
  }

  /** 全部附件就位后把 pending 推进到 active。幂等：已是 active 的消息直接返回成功。 */
  async finalize(token: string): Promise<FinalizeResult> {
    const r = this.row();
    if (!r || r.status === 'destroyed') return { ok: false, reason: 'gone' };
    if (r.status === 'active') return { ok: true, status: 'active' };
    if (!r.upload_token || !timingSafeEqual(token, r.upload_token)) {
      return { ok: false, reason: 'bad_token' };
    }

    const pending = this.sql.exec('SELECT COUNT(*) AS n FROM attachment WHERE uploaded = 0').one();
    if (Number(pending?.n ?? 0) > 0) return { ok: false, reason: 'incomplete' };

    this.sql.exec("UPDATE message SET status = 'active', upload_token = NULL WHERE status = 'pending'");
    // 上传窗口的 Alarm 换成消息到期时间
    await this.ctx.storage.setAlarm(Math.max(r.expires_at, Date.now() + 1000));
    return { ok: true, status: 'active' };
  }

  /* ------------------------------------------------------------------ */
  /* 消费与附件读取                                                      */
  /* ------------------------------------------------------------------ */

  /**
   * 原子消费：检查 → 验密码 → 计数 → （可选）销毁 → 返回文本密文与读取令牌。
   * 密码消息必须先在服务端过 verifier，错误不消耗查看次数（spec §12 / mockup 文案）。
   * 连续错误达 MAX_FAILED_UNLOCK 次即锁定（成功验密会清零连续计数）。
   *
   * 唯一的 await 在全部写入之后：临界区的判定与落库是同步完成的，
   * 期间不会被其它事件打断；await 之后消息已进入终态，再被观察到也是正确结果。
   */
  async consume(verifier?: string): Promise<ConsumeResult> {
    const now = Date.now();
    const r = this.row();
    if (!r) return { ok: false, reason: 'not_found' };

    if (r.status === 'destroyed') return { ok: false, reason: 'gone' };
    // 附件还没传完，谁也不能看 —— 否则会拿到图片缺失的半条消息
    if (r.status === 'pending') return { ok: false, reason: 'not_ready' };

    if (r.expires_at <= now) {
      this.wipe();
      void this.ctx.waitUntil(this.purgeAsync());
      return { ok: false, reason: 'gone' };
    }

    // 1) 先验密码：失败绝不消耗查看次数
    if (r.verifier !== null) {
      if (typeof verifier !== 'string' || verifier.length === 0) {
        return { ok: false, reason: 'password_required' };
      }
      if (r.failed_attempts >= MAX_FAILED_UNLOCK) return { ok: false, reason: 'locked' };
      if (!timingSafeEqual(verifier, r.verifier)) {
        /*
         * 计的是**连续**失败：上面验密成功那支会清零，所以这里是「连着输错几次」。
         * 归零这一次不再返回 bad_password —— 消息此刻已经锁定，
         * 直接告诉客户端 locked，让用户马上看到锁定页而不是「还剩 0 次」。
         */
        const failed = r.failed_attempts + 1;
        this.sql.exec('UPDATE message SET failed_attempts = ? WHERE id = ?', failed, r.id);
        if (failed >= MAX_FAILED_UNLOCK) return { ok: false, reason: 'locked' };
        return { ok: false, reason: 'bad_password', attemptsRemaining: MAX_FAILED_UNLOCK - failed };
      }
      // 验密通过：连续失败计数清零，下次再错又是从满额度开始
      if (r.failed_attempts !== 0) {
        this.sql.exec('UPDATE message SET failed_attempts = 0 WHERE id = ?', r.id);
      }
    }

    // 2) 计数
    if (r.views >= r.max_views) {
      this.wipe();
      void this.ctx.waitUntil(this.purgeAsync());
      return { ok: false, reason: 'gone' };
    }

    const views = r.views + 1;
    const destroyed = views >= r.max_views;

    /*
     * 销毁时也要留一个下载窗口：文本密文可以立刻抹掉，但图片密文还在 R2 上，
     * 而 verifier 校验已经通过、查看次数也已经消耗 —— 这一次访问必须能拿到图片。
     * 所以销毁路径也发一个短命令牌，Alarm 定在令牌过期时刻再清对象。
     */
    const readToken = randomId(TOKEN_CHARS);
    const readTokenExpires = now + this.readTokenTtlMs();

    const payload: ConsumeResponse = {
      ciphertext: this.readCiphertext(),
      iv: r.iv,
      salt: r.salt,
      kdfIterations: r.kdf_iterations,
      remaining: Math.max(0, r.max_views - views),
      expiresAt: r.expires_at,
      destroyed,
      readToken,
    };

    /*
     * 先落计数再（可能）销毁。
     * wipe() 只抹密文、不动 views，所以如果跳过这一步，最后一次消费的计数
     * 会永远停在 maxViews - 1 —— 元数据里的「已查看 N 次」就与实际历史不符。
     */
    this.sql.exec('UPDATE message SET views = ? WHERE id = ?', views, r.id);
    if (destroyed) {
      this.wipe({ token: readToken, expires: readTokenExpires });
      await this.ctx.storage.setAlarm(readTokenExpires);
    } else {
      this.sql.exec(
        'UPDATE message SET read_token = ?, read_token_expires = ? WHERE id = ?',
        readToken,
        readTokenExpires,
        r.id,
      );
    }

    return { ok: true, data: payload };
  }

  /**
   * 附件密文的下载授权。
   * 令牌一次性换发（每次 consume 覆盖），过期即失效；消息彻底销毁后立刻失效。
   * 真正的字节搬运由 Worker 直接走 R2 流式转发，不经过 DO，避免大对象二次拷贝。
   */
  authorizeAttachment(token: string, aid: string): boolean {
    const r = this.row();
    if (!r) return false;
    /*
     * 判据是令牌本身是否有效，而**不是** status：
     * 阅后即焚的最后一次访问里，status 已经是 destroyed，但 R2 对象还在，
     * 客户端仍需在这个宽限期内把图片取走。宽限期结束由 Alarm 清对象并把令牌置空。
     */
    if (!r.read_token || !r.read_token_expires) return false;
    if (r.read_token_expires <= Date.now()) return false;
    if (!timingSafeEqual(token, r.read_token)) return false;
    for (const _row of this.sql.exec('SELECT aid FROM attachment WHERE aid = ?', aid)) {
      return true;
    }
    return false;
  }

  /** 主动销毁（spec §19，可选接口） */
  async destroy(): Promise<boolean> {
    const r = this.row();
    if (!r) return false;
    if (r.status === 'destroyed') return false;
    this.wipe();
    await this.purgeAsync();
    return true;
  }

  /* ------------------------------------------------------------------ */
  /* Alarm：上传超时 / 到期 / R2 清理重试                                 */
  /* ------------------------------------------------------------------ */

  override async alarm(): Promise<void> {
    const r = this.row();
    if (!r) return;
    const now = Date.now();

    // 1) 有未清的 R2 对象：若还在下载宽限期内就先不动，等窗口结束
    if (r.purge_pending === 1) {
      if (r.read_token_expires !== null && r.read_token_expires > now) {
        await this.ctx.storage.setAlarm(r.read_token_expires);
        return;
      }
      await this.purgeAsync();
      return;
    }

    // 2) pending 超时：附件没传完，直接作废并清掉已上传的对象
    if (r.status === 'pending') {
      this.wipe();
      await this.purgeAsync();
      return;
    }

    // 3) active 到期：抹掉密文（spec §15）
    if (r.status === 'active' && r.expires_at <= now) {
      this.wipe();
      await this.purgeAsync();
    }
  }
}
