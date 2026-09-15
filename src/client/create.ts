/**
 * 创建页逻辑（spec §3 / §10）
 * 明文只在这里存在：组装 payload → 派生密钥 → AES-GCM 加密 → 只把密文发出去。
 */
import {
  DEFAULT_TTL_SECONDS,
  MAX_MESSAGE_BYTES,
  MAX_NOTE_LENGTH,
  MAX_VIEWS,
  MIN_PASSWORD_LENGTH,
  MIN_VIEWS,
  PBKDF2_ITERATIONS,
  PBKDF2_SALT_BYTES,
  KEY_BYTES,
} from '../config';
import { LocaleError, onLocaleChange, t } from '../i18n';
import type { Attachment } from '../types';
import { PAYLOAD_VERSION_R2 } from '../types';
import { ApiError, api } from './api';
import type { Bytes } from './bytes';
import { b64u, formatBytes, randomBytes } from './bytes';
import {
  buildFragment,
  buildPayload,
  computeVerifier,
  deriveAttachmentKey,
  deriveMessageKeyBits,
  derivePasswordKey,
  encryptBytes,
  encryptPayload,
  importAesKey,
  serializePayload,
} from './crypto';
import { MessageEditor } from './editor';
import { initLocale } from '../i18n';
import {
  bindPasswordToggle,
  copyText,
  el,
  hideProgress,
  humanTtl,
  maybe,
  setBusy,
  setText,
  show,
  showProgress,
  toast,
  ttlLabel,
} from './ui';

const burnSwitch = el<HTMLButtonElement>('burn');
const burnRow = el('burnRow');
const burnHint = el('burnHint');
const viewsField = el('viewsField');
const viewsInput = el<HTMLInputElement>('views');
const ttlChips = el('ttl');
const pwSwitch = el<HTMLButtonElement>('pw');
const pwRow = el('pwRow');
const pwHint = el('pwHint');
const pwField = el('pwField');
const pwInput = el<HTMLInputElement>('pwd');
const strength = document.querySelector<HTMLElement>('.str');
const summary = el('sum');
const createBtn = el<HTMLButtonElement>('create');
const noteInput = el<HTMLInputElement>('note');
const createScreen = el('createScreen');
const sentScreen = el('sentScreen');

let ttlSeconds = DEFAULT_TTL_SECONDS;
let failedOnce = false;

/* ------------------------------------------------------------------ */
/* 文案：唯一定义处，初始渲染与状态切换共用                            */
/* ------------------------------------------------------------------ */

function setHint(node: HTMLElement, main: string, mut: string): void {
  node.replaceChildren(document.createTextNode(main));
  if (mut) {
    const mutSpan = document.createElement('span');
    mutSpan.className = 'mut';
    mutSpan.textContent = mut;
    node.append(mutSpan);
  }
}

/**
 * 开关说明文案的唯一出处：初始化、翻动开关、切换语言三条路径都走这里，
 * 保证「说明」永远与「当前开关状态」一致。
 */
function renderConfigHints(): void {
  const burn = isOn(burnSwitch);
  const pw = isOn(pwSwitch);
  setHint(
    burnHint,
    burn ? t('create.burnTipOn') : t('create.burnTipOff'),
    burn ? t('create.burnMutOn') : '',
  );
  setHint(
    pwHint,
    pw ? t('create.pwTipOn') : t('create.pwTipOff'),
    pw ? t('create.pwMutOn') : t('create.pwMutOff'),
  );
}

const isOn = (node: HTMLElement): boolean => node.getAttribute('aria-checked') === 'true';

/* ------------------------------------------------------------------ */
/* 编辑器                                                              */
/* ------------------------------------------------------------------ */

const editor = new MessageEditor({
  textarea: 'md',
  body: 'bodyField',
  preview: 'pv',
  tray: 'atray',
  thumbs: 'thumbs',
  counter: 'count',
  fileInput: 'fileInput',
  dropZone: 'editorCard',
});

editor.mount();
window.addEventListener('pagehide', () => editor.dispose());

/* 编辑 / 预览 */
el('mode').addEventListener('click', (event) => {
  const button = (event.target as HTMLElement).closest<HTMLButtonElement>('button[data-mode]');
  if (!button) return;
  for (const child of Array.from(el('mode').children)) {
    child.setAttribute('aria-pressed', String(child === button));
  }
  editor.setPreview(button.dataset.mode === 'view');
});

/* ------------------------------------------------------------------ */
/* 配置联动                                                            */
/* ------------------------------------------------------------------ */

function clampViews(raw: string): number {
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n)) return MIN_VIEWS;
  return Math.min(MAX_VIEWS, Math.max(MIN_VIEWS, n));
}

function renderSummary(): void {
  const burn = isOn(burnSwitch);
  const withPassword = isOn(pwSwitch);
  const rows: Array<[string, string]> = [
    [t('sum.expire'), t('sum.afterTtl', { ttl: ttlLabel(ttlSeconds) })],
    burn
      ? [t('sum.burn'), t('sum.burnVal')]
      : [t('sum.views'), t('sum.viewsVal', { n: clampViews(viewsInput.value) })],
  ];
  if (withPassword) rows.push([t('sum.pw'), t('sum.pwVal')]);

  summary.replaceChildren(
    ...rows.map(([k, v]) => {
      const row = document.createElement('span');
      row.className = 'srow';
      const key = document.createElement('span');
      key.className = 'k';
      key.textContent = k;
      const value = document.createElement('span');
      value.className = 'v';
      value.textContent = v;
      row.append(key, value);
      return row;
    }),
  );
}

function bindSwitch(
  node: HTMLButtonElement,
  row: HTMLElement,
  onFlip: (on: boolean) => void,
): void {
  node.addEventListener('click', () => {
    const next = !isOn(node);
    node.setAttribute('aria-checked', String(next));
    row.classList.toggle('on', next);
    onFlip(next);
    renderSummary();
  });
}

bindSwitch(burnSwitch, burnRow, (on) => {
  show(viewsField, !on);
  renderConfigHints();
});

bindSwitch(pwSwitch, pwRow, (on) => {
  show(pwField, on);
  renderConfigHints();
});

/* 初始化：让说明文案与初始状态严格一致 */
renderConfigHints();
show(viewsField, false);
show(pwField, false);

ttlChips.addEventListener('click', (event) => {
  const button = (event.target as HTMLElement).closest<HTMLButtonElement>('button');
  if (!button) return;
  ttlSeconds = Number(button.dataset.ttl ?? DEFAULT_TTL_SECONDS);
  for (const child of Array.from(ttlChips.children)) {
    child.setAttribute('aria-pressed', String(child === button));
  }
  renderSummary();
});

for (const button of Array.from(document.querySelectorAll<HTMLButtonElement>('[data-step]'))) {
  button.addEventListener('click', () => {
    const delta = Number(button.dataset.step ?? '1');
    viewsInput.value = String(clampViews(String((Number.parseInt(viewsInput.value, 10) || 1) + delta)));
    renderSummary();
  });
}
viewsInput.addEventListener('input', () => {
  viewsInput.value = viewsInput.value.replace(/[^\d]/g, '').slice(0, 3);
  renderSummary();
});
viewsInput.addEventListener('blur', () => {
  viewsInput.value = String(clampViews(viewsInput.value));
  renderSummary();
});

/* 密码强度 + 显示密码 */
pwInput.addEventListener('input', () => {
  const v = pwInput.value;
  let score = 0;
  if (v.length >= 6) score = 1;
  if (v.length >= 10 && /\d/.test(v)) score = 2;
  if (v.length >= 12 && /[^A-Za-z0-9]/.test(v)) score = 3;
  if (v.length >= 14 && /[A-Z]/.test(v) && /\d/.test(v) && /[^A-Za-z0-9]/.test(v)) score = 4;
  strength?.setAttribute('data-s', String(score));
  renderSummary();
});
bindPasswordToggle(maybe('eye'), pwInput);

noteInput.maxLength = MAX_NOTE_LENGTH;
noteInput.addEventListener('input', () => {
  if (noteInput.value.length >= MAX_NOTE_LENGTH) noteInput.value = noteInput.value.slice(0, MAX_NOTE_LENGTH);
});

renderSummary();

/* ------------------------------------------------------------------ */
/* 创建                                                                */
/* ------------------------------------------------------------------ */

createBtn.addEventListener('click', () => {
  void onCreate();
});

async function onCreate(): Promise<void> {
  if (createBtn.disabled) return;

  const note = noteInput.value.trim();
  const content = editor.content;
  // 关闭图片功能时编辑器不会产生附件；兜一层防回归（服务端也会拒绝带附件的请求）
  const attachments = __ENABLE_IMAGES__ ? editor.attachments : [];
  const burn = isOn(burnSwitch);
  const withPassword = isOn(pwSwitch);
  const password = pwInput.value;

  if (note.length === 0 && content.trim().length === 0 && attachments.length === 0) {
    toast(t('create.errEmpty'), 'error');
    noteInput.focus();
    return;
  }
  if (withPassword && password.length < MIN_PASSWORD_LENGTH) {
    toast(t('create.errPwShort', { n: MIN_PASSWORD_LENGTH }), 'error');
    pwInput.focus();
    return;
  }

  /*
   * 走到这里就注定要去「已创建」屏了（中途失败重来也只是白下 2KB），
   * 而下面的 PBKDF2 与图片上传通常要几百毫秒 —— 趁这段时间把二维码生成器拉下来，
   * 切屏时二维码就是现成的，不会先闪一个空方框。
   */
  const qrModule = import('./qr');

  /** 中途失败时用于回滚：把半条消息连同已上传的 R2 对象一起清掉 */
  let messageId = '';
  setBusy(createBtn, true);
  /* 进度文案统一走居中弹窗：按钮只负责禁用，不再承载「加密/上传到第几张」这类状态 */
  showProgress(t('create.progressEncrypt'));
  try {
    /* 1) K_link：只存在于 URL Fragment */
    const kLink = randomBytes(KEY_BYTES);

    /* 2) 可选：PBKDF2 → K_password，并派生服务端验密码用的 verifier */
    let kPassword: Bytes | null = null;
    let salt: Bytes | null = null;
    let verifier: string | null = null;
    if (withPassword) {
      salt = randomBytes(PBKDF2_SALT_BYTES);
      kPassword = await derivePasswordKey(password, salt, PBKDF2_ITERATIONS);
      verifier = await computeVerifier(kPassword);
    }

    /* 3) K_msg = HKDF(K_link ‖ K_password?) —— 文本与图片的密钥都从它派生 */
    const kMsg = await deriveMessageKeyBits(kLink, kPassword);

    /*
     * 4) 逐张加密图片，每张一个独立密钥：
     *      K_att = HKDF(ikm = K_msg, info = "1tmsg/v1/attachment/<aid>")
     *    确定性派生，所以清单里只存 IV，不需要保存任何密钥材料。
     */
    const refs: Attachment[] = [];
    const blobs: Array<{ id: string; bytes: Bytes }> = [];
    for (const item of attachments) {
      const key = await deriveAttachmentKey(kMsg, item.id);
      const { bytes, iv } = await encryptBytes(key, item.bytes);
      refs.push({ id: item.id, name: item.name, type: item.type, size: item.size, iv });
      blobs.push({ id: item.id, bytes });
    }

    /* 5) 文本 payload 只带附件元信息与 IV —— 图片字节不进这里 */
    const plaintext = serializePayload(buildPayload(note, content, refs, PAYLOAD_VERSION_R2));
    if (plaintext.byteLength > MAX_MESSAGE_BYTES) {
      // LocaleError：这条 message 已经是当前语言的成品，catch 里直接展示
      throw new LocaleError(
        t('create.errTooLarge', {
          size: formatBytes(plaintext.byteLength),
          limit: formatBytes(MAX_MESSAGE_BYTES),
        }),
      );
    }

    /* 6) AES-256-GCM 加密整条文本 payload */
    const messageKey = await importAesKey(kMsg);
    const { ciphertext, iv } = await encryptPayload(messageKey, plaintext);

    /* 7) 只发文本密文与生命周期参数；附件只报形状，服务端据此分配上传槽位 */
    const created = await api.createMessage({
      ciphertext,
      iv,
      salt: salt ? b64u(salt) : null,
      verifier,
      kdfIterations: withPassword ? PBKDF2_ITERATIONS : null,
      expiresInSeconds: ttlSeconds,
      maxViews: burn ? 1 : clampViews(viewsInput.value),
      attachments: refs.map((r) => ({ id: r.id, size: r.size })),
    });
    messageId = created.id;

    /*
     * 8) 图片密文逐个 PUT 进 R2，最后 finalize。
     *    在 finalize 之前消息是 pending，谁 consume 都会拿到 409 ——
     *    这样就不会出现「收件人先看到消息、图片还没传完」的半条消息。
     */
    if (created.uploadToken !== null && blobs.length > 0) {
      for (let i = 0; i < blobs.length; i += 1) {
        const blob = blobs[i] as { id: string; bytes: Bytes };
        showProgress(t('create.progressUpload', { i: i + 1, total: blobs.length }));
        await api.uploadAttachment(created.id, blob.id, created.uploadToken, blob.bytes);
      }
      showProgress(t('create.progressConfirm'));
      await api.finalize(created.id, created.uploadToken);
    }

    const base = `${location.host}/m/${created.id}`;
    const fragment = `#${buildFragment(kLink)}`;
    const link = `${location.origin}/m/${created.id}${fragment}`;

    /* 收尾：先撤掉进度弹窗再切屏 —— 否则自动复制（可能弹权限框）期间，
       弹窗会一直压在「消息已创建」页面上 */
    hideProgress();
    showSent(link, base, fragment, burn ? 1 : clampViews(viewsInput.value), withPassword);
    void fillQr(qrModule, link);
    const copied = await copyText(link);
    if (!copied) toast(t('create.errAutoCopy'), 'error');
  } catch (err) {
    // 回滚尽力而为：失败也不能盖掉用户真正需要看到的报错
    if (messageId.length > 0) void api.discard(messageId);

    /*
     * 能给用户看的话只有两类：ApiError（api.ts 已按 code 取好当前语言的文案）
     * 与 LocaleError（抛出时就是成品文案）。其余异常是技术性的
     * （例如 crypto 抛的 ciphertext-corrupt），原样展示只会吓到人 —— 统一给通用文案。
     */
    const message =
      err instanceof ApiError || err instanceof LocaleError
        ? err.message
        : t('create.errFailed');
    toast(message, 'error');
    if (!failedOnce) {
      failedOnce = true;
      console.error('[1tmsg] create failed', err);
    }
  } finally {
    setBusy(createBtn, false);
    hideProgress();
  }
}

/* ------------------------------------------------------------------ */
/* 已创建                                                              */
/* ------------------------------------------------------------------ */

/** 已创建页的动态值：语言切换时要用当前语言重算一遍 */
let sentState: { maxViews: number; withPassword: boolean } | null = null;

/** 已经画出来的二维码节点；语言切换时要拿它刷新 aria-label */
let qrSvg: SVGElement | null = null;

/** qr.ts 里用得上的那一个函数。写窄一点，省掉一个 import type */
type QrModule = {
  renderQr: (host: HTMLElement, text: string, ariaLabel: string) => SVGElement;
};

/**
 * 把二维码填进已创建屏。
 *
 * 单独 try/catch，**不能**并进 onCreate 那个 catch —— 那边会回滚消息、弹「创建失败」，
 * 而二维码拉不下来只是少了个扫码入口（复制按钮与链接照旧可用）。
 * 这里唯一会失败的事就是把模块拉下来（离线 / 被拦截），所以失败就整块收起，
 * 不留一个空白方框。
 */
async function fillQr(pending: Promise<QrModule>, link: string): Promise<void> {
  try {
    const { renderQr } = await pending;
    qrSvg = renderQr(el('qrbox'), link, t('sent.qrAria'));
  } catch (err) {
    show(el('qr'), false);
    console.error('[1tmsg] qr failed', err);
  }
}

function renderSentSummary(): void {
  if (!sentState) return;
  setText('sentBurn', t('sent.burnVal', { n: sentState.maxViews }));
  setText('sentTtl', humanTtl(ttlSeconds));
  setText('sentKey', sentState.withPassword ? t('sent.keyValPw') : t('sent.keyValLink'));
}

function showSent(
  link: string,
  base: string,
  fragment: string,
  maxViews: number,
  withPassword: boolean,
): void {
  const box = el('sentLink');
  box.replaceChildren(document.createTextNode(base));
  const em = document.createElement('em');
  em.textContent = fragment;
  box.append(em);
  box.title = link;

  sentState = { maxViews, withPassword };
  renderSentSummary();

  show(createScreen, false);
  show(sentScreen, true);
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

el('sentCopy').addEventListener('click', async (event) => {
  const button = event.currentTarget as HTMLButtonElement;
  const link = el('sentLink').title;
  const ok = await copyText(link);
  const label = button.querySelector('span');
  if (label) label.textContent = ok ? t('sent.copied') : t('sent.copyFailed');
  window.setTimeout(() => {
    if (label) label.textContent = t('sent.copy');
  }, 1800);
});

el('again').addEventListener('click', () => {
  location.assign('/');
});

/* ------------------------------------------------------------------ */
/* 语言                                                                */
/* ------------------------------------------------------------------ */

/*
 * 两个重绘都读当前 DOM 状态，语言切换时直接重跑即可；
 * initLocale 还负责跟随浏览器语言并接上顶栏的切换按钮。
 */
onLocaleChange(renderSummary);
onLocaleChange(renderConfigHints);
onLocaleChange(renderSentSummary);
/* 二维码节点也是 JS 建的，它的 aria-label 跟着语言走 */
onLocaleChange(() => qrSvg?.setAttribute('aria-label', t('sent.qrAria')));
void initLocale();
