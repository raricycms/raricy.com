// ─────────────────────────────────────────────────────────────────────────────
// blog-markdown.ts — 博客 / 剪贴板正文渲染的**安全边界**（DOMPurify 白名单 + 投票嵌入）
//
// 【为什么单独成模块】正文是用户输入，且渲染给所有读者（含 admin / owner）。
// 白名单与投票嵌入的写入方式集中在这里定义 —— 改这里等于改安全边界，
// 务必同步 tests/unit/blog-markdown.test.ts（对齐 chat-markdown.ts 的做法）。
//
// 【历史教训 · 已复现的存储型 XSS】旧实现把 data-vote-id 的属性值拼进 innerHTML：
//     el.innerHTML = `<a href="/vote/${vid}">[查看投票]</a>`
// DOMPurify 只净化 HTML 结构，拦不住我们**之后自己**拼字符串：属性值里的
// `"` 在 DOM 里是合法字符，getAttribute 原样取回，重新解析就成了可执行 HTML。
//     <div class="vote-embed" data-vote-id='x"><img src=x onerror=alert(1)>'>
// core 用户发一篇博客即可在任意读者（含 admin）会话里执行脚本。
// 修法：① 只放行短 id 形态；② 一律用 DOM API 写入，绝不拼 innerHTML。
// ─────────────────────────────────────────────────────────────────────────────

/**
 * DOMPurify 白名单。
 *
 * 为什么留 class / data-vote-id：投票嵌入的 HTML 形态就是
 * `<div class="vote-embed" data-vote-id="...">`，选择器 `.vote-embed[data-vote-id]`
 * 靠这两者定位。data-code 是代码块「复制」按钮的数据。
 *
 * ALLOW_DATA_ATTR: false —— 只放行上面显式列出的两个 data-*，任意其他 data-*
 * 一律剥掉（净化后由我们自己的后处理代码添加属性时不受影响）。
 */
export const BLOG_SANITIZE_OPTIONS = {
  ALLOWED_TAGS: [
    'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p', 'br', 'hr', 'div', 'span',
    'strong', 'b', 'em', 'i', 'u', 's', 'del', 'code', 'pre', 'blockquote',
    'ul', 'ol', 'li', 'a', 'img', 'table', 'thead', 'tbody', 'tr', 'th', 'td',
    'details', 'summary', 'sub', 'sup', 'mark', 'input', 'button',
    'video', 'source', 'track', 'audio',
  ],
  ALLOWED_ATTR: [
    'href', 'title', 'alt', 'src', 'class', 'rel', 'target', 'width', 'height',
    'align', 'colspan', 'rowspan', 'type', 'checked', 'disabled', 'data-code',
    'data-vote-id', 'controls', 'autoplay', 'muted', 'loop', 'poster', 'preload',
    'playsinline', 'crossorigin', 'kind', 'srclang', 'label',
  ],
  ALLOW_DATA_ATTR: false,
};

/**
 * 投票 id 形态：short-id.ts 生成的小写字母 + 数字（8~9 位）。
 * 这里放宽到 32 位以兼容历史数据，但**只允许字母数字** ——
 * 引号 / 尖括号 / 空白 / 斜杠一律拒绝，从源头断掉属性逃逸。
 */
const VOTE_ID_RE = /^[A-Za-z0-9]{1,32}$/;

export function isValidVoteId(vid: string | null | undefined): vid is string {
  return typeof vid === 'string' && VOTE_ID_RE.test(vid);
}

/**
 * 渲染「[查看投票]」兜底链接（投票不存在 / 请求失败时）。
 *
 * ★ 用 createElement + textContent，不用 innerHTML ★
 * vid 是不可信输入，拼进 innerHTML 等于把净化过一遍的内容又交还给解析器。
 * 即便校验被绕过，DOM API 也只会把它当**文本**写入，不会解析成标签。
 */
export function renderVoteFallback(el: HTMLElement, vid: string): void {
  el.textContent = '';
  const a = el.ownerDocument.createElement('a');
  a.className = 'vote-embed-fallback';
  a.setAttribute('href', `/vote/${vid}`);
  a.textContent = '[查看投票]';
  el.appendChild(a);
}

// ─────────────────────────────────────────────────────────────────────────────
// 投票小组件
//
// 【修的是什么】这里原先只渲染「结果行」—— 没有标题、没有投票入口、没有去详情页的
// 链接，且最外层少了 .vote-embed-widget（卡片背景/边框/内边距/宽度全挂在那个类上），
// 于是博客正文里的投票箱既投不了票、又是个没有外壳的裸条。
// 原站本来就是**可投**的：未锁定 + 本人未投票 → 渲染可选项 + 投票按钮；否则结果视图。
//
// 【写入方式】一律 createElement + textContent / setAttribute，不拼 innerHTML ——
// 理由见文件头那段存储型 XSS 的教训：属性值在 DOM 里是合法字符，拼回 HTML 会被
// 重新解析。这里 title / label 都是用户输入，走 DOM API 才不会被当成标签。
// ─────────────────────────────────────────────────────────────────────────────

export interface VoteOptionData {
  id: number;
  label: string;
  count: number;
  percentage: number;
}

export interface VoteEmbedData {
  title: string;
  is_locked: boolean;
  total_votes: number;
  user_voted: number | null;
  options: VoteOptionData[];
}

/** 可投票 = 未锁定且本人未投过。 */
function canVote(data: VoteEmbedData): boolean {
  return !data.is_locked && data.user_voted == null;
}

/** 结果行：进度条 + 「N 票 · X%」，本人投的那项加 ✓ 高亮。 */
function buildResultRow(doc: Document, o: VoteOptionData, mine: boolean): HTMLElement {
  const row = doc.createElement('div');
  row.className = `vote-embed-option vote-embed-option--result${mine ? ' vote-embed-option--voted' : ''}`;

  const bar = doc.createElement('div');
  bar.className = 'vote-embed-bar';
  bar.style.width = `${o.percentage}%`;
  row.appendChild(bar);

  const content = doc.createElement('div');
  content.className = 'vote-embed-option-content';

  const label = doc.createElement('span');
  label.className = 'vote-embed-option-label';
  label.textContent = o.label;

  const stats = doc.createElement('span');
  stats.className = 'vote-embed-option-stats';
  stats.textContent = `${o.count} 票 · ${o.percentage}%`;

  content.append(label, stats);
  row.appendChild(content);
  return row;
}

/** 可选项：无进度条，点击选中（选中态由 --selected 修饰符承担）。 */
function buildVotableOption(doc: Document, o: VoteOptionData): HTMLButtonElement {
  const btn = doc.createElement('button');
  btn.type = 'button';
  btn.className = 'vote-embed-option';
  btn.dataset.optionId = String(o.id);

  const content = doc.createElement('div');
  content.className = 'vote-embed-option-content';

  const label = doc.createElement('span');
  label.className = 'vote-embed-option-label';
  label.textContent = o.label;

  content.appendChild(label);
  btn.appendChild(content);
  return btn;
}

/**
 * 按数据渲染整个小组件（纯 DOM 构造，不发请求 —— 便于单测）。
 * voteId 必须已过 isValidVoteId：它要拼进 href。
 */
export function buildVoteWidget(el: HTMLElement, voteId: string, data: VoteEmbedData): void {
  const doc = el.ownerDocument;
  const votable = canVote(data);

  const widget = doc.createElement('div');
  widget.className = 'vote-embed-widget';

  const title = doc.createElement('div');
  title.className = 'vote-embed-title';
  title.textContent = data.title;
  widget.appendChild(title);

  if (data.is_locked) {
    const badge = doc.createElement('span');
    badge.className = 'vote-embed-badge badge-locked';
    badge.textContent = '已锁定';
    widget.appendChild(badge);
  }

  if (!votable) {
    const total = doc.createElement('p');
    total.className = 'vote-embed-total';
    total.textContent = `共 ${data.total_votes} 票`;
    widget.appendChild(total);
  }

  for (const o of data.options) {
    widget.appendChild(
      votable ? buildVotableOption(doc, o) : buildResultRow(doc, o, data.user_voted === o.id)
    );
  }

  if (votable) {
    const submit = doc.createElement('button');
    submit.type = 'button';
    submit.className = 'vote-embed-submit';
    submit.disabled = true; // 选中一项后才可点
    submit.textContent = '投票';
    widget.appendChild(submit);
  }

  // 详情页入口：新窗口打开，别把读者的阅读位置顶掉
  const link = doc.createElement('a');
  link.className = 'vote-embed-link';
  link.setAttribute('href', `/vote/${voteId}`);
  link.setAttribute('target', '_blank');
  link.setAttribute('rel', 'noopener');
  link.textContent = '查看详情';
  widget.appendChild(link);

  el.textContent = '';
  el.appendChild(widget);
}

/** 选中 + 提交（仅可投票时绑定）。投票成功后重新拉取并整体重绘。 */
function attachVoteHandlers(el: HTMLElement, voteId: string, data: VoteEmbedData): void {
  if (!canVote(data)) return;

  const options = Array.from(el.querySelectorAll<HTMLElement>('.vote-embed-option[data-option-id]'));
  const submit = el.querySelector<HTMLButtonElement>('.vote-embed-submit');
  if (!submit || options.length === 0) return;

  let selected: number | null = null;

  for (const opt of options) {
    opt.addEventListener('click', () => {
      options.forEach((o) => o.classList.remove('vote-embed-option--selected'));
      opt.classList.add('vote-embed-option--selected');
      selected = Number(opt.dataset.optionId);
      submit.disabled = false;
    });
  }

  submit.addEventListener('click', async () => {
    if (selected == null) return;
    submit.disabled = true;
    submit.textContent = '投票中……';
    try {
      const res = await fetch(`/api/votes/${voteId}/vote`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ optionId: selected }),
      });
      const result = (await res.json()) as { code?: number; message?: string };
      if (result.code === 200) {
        // 重绘 = 再拉一次服务端结果（票数与百分比以服务端为准，不做本地乐观累加）
        await renderVoteEmbed(el, voteId);
        return;
      }
      alert('投票失败：' + (result.message || '未知错误'));
      submit.textContent = '投票';
      submit.disabled = false;
    } catch {
      alert('出错了，请稍后再试');
      submit.textContent = '投票';
      submit.disabled = false;
    }
  });
}

/**
 * 博客正文里的投票嵌入入口：校验 id → 拉数据 → 渲染小组件（失败则兜底链接）。
 * id 来自用户 Markdown，**必须先过 isValidVoteId**（见文件头）。
 */
export async function renderVoteEmbed(el: HTMLElement, voteId: string | null | undefined): Promise<void> {
  if (!isValidVoteId(voteId)) {
    el.textContent = '[投票链接无效]';
    return;
  }

  el.textContent = '加载投票…';

  let data: VoteEmbedData | null = null;
  try {
    const res = await fetch(`/api/votes/${voteId}`, { credentials: 'same-origin' });
    const json = (await res.json()) as { code?: number; data?: VoteEmbedData };
    if (json.code === 200 && json.data) data = json.data;
  } catch {
    // 网络/解析失败都走兜底链接
  }

  if (!data) {
    renderVoteFallback(el, voteId);
    return;
  }

  try {
    buildVoteWidget(el, voteId, data);
    attachVoteHandlers(el, voteId, data);
  } catch {
    // 字段形态由我们自己的 API 保证，这里只是兜底：真的缺字段时宁可退成链接，
    // 也别让异常冒出去 —— 调用方是 `void renderVoteEmbed(...)`，抛了就是一条
    // 未处理的 rejection，嵌入位会永远停在「加载投票…」。
    renderVoteFallback(el, voteId);
  }
}
