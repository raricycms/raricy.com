import { isoWithOffset } from '@/lib/db-time';
import { ymd, ymdhms } from '@/lib/format';

interface Props {
  createdAt: Date | string | null | undefined;
  updatedAt: Date | string | null | undefined;
  detail?: boolean;
}

function asDate(value: Props['createdAt']): Date | null {
  if (!value) return null;
  const date = typeof value === 'string' ? new Date(value) : value;
  return Number.isNaN(date.getTime()) ? null : date;
}

/** 服务端页面与个人主页的客户端列表共用；传入的字符串仍是库内墙上时间。 */
export default function BlogTimestamps({ createdAt, updatedAt, detail = false }: Props) {
  const published = asDate(createdAt);
  const modified = asDate(updatedAt);
  // 新建时两个时间相等，只显示发布；历史更新早于发布的异常值也不冒充后续编辑。
  const showModified = modified && (!published || modified.getTime() > published.getTime());
  if (!published && !showModified) return null;

  const label = (date: Date) => (detail ? ymdhms(date)?.slice(0, 16) : ymd(date));

  return (
    <div
      className={detail ? 'blog-timestamps blog-timestamps--detail' : 'blog-timestamps'}
      aria-label="文章时间"
    >
      {published && (
        <span className="blog-timestamps__item">
          <span className="blog-timestamps__label">发布于</span>
          <time
            dateTime={isoWithOffset(published) ?? undefined}
            title={`发布时间：${ymdhms(published)}（北京时间）`}
          >
            {label(published)}
          </time>
        </span>
      )}
      {showModified && (
        <span className="blog-timestamps__item">
          <span className="blog-timestamps__label">更新于</span>
          <time
            dateTime={isoWithOffset(modified) ?? undefined}
            title={`更新时间：${ymdhms(modified)}（北京时间）`}
          >
            {label(modified)}
          </time>
        </span>
      )}
    </div>
  );
}
