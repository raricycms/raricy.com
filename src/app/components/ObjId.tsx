// 审计日志里的「对象 id」小控件：默认显示截短形式（前 8 位 … 后 4 位），
// 点开 <details> 看全量、且全量那段 `user-select: all` 一键全选。
//
// 公示页与 /admin/logs 共用一份 —— 抄两份的代价是某天只有一边跟着改。
// 样式（.obj-id）在 src/styles-scss/pages/_audit-logs.scss，那个文件已被 main.scss 注册。

function shortOid(oid: string): string {
  return oid.length > 16 ? `${oid.slice(0, 8)}…${oid.slice(-4)}` : oid;
}

export default function ObjId({ oid }: { oid: string | null | undefined }) {
  if (!oid) return null;
  return (
    <span className="obj-id">
      <details>
        <summary>{shortOid(oid)}</summary>
        <code>{oid}</code>
      </details>
    </span>
  );
}
