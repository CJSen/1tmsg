/**
 * 页脚：内置的用途告知 + 可选的举报入口。
 *
 * **告知文案是内置的**（字典键 foot.notice / foot.reportHint），不是部署配置 ——
 * 它是站点的固定组成部分，所以每个部署自动具备、跟着界面语言走。
 * 部署者只需要配一个值：vars.ABUSE_CONTACT（构建期注入 src/legal.ts）。
 *
 * 两点设计取向：
 *   1. **没有举报入口时不显示 reportHint**。「…发送到下方方式举报」在没配联系方式时
 *      会让用户去找一个不存在的东西，比不写更糟。所以两句话拆成两个键，按需显示。
 *   2. 举报链接节点由运行期创建，且**只在 ABUSE_CONTACT 非空时才存在** ——
 *      个人联系方式不写进入库的 public/*.html（那会导致 git pull 冲突，
 *      也正是本项目要求「个人配置只留在 wrangler.<自定义>.jsonc」的那条规矩）。
 *
 * 文案一律走 textContent，绝不 innerHTML —— 与 spec「永不把未清理的内容塞进 innerHTML」
 * 的硬规则一致（联系方式是部署者提供的字符串）。
 */
import { onLocaleChange, t } from '../i18n';
import { ABUSE_HREF } from '../legal';

/** 挂在 document.body 末尾（两个页面各只有一个页脚，与哪一屏可见无关） */
export function mountFooter(): void {
  const foot = document.createElement('footer');
  foot.className = 'foot';

  const note = document.createElement('p');
  note.className = 'fnote';
  foot.append(note);

  /* 举报入口：没配联系方式时整段不存在（含那句「下方方式」） */
  let hint: HTMLSpanElement | null = null;
  let link: HTMLAnchorElement | null = null;

  if (ABUSE_HREF) {
    const row = document.createElement('p');
    row.className = 'freport';

    hint = document.createElement('span');
    hint.className = 'fhint';
    row.append(hint);

    link = document.createElement('a');
    link.className = 'flink';
    link.href = ABUSE_HREF;
    /* 邮箱是同窗口打开邮件客户端，网址才需要新标签页 */
    if (!ABUSE_HREF.startsWith('mailto:')) {
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
    }
    row.append(link);

    foot.append(row);
  }

  /* 三个文案都跟着语言走，所以重绘放在一处，不要各写一遍 */
  const paint = () => {
    note.textContent = t('foot.notice');
    if (hint) hint.textContent = t('foot.reportHint');
    if (link) link.textContent = t('foot.report');
  };
  paint();
  onLocaleChange(paint);

  document.body.append(foot);
}
