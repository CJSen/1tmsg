/**
 * 查看页逻辑（spec §11 / §12 / §13 / §16 / §24）
 *
 * 顺序严格按 spec：
 *   读 Fragment → 立即清 Fragment → 取元数据（不消费查看次数）
 *   → （可选）本地 PBKDF2 → 服务端先验密码 → 原子 consume
 *   → 本地 AES-GCM 解密正文 → 逐张取回图片密文并各自解密 → 渲染
 *
 * 图片有两条来源，靠 payload 的 version 区分：
 *   v1（改造前）图片字节内嵌在密文里，直接 base64 解码；
 *   v2 图片密文是 R2 上的独立对象，用一次性 readToken 取回，再用
 *      K_att = HKDF(K_msg, "1tmsg/v1/attachment/<aid>") 单独解密。
 * 两种都失败时只降级成「图片缺失」占位，正文照常显示。
 *
 * K_link 只保存在这个闭包里，不进 localStorage / sessionStorage，也不出现在任何 URL 里。
 */
import { PBKDF2_ITERATIONS } from '../config';
import { initLocale, LocaleError, onLocaleChange, t, type MsgKey, type TParams } from '../i18n';
import type { Attachment, MessagePayload } from '../types';
import { ApiError, api } from './api';
import type { Bytes } from './bytes';
import { tryUnb64u } from './bytes';
import {
  computeVerifier,
  decryptBytes,
  decryptPayload,
  deriveAttachmentKey,
  deriveMessageKeyBits,
  derivePasswordKey,
  importAesKey,
  parseFragment,
  parsePayload,
} from './crypto';
import { attachmentUrls, hydrateMarkdown, renderMarkdown, revokeAll } from './markdown';
import { bindPasswordToggle, copyText, countdown, el, maybe, setBusy, show, toast } from './ui';

const stateLoading = el('stateLoading');
const stateFatal = el('stateFatal');
const stateUnlock = el('stateUnlock');
const stateRead = el('stateRead');
const unlockError = maybe('unlockError');

/** 会话内的密钥与消息 ID，只活在当前页面内存里 */
let kLink: Bytes | null = null;
let messageId = '';
let objectUrls = new Map<string, string>();
let ticker: number | undefined;

/** 供「复制」按钮使用的明文（备注 + 正文），只在内存里 */
let copySource = '';
let copyBound = false;

const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

/** 本地已解密并落地成 blob URL 的图片 */
interface DecodedImage {
  id: string;
  type: string;
  bytes: Bytes;
}

/**
 * 切换主视图。
 *
 * 三个 paint* 都带「对应视图可见才写」的守卫，所以**必须在切完视图之后再重绘**：
 * 顺序写反时它们是静默失败的 —— 曾经因此出现「无密钥链接一直停在加载态」
 * 与「剩余次数不显示」。这里把「切视图 → 重绘」绑成一步，调用方不必关心先后。
 * （语言切换走 onLocaleChange 直接调 paint*，那时视图已可见，守卫正好放行。）
 */
function only(target: HTMLElement): void {
  for (const node of [stateLoading, stateFatal, stateUnlock, stateRead]) show(node, node === target);
  if (target === stateLoading) paintLoading();
  else if (target === stateFatal) paintFatal();
  else if (target === stateRead) renderBadge();
}

/* ------------------------------------------------------------------ */
/* 文案                                                                */
/* ------------------------------------------------------------------ */

/**
 * 动态文案的写入规则（与 i18n 的 applyToDom 配合）：
 *   - 无参数的文案把键写进 data-i18n，切换语言时 applyToDom 会自动跟随；
 *   - 带参数的文案（取回进度、剩余次数）applyToDom 还原不了参数，摘掉标记，
 *     由下面的重绘回调按保存的状态重算。
 */
function setMsg(node: HTMLElement, key: MsgKey, params?: TParams): void {
  if (params === undefined) node.dataset.i18n = key;
  else delete node.dataset.i18n;
  node.textContent = t(key, params);
}

let lastLoading: { title: MsgKey; body: MsgKey; bodyParams?: TParams } | null = null;

/** 加载态文案会随进度变化（取回图片时逐张更新） */
function loading(title: MsgKey, body: MsgKey, bodyParams?: TParams): void {
  lastLoading = { title, body, bodyParams };
  paintLoading();
}

function paintLoading(): void {
  if (!lastLoading || stateLoading.hidden) return;
  setMsg(el('loadingTitle'), lastLoading.title);
  setMsg(el('loadingBody'), lastLoading.body, lastLoading.bodyParams);
}

let lastFatal: { title: MsgKey; bodyKey?: MsgKey; bodyText?: string } | null = null;

/** 失败页：标题与正文都是字典键（切视图 + 绘制由 only 一并完成） */
function fatalKey(title: MsgKey, body: MsgKey): void {
  lastFatal = { title, bodyKey: body };
  only(stateFatal);
}

/** 失败页：正文是现成文案（比如 api.ts 已经本地化的服务端 message），不进 data-i18n */
function fatalText(title: MsgKey, body: string): void {
  lastFatal = { title, bodyText: body };
  only(stateFatal);
}

function paintFatal(): void {
  if (!lastFatal || stateFatal.hidden) return;
  setMsg(el('fatalTitle'), lastFatal.title);
  const body = el('fatalBody');
  if (lastFatal.bodyKey !== undefined) setMsg(body, lastFatal.bodyKey);
  else {
    delete body.dataset.i18n;
    body.textContent = lastFatal.bodyText ?? '';
  }
}

/** 正文页的徽标（销毁态 / 剩余次数）—— 带参数，语言切换时重算 */
let readState: { destroyed: boolean; remaining: number } | null = null;

function renderBadge(): void {
  if (!readState || stateRead.hidden) return;
  setMsg(
    el('readBadgeText'),
    readState.destroyed ? 'view.badgeDestroyed' : 'view.badgeRemaining',
    readState.destroyed ? undefined : { n: readState.remaining },
  );
}

function unlockFail(message: string): void {
  if (unlockError) {
    unlockError.textContent = message;
    show(unlockError, true);
  }
}

/* ------------------------------------------------------------------ */
/* 启动                                                                */
/* ------------------------------------------------------------------ */

async function boot(): Promise<void> {
  only(stateLoading);

  messageId = location.pathname.split('/').filter(Boolean)[1] ?? '';
  if (!ID_RE.test(messageId)) {
    fatalKey('view.errBadLinkTitle', 'view.errBadLinkBody');
    return;
  }

  /* 1) 先取走 Fragment，再从地址栏抹掉（spec §8） */
  kLink = parseFragment(location.hash);
  history.replaceState(null, '', location.pathname + location.search);

  if (!kLink) {
    fatalKey('view.errBadLinkTitle', 'view.errNoKeyBody');
    return;
  }

  /* 2) 元数据：不消耗查看次数，也不返回密文；带密码时附带 KDF 公开参数 */
  let password: { salt: Bytes; iterations: number } | null = null;
  try {
    const meta = await api.getMeta(messageId);
    if (meta.status === 'pending') {
      fatalKey('view.errPendingTitle', 'view.errPendingBody');
      return;
    }
    if (meta.status !== 'active') {
      fatalKey(
        'view.errGoneTitle',
        meta.expired ? 'view.errGoneExpiredBody' : 'view.errGoneConsumedBody',
      );
      return;
    }
    if (meta.hasPassword) {
      const salt = meta.salt ? tryUnb64u(meta.salt) : null;
      if (!salt) {
        fatalKey('view.errSaltTitle', 'view.errSaltBody');
        return;
      }
      password = { salt, iterations: meta.kdfIterations ?? PBKDF2_ITERATIONS };
    }
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) fatalText('view.errNotFoundTitle', err.message);
    else fatalText('view.errUnavailableTitle', err instanceof Error ? err.message : t('view.errRetryLater'));
    return;
  }

  /* 3) 密码消息先解锁；否则直接消费 */
  if (!password) {
    await open(null);
    return;
  }

  const pitch = el<HTMLInputElement>('pwd2');
  bindPasswordToggle(maybe('eye2'), pitch);
  pitch.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') void submitPassword();
  });
  el('unlockBtn').addEventListener('click', () => void submitPassword());
  only(stateUnlock);
  pitch.focus();

  /* ------------------------------------------------------------------ */
  /* 解锁                                                                */
  /* ------------------------------------------------------------------ */

  async function submitPassword(): Promise<void> {
    const button = el<HTMLButtonElement>('unlockBtn');
    if (button.disabled) return;

    const value = pitch.value;
    if (value.length === 0) {
      unlockFail(t('view.errEmptyPassword'));
      pitch.focus();
      return;
    }
    if (unlockError) show(unlockError, false);

    setBusy(button, true, t('view.progressDecrypt'));
    try {
      await open(value);
    } catch (err) {
      // 失败一定要退出忙碌态：否则按钮会停在「正在本地解密…」，看着像卡死
      setBusy(button, false);
      unlockFail(err instanceof Error ? err.message : t('view.errOpenFailed'));
      pitch.select();
      pitch.focus();
      return;
    }
    setBusy(button, false);
  }

  /* ------------------------------------------------------------------ */
  /* 消费 + 解密 + 渲染                                                  */
  /* ------------------------------------------------------------------ */

  /**
   * @param rawPassword 密码消息传入明文密码；null 表示无密码消息。
   * 密码错误不会消耗查看次数：服务端在交付密文前先比对 verifier（spec §12）。
   */
  async function open(rawPassword: string | null): Promise<void> {
    if (!kLink) {
      fatalKey('view.errBadLinkTitle', 'view.errKeyLostBody');
      return;
    }

    let kPassword: Bytes | null = null;
    let verifier: string | undefined;
    if (rawPassword !== null && password) {
      kPassword = await derivePasswordKey(rawPassword, password.salt, password.iterations);
      verifier = await computeVerifier(kPassword);
    }

    let consumed;
    try {
      consumed = await api.consume(messageId, verifier);
    } catch (err) {
      if (err instanceof ApiError) {
        switch (err.code) {
          case 'bad_password':
            throw new LocaleError(t('err.bad_password'));
          case 'password_required':
            throw new LocaleError(t('err.password_required'));
          case 'locked':
            fatalKey('view.errLockedTitle', 'view.errLockedBody');
            return;
          case 'not_ready':
            fatalKey('view.errPendingTitle', 'view.errPendingRetryBody');
            return;
          case 'gone':
            fatalKey('view.errGoneTitle', 'view.errGoneBody');
            return;
          case 'not_found':
            fatalText('view.errNotFoundTitle', err.message);
            return;
          default:
            throw new LocaleError(err.message);
        }
      }
      throw err;
    }

    /* K_msg 是文本与图片两套密钥的共同来源 */
    const kMsg = await deriveMessageKeyBits(kLink, kPassword);
    const messageKey = await importAesKey(kMsg);

    let payload;
    try {
      payload = parsePayload(await decryptPayload(messageKey, consumed.ciphertext, consumed.iv));
    } catch {
      fatalKey('view.errDecryptTitle', 'view.errDecryptBody');
      return;
    }

    /* 正文已经解开了，图片还要逐张取回 —— 大图会明显耗时，把进度显示出来 */
    if (payload.attachments.length > 0) {
      const total = payload.attachments.length;
      loading('view.progressImagesTitle', 'view.progressImages', { done: 0, total, n: total });
    }
    const decoded = await collectImages(payload.attachments, kMsg, consumed.readToken);

    render(payload, decoded, consumed.expiresAt, consumed.destroyed, consumed.remaining);
  }
}

/* ------------------------------------------------------------------ */
/* 图片：取回 + 解密                                                   */
/* ------------------------------------------------------------------ */

/**
 * 逐张取回并解密。**任何一张失败都不影响其余**，也不影响正文 ——
 * 失败的会在渲染阶段变成「图片缺失」占位。
 */
async function collectImages(
  attachments: Attachment[],
  kMsg: Bytes,
  readToken: string | null,
): Promise<DecodedImage[]> {
  const total = attachments.length;
  let done = 0;

  const results = await Promise.all(
    attachments.map(async (att) => {
      const bytes = await decodeImage(att, kMsg, readToken);
      done += 1;
      loading('view.progressImagesTitle', 'view.progressImages', { done, total, n: total });
      return bytes === null ? null : { id: att.id, type: att.type, bytes };
    }),
  );

  const ok = results.filter((r): r is DecodedImage => r !== null);
  if (ok.length < total) toast(t('view.errImagesFailed', { n: total - ok.length }), 'error');
  return ok;
}

async function decodeImage(
  att: Attachment,
  kMsg: Bytes,
  readToken: string | null,
): Promise<Bytes | null> {
  // v1 历史消息：图片字节就在密文里，没什么可取的
  if (typeof att.data === 'string') return tryUnb64u(att.data);

  // 未启用图片功能时 R2 通路不存在，直接给「图片缺失」占位，省掉注定 404 的请求
  if (!__ENABLE_IMAGES__) return null;

  // v2：密文在 R2，密钥由 K_msg 确定性派生
  if (typeof att.iv !== 'string' || readToken === null) return null;
  try {
    const cipher = await api.fetchAttachment(messageId, att.id, readToken);
    return await decryptBytes(await deriveAttachmentKey(kMsg, att.id), cipher, att.iv);
  } catch (err) {
    console.warn('[1tmsg] attachment failed', att.id, err);
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* 渲染                                                                */
/* ------------------------------------------------------------------ */

/**
 * 复制按钮：头部 chip 与尾部大按钮共用同一份明文。
 * 每个按钮自带计时器，避免「一个刚点完、再点另一个」导致前一个卡在「已复制」上。
 */
function bindCopy(button: HTMLButtonElement, idleKey: MsgKey): void {
  let timer: number | undefined;
  button.addEventListener('click', () => {
    void (async () => {
      if (copySource.length === 0) {
        toast(t('view.errNothingToCopy'), 'error');
        return;
      }
      if (!(await copyText(copySource))) {
        toast(t('view.errCopyFailed'), 'error');
        return;
      }
      toast(t('view.copiedAll'));
      const span = button.querySelector('span');
      if (!span) return;
      window.clearTimeout(timer);
      span.textContent = t('view.copied');
      button.classList.add('ok');
      timer = window.setTimeout(() => {
        span.textContent = t(idleKey);
        button.classList.remove('ok');
      }, 1600);
    })();
  });
}

function bindCopyButtons(payload: MessagePayload): void {
  copySource = [payload.note, payload.content]
    .filter((part) => part.trim().length > 0)
    .join('\n\n')
    .trim();
  if (copyBound) return;
  copyBound = true;
  bindCopy(el<HTMLButtonElement>('copyTop'), 'view.copy');
  bindCopy(el<HTMLButtonElement>('copyBottom'), 'view.copyAll');
}

function render(
  payload: MessagePayload,
  decoded: DecodedImage[],
  expiresAt: number,
  destroyed: boolean,
  remaining: number,
): void {
  revokeAll(objectUrls);
  objectUrls = attachmentUrls(decoded);

  const noteBox = el('noteBox');
  if (payload.note.length > 0) {
    el('noteText').textContent = payload.note;
    show(noteBox, true);
  } else {
    show(noteBox, false);
  }

  const body = el('readBody');
  body.innerHTML = renderMarkdown(payload.content);
  hydrateMarkdown(body, objectUrls);

  bindCopyButtons(payload);

  show(el('readDone'), destroyed);
  // readState 必须先落地：紧随其后的 only(stateRead) 会立刻用它重绘徽标
  readState = { destroyed, remaining };

  startCountdown(expiresAt);
  only(stateRead);
  window.scrollTo({ top: 0 });
}

function startCountdown(expiresAt: number): void {
  const node = el('readExpiry');
  const update = (): void => {
    const left = expiresAt - Date.now();
    node.textContent = left > 0 ? t('view.expiryIn', { time: countdown(left) }) : t('view.expiryExpired');
  };
  update();
  window.clearInterval(ticker);
  ticker = window.setInterval(update, 1000);
}

/* ------------------------------------------------------------------ */

window.addEventListener('pagehide', () => {
  window.clearInterval(ticker);
  revokeAll(objectUrls);
});

/*
 * 打开后密钥已经从地址栏抹掉（spec §8），于是"在同一个标签页里再次点开同一条链接"
 * 对浏览器来说只是 Fragment 变化 —— 属于同文档导航，脚本不会重新执行，
 * 页面会一直停在旧状态（含已销毁消息仍显示正文这种最不能接受的错）。
 * 这里显式接管：地址栏一重新出现合法密钥就整页重载，走一遍完整流程。
 */
window.addEventListener('hashchange', () => {
  if (parseFragment(location.hash)) location.reload();
});

/*
 * 语言：先接好重绘回调、再跟随浏览器语言（必要时下载另一种语言包），
 * 之后才启动 boot —— 这样第一屏文案就是正确语言，而不是先默认后切换。
 */
onLocaleChange(paintLoading);
onLocaleChange(paintFatal);
onLocaleChange(renderBadge);
void initLocale();

void boot().catch((err: unknown) => {
  console.error('[1tmsg] boot failed', err);
  fatalText('view.errUnavailableTitle', err instanceof Error ? err.message : t('view.errRetryLater'));
  toast(t('view.errOpenFailedShort'), 'error');
});
