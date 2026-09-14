import { DurableObject } from 'cloudflare:workers';

import type { Env } from './env';

interface Window {
  count: number;
  resetAt: number;
}

/**
 * 固定窗口限流器：按 IP 分片（`idFromName(ip)`）。
 * 只保护「创建」这一个写入动作，避免存储被刷爆。
 */
export class RateLimiter extends DurableObject<Env> {
  async hit(limit: number, windowMs: number): Promise<{ ok: boolean; remaining: number; resetAt: number }> {
    const now = Date.now();
    let win = await this.ctx.storage.get<Window>('window');

    if (!win || win.resetAt <= now) {
      win = { count: 0, resetAt: now + windowMs };
    }
    win.count += 1;
    await this.ctx.storage.put('window', win);

    // 窗口结束时清掉存储；已有 alarm 则不重复设置
    const existing = await this.ctx.storage.getAlarm();
    if (existing === null) await this.ctx.storage.setAlarm(win.resetAt);

    return {
      ok: win.count <= limit,
      remaining: Math.max(0, limit - win.count),
      resetAt: win.resetAt,
    };
  }

  override async alarm(): Promise<void> {
    await this.ctx.storage.deleteAll();
  }
}
