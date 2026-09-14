/**
 * Markdown 渲染 —— 严格对齐 spec §16：
 *   Markdown → Parse → ★Sanitize★ → DOM
 *
 * 三条硬规则：
 *  1. 永不出现 `marked.parse(x) → innerHTML`。解析结果必须先过 DOMPurify 白名单。
 *  2. **`src` 绝不出现在清理后的 HTML 里。** 只要 src 进了 innerHTML，浏览器就会立刻
 *     发起请求 —— 而发送者可以在 Markdown 里塞任意远端 URL 当跟踪像素，收件人一打开
 *     就泄露 IP。所以附件引用被重写成不带 src 的占位元素，真实 `blob:` URL 由
 *     hydrate 阶段（此时已经过清理）逐个赋给**我们自己的**图片。
 *  3. 不是附件的图片一律显示为「已阻止」占位，永不加载。
 */
import DOMPurify from 'dompurify';
import { t } from '../i18n';
import { marked } from 'marked';

/** 客户端内部引用，不是公网 URL（spec §4） */
export const ATTACHMENT_SCHEME = 'attachment://';

/** 占位元素上承载附件 id 的属性（src 被刻意排除在白名单外，见文件头注释） */
export const ATTACHMENT_ATTR = 'data-att';

/** `![alt](attachment://img-1)` */
const ATTACHMENT_REF_RE = /!\[([^\]]*)\]\(attachment:\/\/([A-Za-z0-9_-]{1,64})\)/g;

/**
 * DOMPurify 默认 URI 白名单（去掉 attachment:）。
 * 只作用于 `href`：`a` 是唯一被允许携带 URL 的元素，且点击前不会发起任何请求。
 */
const ALLOWED_URI_REGEXP =
  /^(?:(?:(?:f|ht)tps?|mailto|tel|callto|sms|cid|xmpp|matrix):|[^a-z]|[a-z+.\-]+(?:[^a-z+.\-:]|$))/i;

const ALLOWED_TAGS = [
  'p', 'br', 'hr', 'div', 'span',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'strong', 'b', 'em', 'i', 'u', 's', 'del', 'mark', 'small',
  'code', 'pre', 'kbd', 'samp', 'var',
  'blockquote', 'q', 'cite',
  'ul', 'ol', 'li', 'dl', 'dt', 'dd',
  'a', 'img', 'figure', 'figcaption',
  'table', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td', 'caption',
  'sup', 'sub', 'abbr', 'time',
];

/**
 * 注意这里**没有 `src`**。这是刻意的：白名单少了 src，DOMPurify 会把所有
 * `src` 属性剥掉（包括 `attachment://`），从而保证清理后的 HTML 进入 innerHTML
 * 时不会触发任何图片请求。我们自己的图片在 hydrate 阶段用 blob: URL 补 src。
 */
const ALLOWED_ATTR = [
  'href', 'title', 'alt', 'class', 'id',
  'colspan', 'rowspan', 'span', 'start', 'reversed',
  'datetime', 'lang', 'dir',
];

marked.setOptions({ gfm: true, breaks: false });

function escapeAttr(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/** 把附件引用换成不带 src 的占位 img（在交给 marked 之前做，所以用户无法伪造别的形式） */
export function tokenizeAttachments(source: string): string {
  return source.replace(ATTACHMENT_REF_RE, (_match, alt: string, id: string) => {
    const label = alt.length > 0 ? alt : id;
    return `<img ${ATTACHMENT_ATTR}="${id}" alt="${escapeAttr(label)}">`;
  });
}

/** Markdown → 安全的 HTML 字符串（其中不含任何 src） */
export function renderMarkdown(source: string): string {
  const html = marked.parse(tokenizeAttachments(source), { async: false }) as string;
  return DOMPurify.sanitize(html, {
    ALLOWED_TAGS,
    ALLOWED_ATTR,
    ALLOWED_URI_REGEXP,
    // data-att 是附件占位符的载体；data-* 属性本身是惰性的
    ALLOW_DATA_ATTR: true,
    ALLOW_UNKNOWN_PROTOCOLS: false,
    KEEP_CONTENT: true,
  });
}

function blocked(text: string): HTMLSpanElement {
  const span = document.createElement('span');
  span.className = 'imgblocked';
  span.textContent = text;
  return span;
}

/**
 * 把占位元素换成真实内容。
 * @param root        已写入 innerHTML 的容器
 * @param attachments 附件 id → blob: URL
 */
export function hydrateMarkdown(root: HTMLElement, attachments: Map<string, string>): void {
  // 表格兜底：列多/表头长时整张表可能比正文还宽，超出的部分会被 .card 的
  // overflow:hidden 静默裁掉。套一层可横向滚动的容器，宁可滑动也不丢内容。
  for (const node of Array.from(root.querySelectorAll('table'))) {
    const wrap = document.createElement('div');
    wrap.className = 'md-scroll';
    node.replaceWith(wrap);
    wrap.append(node);
  }

  for (const node of Array.from(root.querySelectorAll('img'))) {
    const img = node as HTMLImageElement;
    const id = img.getAttribute(ATTACHMENT_ATTR);

    if (id !== null) {
      const url = attachments.get(id);
      if (url) {
        img.src = url;
        img.className = 'msg-img';
        img.setAttribute('loading', 'lazy');
        img.setAttribute('decoding', 'async');
      } else {
        img.replaceWith(blocked(t('md.imageMissing', { alt: img.getAttribute('alt') || id })));
      }
      continue;
    }

    // 非附件图片：无论发送者写了什么（远端 URL / data: URI / attachment 之外的形式）
    // 都不加载，只留一个可读占位。
    img.replaceWith(blocked(img.getAttribute('alt') || t('md.imageBlocked')));
  }

  for (const node of Array.from(root.querySelectorAll('a[href]'))) {
    node.setAttribute('target', '_blank');
    node.setAttribute('rel', 'noopener noreferrer nofollow');
  }

  // 兜底：清理后不该有任何 src 残留，防御性再确认一次
  for (const node of Array.from(root.querySelectorAll('img[src]'))) {
    if (!(node as HTMLImageElement).src.startsWith('blob:')) node.removeAttribute('src');
  }
}

/**
 * 附件**明文** → blob URL 表。
 * 解密在调用方完成（v1 历史消息解 base64，v2 走 R2 + AES-GCM），
 * 这里只负责把明文落地成可渲染的 URL。
 */
export function attachmentUrls(
  items: ReadonlyArray<{ id: string; type: string; bytes: Uint8Array }>,
): Map<string, string> {
  const map = new Map<string, string>();
  for (const item of items) {
    const blob = new Blob([item.bytes as unknown as BlobPart], {
      type: item.type || 'application/octet-stream',
    });
    map.set(item.id, URL.createObjectURL(blob));
  }
  return map;
}

export function revokeAll(map: Map<string, string>): void {
  for (const url of map.values()) URL.revokeObjectURL(url);
  map.clear();
}
