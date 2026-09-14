/**
 * Markdown 编辑器 + 图片处理（spec §4 / §5 / §24）
 *
 * 图片从进入编辑器那一刻起就只在浏览器内存里，并且保持**原始字节**：
 *   File → ArrayBuffer → （提交时）AES-GCM → R2 对象
 * 这里不再做 base64：图片密文走二进制直传，base64 只会白白膨胀 1/3，
 * 而且改造后图片字节根本不进 payload。
 */
import {
  MAX_ATTACHMENT_BYTES,
  MAX_ATTACHMENTS,
  MAX_CONTENT_LENGTH,
  MAX_TOTAL_ATTACHMENT_BYTES,
  MB,
} from '../config';
import { onLocaleChange, t, type MsgKey } from '../i18n';
import type { Bytes } from './bytes';
import { formatBytes } from './bytes';
import { hydrateMarkdown, renderMarkdown, revokeAll } from './markdown';
import { el, maybe, toast } from './ui';

export interface EditorAttachment {
  id: string;
  name: string;
  type: string;
  size: number;
  /** 原始字节，只在浏览器内存里；提交时才加密成 R2 上的独立对象 */
  bytes: Bytes;
  /** 本地预览用的 object URL，不随消息上传 */
  previewUrl: string;
}

/** 工具栏动作 → [前缀, 后缀, 占位文本键]。code 的占位符就是字面 `code`，不进字典 */
const WRAP: Record<string, [string, string, MsgKey | null]> = {
  bold: ['**', '**', 'editor.wrapBold'],
  italic: ['*', '*', 'editor.wrapItalic'],
  code: ['`', '`', null],
  link: ['[', '](https://)', 'editor.wrapLink'],
};

/** 整 MB 的紧凑写法（100MB 而不是 100.00 MB），用于托盘上的一行提示 */
const mb = (n: number): string => `${Math.round(n / MB)}MB`;

/**
 * 正文占位文案分两份。
 * 静态 HTML 里带的是不带图片的那份（构建期已按默认语言烤好）—— 部署默认关闭图片
 * 功能，首屏（脚本执行前）看到的文案必须与默认态一致，否则会出现
 * 「提示可以拖入图片、可入口其实不存在」的错配。
 */
const placeholderOf = (withImages: boolean): string =>
  t(withImages ? 'editor.placeholderImage' : 'editor.placeholderPlain');

export class MessageEditor {
  readonly textarea: HTMLTextAreaElement;

  private readonly body: HTMLElement;
  private readonly preview: HTMLElement;
  private readonly tray: HTMLElement;
  private readonly thumbs: HTMLElement;
  private readonly counter: HTMLElement;
  private readonly fileInput: HTMLInputElement;
  private readonly dropZone: HTMLElement;

  private items: EditorAttachment[] = [];
  private seq = 0;
  private caret = 0;
  private changeCb: () => void = () => {};
  private previewing = false;

  constructor(ids: {
    textarea: string;
    body: string;
    preview: string;
    tray: string;
    thumbs: string;
    counter: string;
    fileInput: string;
    dropZone: string;
  }) {
    this.textarea = el<HTMLTextAreaElement>(ids.textarea);
    this.body = el(ids.body);
    this.preview = el(ids.preview);
    this.tray = el(ids.tray);
    this.thumbs = el(ids.thumbs);
    this.counter = el(ids.counter);
    this.fileInput = el<HTMLInputElement>(ids.fileInput);
    this.dropZone = el(ids.dropZone);
  }

  /* -------------------- 对外 API -------------------- */

  get content(): string {
    return this.textarea.value;
  }

  get attachments(): EditorAttachment[] {
    return this.items;
  }

  get totalBytes(): number {
    return this.items.reduce((n, a) => n + a.size, 0);
  }

  onChange(cb: () => void): void {
    this.changeCb = cb;
  }

  /** 把 object URL 交给渲染层，供预览态使用 */
  attachmentUrlMap(): Map<string, string> {
    return new Map(this.items.map((a) => [a.id, a.previewUrl]));
  }

  /** 清空全部内容并释放 object URL */
  reset(): void {
    this.textarea.value = '';
    this.items = [];
    this.seq = 0;
    this.caret = 0;
    this.thumbs.replaceChildren();
    this.preview.replaceChildren();
    this.setPreview(false);
    this.syncCount();
    this.changeCb();
  }

  setPreview(on: boolean): void {
    this.previewing = on;
    this.body.classList.toggle('previewing', on);
    this.textarea.hidden = on;
    this.preview.hidden = !on;
    if (on) this.refreshPreview();
  }

  /* -------------------- 绑定 -------------------- */

  mount(): void {
    this.textarea.maxLength = MAX_CONTENT_LENGTH;
    this.syncCount();

    this.textarea.addEventListener('input', () => {
      this.caret = this.textarea.selectionStart;
      this.syncCount();
      if (this.previewing) this.refreshPreview();
      this.changeCb();
    });
    for (const ev of ['keyup', 'click', 'select'] as const) {
      this.textarea.addEventListener(ev, () => {
        this.caret = this.textarea.selectionStart;
      });
    }

    /* 工具栏 */
    for (const btn of Array.from(document.querySelectorAll<HTMLButtonElement>('.mdtb [data-md]'))) {
      btn.addEventListener('click', () => this.applyToolbar(btn.dataset.md ?? ''));
    }

    /*
     * 图片相关的一切都收在这个开关里：入口显隐、附件托盘、拖拽、粘贴、选图。
     * 关闭时整块被构建期消除 —— 条件要直写 __ENABLE_IMAGES__ 并用 if/else 包住，
     * 换成 const 别名或 `if (!…) return` 都压不掉（详见 docs/spec.md §25）。
     * 也不能只藏按钮不摘监听，否则拖进图片会被静默吞掉。
     */
    if (__ENABLE_IMAGES__) {
      this.textarea.placeholder = placeholderOf(true);
      for (const node of Array.from(document.querySelectorAll<HTMLElement>('[data-img-only]'))) {
        node.hidden = false;
      }

      /* 附件上限文案：数值从 config 取，措辞从字典取 —— 数值只在这里定义一次，
         避免提示写 5MB、校验却按 100MB 这类「文案与规则脱节」的老问题。 */
      const tip = maybe('atipText');
      if (tip) {
        tip.textContent = t('editor.attachTip', {
          single: mb(MAX_ATTACHMENT_BYTES),
          total: mb(MAX_TOTAL_ATTACHMENT_BYTES),
          max: MAX_ATTACHMENTS,
        });
      }

      /* 选图入口：工具栏图标 + 附件托盘 + 号 */
      const picker = maybe<HTMLButtonElement>('pickImg');
      picker?.addEventListener('click', () => this.fileInput.click());
      this.thumbs.addEventListener('click', (event) => {
        const target = event.target as HTMLElement;
        const remove = target.closest<HTMLElement>('[data-remove]');
        if (remove?.dataset.remove) {
          this.removeAttachment(remove.dataset.remove);
          return;
        }
        if (target.closest('.tadd')) this.fileInput.click();
      });

      this.fileInput.addEventListener('change', () => {
        const files = this.fileInput.files;
        if (files && files.length > 0) void this.addFiles(files);
        this.fileInput.value = '';
      });

      /* 拖拽：托盘高亮 + 整卡接收 */
      for (const ev of ['dragenter', 'dragover'] as const) {
        this.dropZone.addEventListener(ev, (e) => {
          e.preventDefault();
          this.tray.classList.add('hot');
        });
      }
      for (const ev of ['dragleave', 'dragend'] as const) {
        this.dropZone.addEventListener(ev, () => this.tray.classList.remove('hot'));
      }
      this.dropZone.addEventListener('drop', (e) => {
        e.preventDefault();
        this.tray.classList.remove('hot');
        const files = e.dataTransfer?.files;
        if (files && files.length > 0) void this.addFiles(files);
      });

      /* 防止浏览器把图片拖到别处直接打开 */
      for (const ev of ['dragover', 'drop'] as const) {
        document.addEventListener(ev, (e) => {
          if (!this.dropZone.contains(e.target as Node)) e.preventDefault();
        });
      }

      /* 语言切换后这两处带数值的文案要按当前语言重算（其余走 data-i18n） */
      onLocaleChange(() => {
        this.textarea.placeholder = placeholderOf(true);
        const tipNode = maybe('atipText');
        if (tipNode) {
          tipNode.textContent = t('editor.attachTip', {
            single: mb(MAX_ATTACHMENT_BYTES),
            total: mb(MAX_TOTAL_ATTACHMENT_BYTES),
            max: MAX_ATTACHMENTS,
          });
        }
      });

      /* Cmd/Ctrl + V 粘贴图片（全局，任意焦点位置都生效） */
      document.addEventListener('paste', (e) => {
        const files = this.clipboardImages(e);
        if (files.length === 0) return;
        e.preventDefault();
        void this.addFiles(files);
      });
    } else {
      /* 静态 HTML 里带的就是这一份；显式设一遍，让开关成为正文文案的唯一判据 */
      this.textarea.placeholder = placeholderOf(false);
    }
  }

  /* -------------------- 内部 -------------------- */

  private clipboardImages(event: ClipboardEvent): File[] {
    const dt = event.clipboardData;
    if (!dt) return [];
    const out: File[] = [];
    for (const item of Array.from(dt.items ?? [])) {
      if (item.kind !== 'file' || !item.type.startsWith('image/')) continue;
      const file = item.getAsFile();
      if (file) out.push(file);
    }
    if (out.length === 0) {
      for (const file of Array.from(dt.files ?? [])) {
        if (file.type.startsWith('image/')) out.push(file);
      }
    }
    return out;
  }

  private applyToolbar(action: string): void {
    const start = this.textarea.selectionStart;
    const end = this.textarea.selectionEnd;
    const value = this.textarea.value;
    const selected = value.slice(start, end);

    if (action === 'list') {
      const block = (selected || t('editor.wrapListItem')).split('\n').map((line) => `- ${line}`).join('\n');
      this.replaceRange(start, end, block, start + block.length);
      return;
    }

    const spec = WRAP[action];
    if (!spec) return;
    const [prefix, suffix, placeholderKey] = spec;
    const inner = selected || (placeholderKey === null ? 'code' : t(placeholderKey));
    const text = `${prefix}${inner}${suffix}`;
    this.replaceRange(start, end, text, start + prefix.length + inner.length);
  }

  private replaceRange(start: number, end: number, text: string, caret: number): void {
    const value = this.textarea.value;
    this.textarea.value = value.slice(0, start) + text + value.slice(end);
    this.textarea.focus();
    this.textarea.setSelectionRange(caret, caret);
    this.caret = caret;
    this.syncCount();
    if (this.previewing) this.refreshPreview();
    this.changeCb();
  }

  private insertAtCaret(text: string): void {
    const at = Math.min(this.caret, this.textarea.value.length);
    const value = this.textarea.value;
    // 保证代码块/图片语法独占一行
    const prefix = at > 0 && value[at - 1] !== '\n' ? '\n' : '';
    const block = `${prefix}${text}`;
    this.replaceRange(at, at, block, at + block.length);
  }

  private syncCount(): void {
    this.counter.textContent = String(this.textarea.value.length);
  }

  private refreshPreview(): void {
    this.preview.innerHTML = renderMarkdown(this.textarea.value);
    hydrateMarkdown(this.preview, this.attachmentUrlMap());
  }

  /** 添加图片：校验 → 读取 → 生成附件 → 插入 Markdown 引用 */
  async addFiles(files: FileList | File[]): Promise<void> {
    // 关闭图片功能时没有任何入口能走到这里；常量条件让这段在构建期被整句消除
    if (!__ENABLE_IMAGES__) return;

    const images = Array.from(files).filter((f) => f.type.startsWith('image/'));
    if (images.length === 0) {
      if (files.length > 0) toast(t('editor.notImage'), 'error');
      return;
    }

    const rejected: string[] = [];
    let accepted = 0;

    for (const file of images) {
      if (this.items.length >= MAX_ATTACHMENTS) {
        rejected.push(t('editor.tooManyImages', { n: MAX_ATTACHMENTS }));
        break;
      }
      if (file.size > MAX_ATTACHMENT_BYTES) {
        rejected.push(t('editor.fileTooLarge', { name: file.name, limit: formatBytes(MAX_ATTACHMENT_BYTES) }));
        continue;
      }
      if (this.totalBytes + file.size > MAX_TOTAL_ATTACHMENT_BYTES) {
        rejected.push(t('editor.totalTooLarge', { limit: formatBytes(MAX_TOTAL_ATTACHMENT_BYTES) }));
        break;
      }

      let bytes: Bytes;
      try {
        bytes = new Uint8Array(await file.arrayBuffer());
      } catch {
        rejected.push(t('editor.fileReadFailed', { name: file.name }));
        continue;
      }
      if (bytes.byteLength > MAX_ATTACHMENT_BYTES) {
        rejected.push(t('editor.fileTooLarge', { name: file.name, limit: formatBytes(MAX_ATTACHMENT_BYTES) }));
        continue;
      }

      this.seq += 1;
      const id = `img-${this.seq}`;
      const blob = new Blob([bytes as unknown as BlobPart], { type: file.type });
      const attachment: EditorAttachment = {
        id,
        name: file.name || t('editor.imageName', { n: this.seq }),
        type: file.type,
        size: bytes.byteLength,
        bytes,
        previewUrl: URL.createObjectURL(blob),
      };
      this.items.push(attachment);
      this.thumbs.insertBefore(this.thumbNode(attachment), this.addButton());
      this.insertAtCaret(`![${attachment.name}](${'attachment://'}${id})\n`);
      accepted += 1;
    }

    if (rejected.length > 0) toast(rejected[0] as string, 'error');
    else if (accepted > 0) toast(t('editor.inserted', { n: accepted }));
  }

  private addButton(): ChildNode | null {
    return this.thumbs.querySelector('.tadd');
  }

  private thumbNode(attachment: EditorAttachment): HTMLElement {
    const wrap = document.createElement('span');
    wrap.className = 'thumb';
    wrap.title = `${attachment.name} · ${formatBytes(attachment.size)}`;

    const img = document.createElement('img');
    img.src = attachment.previewUrl;
    img.alt = attachment.name;
    img.decoding = 'async';

    const remove = document.createElement('button');
    remove.className = 'x';
    remove.type = 'button';
    remove.title = t('editor.remove');
    remove.dataset.remove = attachment.id;
    remove.textContent = '×';

    wrap.append(img, remove);
    return wrap;
  }

  private removeAttachment(id: string): void {
    const index = this.items.findIndex((a) => a.id === id);
    if (index < 0) return;
    const [removed] = this.items.splice(index, 1);
    if (removed) URL.revokeObjectURL(removed.previewUrl);

    const node = this.thumbs.querySelector(`[data-remove="${id}"]`)?.closest('.thumb');
    node?.remove();

    // 同步移除正文里的引用，避免残留悬空图片
    const pattern = new RegExp(`!\\[[^\\]]*\\]\\(attachment://${id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\)\\n?`, 'g');
    this.textarea.value = this.textarea.value.replace(pattern, '');
    this.syncCount();
    if (this.previewing) this.refreshPreview();
    this.changeCb();
  }

  /** 页面卸载时释放所有 object URL */
  dispose(): void {
    revokeAll(this.attachmentUrlMap());
  }
}
