/**
 * StorageGuard · 全局 R2 容量保险
 *
 * 1tmsg 是公开服务：任何人都能创建消息、上传图片。消息本身有 TTL，但**总量**没有上限 ——
 * 只要 IP 够多、时间够长，桶就能一直涨。这个 Durable Object 就是那条总量红线。
 *
 * 它**只记一个数字**：当前已被消息预留的字节数。图片本身仍然只存在 R2 里，
 * 这里既不存密文也不存任何消息内容 —— 它连消息 ID 都不知道。
 *
 * ## 为什么是「预留」而不是「上传完再统计」
 *
 * 统计式（先放行 → 上传完回调 → 累加）在并发下必然超额：
 *
 *     当前 4.96 GB（上限 5 GB）
 *     A 判定 < 5GB → 放行     B 判定 < 5GB → 放行     C 判定 < 5GB → 放行
 *     三条 50MB 的消息一起落桶 → 5.11 GB，红线的意义归零
 *
 * 所以判定必须与自增**不可分割**地发生在放行之前：reserve() 先原子占位，
 * 占到了才允许创建消息与上传。这是本文件存在的全部理由。
 *
 * ## 并发安全从哪来
 *
 * 两重保证，缺一不可：
 *   1. Durable Object 单线程执行，所有事件串行；
 *   2. 判定与自增写在**同一条 UPDATE** 里（`WHERE ... AND reserved_bytes + ? <= ?`），
 *      由 SQLite 保证「要么整行生效、要么一行都不匹配」。
 *
 * 第 2 点是刻意的：只靠第 1 点也行，但同一条语句里的条件更新把原子性做成了
 * 存储层的事实，而不是「因为上面没有 await 所以应该没问题」这种推理。
 * 另外，成败判据取「写后回读」而不是驱动上报的改动行数 —— 判据要来自存储本身。
 *
 * ## 它不是实时用量
 *
 * 预留按**申报体积**算，而客户端可能少传、可能传一半就断了。所以
 *
 *     R2 实际占用 ≤ reservedBytes ≤ MAX_R2_STORAGE_BYTES
 *
 * 允许「预留了但还没用上」（这是保险，不是记账）；反过来绝不允许预留之和超过上限。
 *
 * ## 对外不可达
 *
 * 这个类没有走 Worker 的路由表 —— 外部请求打不到它，只有 src/index.ts 在创建消息时
 * 通过 Durable Object stub 调用。别给它加 HTTP 入口。
 */
import { DurableObject } from 'cloudflare:workers';

import {
  GB,
  INITIAL_RESERVED_BYTES,
  MAX_R2_STORAGE_BYTES,
} from './config';
import type { Env } from './env';

/** 当前容量状态。只读快照，供运维接口/日志使用 */
export interface StorageUsage {
  /** 已被消息预留的字节数 */
  reservedBytes: number;
  /** 上限（来自部署配置，缺省用 config 里的常量） */
  maxBytes: number;
  /** 还能再预留多少（不小于 0） */
  availableBytes: number;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS storage_usage (
  id             INTEGER PRIMARY KEY CHECK (id = 1),
  reserved_bytes INTEGER NOT NULL DEFAULT 0
);
`;

/**
 * 把外部传入的字节数收敛成「可安全参与运算的正整数」，不合格返回 null。
 *
 * 三条都必须挡住：
 *   - 非数字 / NaN / Infinity / 小数、负数、0  → 拒绝（0 字节的预留没有意义，
 *     放进来只会在释放时制造噪声）
 *   - 超出安全整数范围                        → 拒绝（超过 2^53 之后加减法会静默丢精度）
 *
 * 注意这里**不做**小数取整：调用方传来的应该是客户端申报的整数字节数，
 * 出现小数说明上游已经算错了，静默取整只会把错误藏起来。
 */
function safeBytes(input: unknown): number | null {
  const n = Number(input);
  if (!Number.isSafeInteger(n) || n <= 0) return null;
  return n;
}

/**
 * 把配置里的 **GB 数**换算成字节。
 *
 * 为什么配置以 GB 为单位：这是**给部署者填**的值。让人手算 5 × 1024³ = 5368709120
 * 既容易错，写进配置也看不出含义 —— 写 `"5"` 一眼就是 5 GB。允许小数
 * （`"0.5"` = 512 MB），小实例才可能把上限压到 1 GB 以下。
 *
 * 缺省 / 空 / 非法（非数字、负数、超出安全整数）→ 回落到 fallback。
 * **`0` 是合法值**（＝不再接受任何带图片的消息），不能像其它地方那样用
 * `Number(x) || DEFAULT` 把 0 当成「没填」吞掉 —— 那会得到与配置相反的宽松上限。
 */
function gbToBytes(configured: string | undefined, fallback: number): number {
  if (configured === undefined) return fallback;
  const text = configured.trim();
  if (text === '') return fallback;

  const gb = Number(text);
  if (!Number.isFinite(gb) || gb < 0) {
    console.warn(
      `[1tmsg] storage guard: ${text} 不是有效的 GB 数（需为 ≥ 0 的数字），按缺省 ${fallback / GB} GB 处理`,
    );
    return fallback;
  }
  const bytes = Math.floor(gb * GB);
  if (!Number.isSafeInteger(bytes)) {
    console.warn(`[1tmsg] storage guard: ${text} GB 换算后超出安全整数范围，按缺省处理`);
    return fallback;
  }
  return bytes;
}

export class StorageGuard extends DurableObject<Env> {
  private readonly sql: SqlStorage;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(SCHEMA);

    /*
     * 首次初始化时把「部署前桶里已经有的东西」一次性计入。
     *
     * INSERT **OR IGNORE** 是这里的关键：id 恒为 1，所以这条语句只在计数器
     * 还不存在时真正写入。之后哪怕把 vars.INITIAL_RESERVED_GB 改大改小、
     * 或者 DO 被驱逐后重新唤醒，都不会重复计入 —— 种子只播一次。
     */
    const seed = this.seedBytes();
    if (seed > 0) {
      this.sql.exec('INSERT OR IGNORE INTO storage_usage (id, reserved_bytes) VALUES (1, ?)', seed);
    } else {
      this.sql.exec('INSERT OR IGNORE INTO storage_usage (id, reserved_bytes) VALUES (1, 0)');
    }
  }

  /* ------------------------------------------------------------------ */
  /* 配置                                                                */
  /* ------------------------------------------------------------------ */

  /** 上限：部署配置（GB）优先，缺省用 config 常量 */
  private maxBytes(): number {
    return gbToBytes(this.env.MAX_R2_STORAGE_GB, MAX_R2_STORAGE_BYTES);
  }

  /** 一次性种子：部署配置（GB）优先，缺省为 0，且**不会超过上限** */
  private seedBytes(): number {
    const seed = gbToBytes(this.env.INITIAL_RESERVED_GB, INITIAL_RESERVED_BYTES);
    // 种子大于上限说明配置写错了。夹到上限：宁可一上来就拒绝新上传，
    // 也不要让「已占用 > 上限」这种自相矛盾的状态进入计数器。
    return Math.min(seed, this.maxBytes());
  }

  private readReserved(): number {
    for (const row of this.sql.exec('SELECT reserved_bytes FROM storage_usage WHERE id = 1')) {
      return Number(row.reserved_bytes);
    }
    return 0;
  }

  /* ------------------------------------------------------------------ */
  /* 对外接口（只允许 Worker 通过 stub 调用）                             */
  /* ------------------------------------------------------------------ */

  /**
   * 原子预留。成功返回 true，超出上限返回 false。
   *
   * 判定与自增在同一条 UPDATE 内完成，因此并发调用**不可能**一起成功 ——
   * 这正是「上传前预留」相对「上传后统计」的全部价值。
   *
   * 成败的判据是**写后回读**（`after === before + bytes`），而不是驱动上报的
   * 改动行数：判据必须来自存储本身。回读与写入同在一个同步事务里，中间没有任何
   * await，因此这个等式成立当且仅当那条条件更新真的生效了。
   */
  reserve(input: number): boolean {
    const bytes = safeBytes(input);
    if (bytes === null) {
      console.warn(`[1tmsg] storage guard: 拒绝非法预留 ${String(input)}`);
      return false;
    }
    const max = this.maxBytes();

    return this.ctx.storage.transactionSync(() => {
      const before = this.readReserved();
      if (before + bytes > max) {
        console.warn(`[1tmsg] storage guard: 预留 ${bytes}B 被拒（已预留 ${before}B / 上限 ${max}B）`);
        return false;
      }
      // 条件更新只作双保险：即使有其它写入路径绕过上面的判断，这里也不会越界
      this.sql.exec(
        `UPDATE storage_usage
            SET reserved_bytes = reserved_bytes + ?
          WHERE id = 1 AND reserved_bytes + ? <= ?`,
        bytes,
        bytes,
        max,
      );
      const after = this.readReserved();
      if (after !== before + bytes) {
        // 走不到这里：读到 after ≠ before + bytes 说明计数器被别的路径改过，
        // 那就不能声称预留成功（fail-closed：少收一条，胜过记账错乱）
        console.warn(
          `[1tmsg] storage guard: 预留 ${bytes}B 未生效（${before}B → ${after}B），按失败处理`,
        );
        return false;
      }
      return true;
    });
  }

  /**
   * 释放预留。**必须与每条消息的生命周期一一对应，且每条消息最多调用一次** ——
   * 调用方（MessageBox）靠 reservation_released 闩保证这一点，见那里的注释。
   *
   * 返回释放后的状态，方便调用方/测试断言。计数下限为 0：
   * 即便因为重复释放、配置变更等原因算多了，也绝不允许出现负数 ——
   * 负的 reservedBytes 等于凭空多出容量，会直接击穿这条红线。
   */
  release(input: number): StorageUsage {
    const bytes = safeBytes(input);
    if (bytes === null) {
      console.warn(`[1tmsg] storage guard: 拒绝非法释放 ${String(input)}`);
      return this.usage();
    }

    return this.ctx.storage.transactionSync(() => {
      const before = this.readReserved();
      const after = Math.max(0, before - bytes);
      if (before < bytes) {
        // 出现这种日志说明计数已经偏小（多半是同一条消息被释放了两次），
        // 值得追查：它会静默放大可用容量。
        console.warn(
          `[1tmsg] storage guard: 释放 ${bytes}B 超过已预留 ${before}B，已夹到 0 —— 疑似重复释放`,
        );
      }
      if (after !== before) {
        this.sql.exec('UPDATE storage_usage SET reserved_bytes = ? WHERE id = 1', after);
      }
      return this.usage();
    });
  }

  /** 当前状态快照（只读） */
  usage(): StorageUsage {
    const max = this.maxBytes();
    const reservedBytes = Math.max(0, this.readReserved());
    return { reservedBytes, maxBytes: max, availableBytes: Math.max(0, max - reservedBytes) };
  }
}
