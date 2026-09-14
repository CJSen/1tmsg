/** 极小的 DOM / 交互工具层 */
import { onLocaleChange, t } from '../i18n';

export function el<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`missing element #${id}`);
  return node as T;
}

export function maybe<T extends HTMLElement>(id: string): T | null {
  return document.getElementById(id) as T | null;
}

export function show(node: HTMLElement, visible: boolean): void {
  node.hidden = !visible;
}

export function setText(id: string, text: string): void {
  const node = document.getElementById(id);
  if (node) node.textContent = text;
}

/**
 * 忙碌态开关。
 *
 * 进入忙碌态时把按钮原始文案记在 dataset 上，退出时恢复 ——
 * 否则「密码错误」这类失败路径只调用 setBusy(btn, false)，
 * 按钮会永远停在「正在本地解密…」，看起来像是卡死了。
 */
export function setBusy(button: HTMLButtonElement, busy: boolean, label?: string): void {
  button.disabled = busy;
  button.setAttribute('aria-busy', String(busy));
  const span = button.querySelector('span');
  if (!span) return;

  if (busy) {
    if (button.dataset.idleLabel === undefined) button.dataset.idleLabel = span.textContent ?? '';
    if (label !== undefined) span.textContent = label;
    return;
  }
  if (button.dataset.idleLabel !== undefined) {
    span.textContent = button.dataset.idleLabel;
    delete button.dataset.idleLabel;
  }
}

let toastTimer: number | undefined;

export function toast(message: string, kind: 'info' | 'error' = 'info'): void {
  let node = document.querySelector<HTMLDivElement>('.toast');
  if (!node) {
    node = document.createElement('div');
    node.className = 'toast';
    node.setAttribute('role', 'status');
    node.setAttribute('aria-live', 'polite');
    document.body.append(node);
  }
  node.textContent = message;
  node.classList.toggle('err', kind === 'error');
  node.classList.add('on');
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => node?.classList.remove('on'), 3600);
}

/* ------------------------------------------------------------------ */
/* 居中进度弹窗                                                        */
/* ------------------------------------------------------------------ */

/**
 * 阻塞式进度反馈（本地加密 / 图片上传 / 确认）。
 *
 * 与 toast 的区别：toast 是不打扰的角落提示，而这几步是「用户必须等完」的
 * 串行流程 —— 弹窗负责挡住页面，避免在上传途中被重复点击或误操作。
 * 节点只创建一次并常驻 DOM（同 toast），样式全部来自 styles.css，页面零内联样式。
 */
let overlay: { root: HTMLDivElement; text: HTMLParagraphElement } | null = null;
let wantVisible = false;

export function showProgress(message: string): void {
  wantVisible = true;
  if (!overlay || !overlay.root.isConnected) {
    const root = document.createElement('div');
    root.className = 'modal';
    root.setAttribute('role', 'status');
    root.setAttribute('aria-live', 'polite');
    root.setAttribute('aria-busy', 'true');

    const box = document.createElement('div');
    box.className = 'modal-bd';

    const spin = document.createElement('div');
    spin.className = 'spin';
    spin.setAttribute('role', 'presentation');

    const text = document.createElement('p');
    text.className = 'modal-tx';

    box.append(spin, text);
    root.append(box);
    document.body.append(root);
    overlay = { root, text };
    // 先落地透明态，下一帧再上 .on —— 否则首次插入时浏览器不会补间
    // （同一帧内 append + 加类 = 直接以终态绘制）。
    requestAnimationFrame(() => {
      if (wantVisible) root.classList.add('on');
    });
  } else {
    overlay.root.classList.add('on');
  }
  overlay.text.textContent = message;
}

export function hideProgress(): void {
  wantVisible = false;
  overlay?.root.classList.remove('on');
}

export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* 退回到 execCommand */
  }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.className = 'sr';
    document.body.append(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  } catch {
    return false;
  }
}

/** 剩余时间 → "1:03:12" / "53:12"；到点后返回「已失效」 */
export function countdown(ms: number): string {
  if (ms <= 0) return t('unit.expired');
  const total = Math.floor(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${m}:${String(s).padStart(2, '0')}`;
}

/** 秒 → "1 小时后失效" / "Expires in 1 hour" */
export function humanTtl(seconds: number): string {
  return t('view.expiryIn', { time: ttlLabel(seconds) });
}

/** 秒 → "1 小时" / "1 hour"（英文单复数由 n 驱动，见 i18n/zh.ts 的 `||` 约定） */
export function ttlLabel(seconds: number): string {
  if (seconds % 86400 === 0) return t('unit.day', { n: seconds / 86400 });
  if (seconds % 3600 === 0) return t('unit.hour', { n: seconds / 3600 });
  if (seconds % 60 === 0) return t('unit.minute', { n: seconds / 60 });
  return t('unit.second', { n: seconds });
}

/** 切换密码显示/隐藏 */
export function bindPasswordToggle(button: HTMLElement | null, input: HTMLInputElement | null): void {
  if (!button || !input) return;
  // aria-label 由这里动态维护（跟随当前显隐状态），语言切换时重算一遍
  const render = (): void => {
    button.setAttribute('aria-label', input.type === 'text' ? t('create.pwHide') : t('create.pwShow'));
  };
  render();
  onLocaleChange(render);
  button.addEventListener('click', () => {
    input.type = input.type === 'text' ? 'password' : 'text';
    render();
  });
}
