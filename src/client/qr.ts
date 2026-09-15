/**
 * 分享链接二维码。
 *
 * 只服务「已创建」屏，所以不进主包 —— create.ts 在用户点下「创建」那一刻才
 * 动态 import（见那里的注释）。同类先例：src/i18n 的 loadOther。
 *
 * 为什么必须自持：被编码的字符串里含 `#` 之后的解密密钥，交给任何外域生成服务
 * 都等于把密钥送出去；何况 CSP 只放行 self / data:，外域图也显示不出来。
 *
 * 三条硬要求（别为了好看改）：
 *   1. 纯黑模块 + 纯白底 —— 套品牌色或深色底会直接掉识别率
 *   2. 静默区 ≥ 4 模块 —— 由 .qrbox 的 26px 内边距承担（styles.css §8），
 *      所以这里传 `border: 0`，免得与 CSS 内边距叠成十几模块的白边、把码面压小
 *   3. ecc 'M' —— 屏幕展示没有印刷磨损，但会有反光与斜角，留 15% 纠错余量
 */
import { encode } from 'uqr';

/** 墨色 900（与 --i900 同值）。写字面量而非令牌：二维码前景不该跟着配色漂 */
const MODULE_COLOR = '#1A1513';

/**
 * 把二维码画进 host（会清空原有内容），返回新建的 <svg>。
 *
 * 模块数随链接长度变（93 字符的真实链接在 ecc M 下是 41 模块 / 版本 6），
 * 渲染尺寸交给 CSS，这里只负责画对。
 */
export function renderQr(host: HTMLElement, text: string, ariaLabel: string): SVGElement {
  const { data, size } = encode(text, { ecc: 'M', border: 0 });

  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', `0 0 ${size} ${size}`);
  svg.setAttribute('shape-rendering', 'crispEdges');
  svg.setAttribute('role', 'img');
  svg.setAttribute('focusable', 'false');
  svg.setAttribute('aria-label', ariaLabel);

  /*
   * 白底 rect 是冗余的（.qrbox 自己就是白底），但留着 —— 截图或复制这块 SVG 时
   * 背景跟着走，不会被贴到深色底上。
   */
  const background = document.createElementNS(ns, 'rect');
  background.setAttribute('width', String(size));
  background.setAttribute('height', String(size));
  background.setAttribute('fill', '#fff');

  /*
   * 同色横向连续段合成一条 path（画法与设计稿里那张占位图一致）：
   * 41 模块的码有 1681 格，逐格建节点就是 1681 个 DOM 元素，合成横条后只剩
   * 百来条命令。用 DOM API 而不是拼 innerHTML —— spec 里「不把未清理的内容
   * 塞进 innerHTML」这条不留例外。
   */
  let d = '';
  for (let y = 0; y < size; y += 1) {
    const row = data[y];
    if (row === undefined) continue;
    let x = 0;
    while (x < size) {
      if (row[x] !== true) {
        x += 1;
        continue;
      }
      let run = 1;
      while (row[x + run] === true) run += 1;
      d += `M${x} ${y}h${run}v1h-${run}z`;
      x += run;
    }
  }

  const modules = document.createElementNS(ns, 'path');
  modules.setAttribute('fill', MODULE_COLOR);
  modules.setAttribute('d', d);

  svg.append(background, modules);
  host.replaceChildren(svg);
  return svg;
}
