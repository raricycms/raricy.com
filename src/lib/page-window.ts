// 分页页码窗口（window-of-3）：始终显示首尾页，当前页 ±window 的页码照常显示，
// 其余折叠成 …（null 表示省略号）。页面渲染时 null → `<li class="page-item disabled">…`。
//
// 【为什么单独一个文件】这段算术原先在 `admin/users/page.tsx` 与
// `AdminArticlesManager.tsx` 里各抄了一份；`/audit` 与 `/admin/logs` 也要用同一套翻页，
// 再抄就是四份。四处都要求「同一页在两处页码一模一样」，抄一份的代价不是重复代码，
// 是某天只有一处被改。它是纯算术、零依赖 —— 客户端组件（AdminArticlesManager）也能直接用。

/** 返回页码序列；`null` 表示该位置渲染成省略号。 */
export function pageWindow(page: number, pages: number, window = 3): (number | null)[] {
  const out: (number | null)[] = [];
  for (let p = 1; p <= pages; p += 1) {
    if (p === 1 || p === pages || (p >= page - window && p <= page + window)) {
      out.push(p);
    } else if (p === page - window - 1 || p === page + window + 1) {
      out.push(null);
    }
  }
  return out;
}
