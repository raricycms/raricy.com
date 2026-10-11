import { isoWithOffset, nowForDb } from '@/lib/db-time';
import { ymd, ymdhms } from '@/lib/format';

interface Props {
  createdAt: Date | string | null | undefined;
  updatedAt: Date | string | null | undefined;
  detail?: boolean;
  sort?: 'created' | 'updated';
}

function asDate(value: Props['createdAt']): Date | null {
  if (!value) return null;
  const date = typeof value === 'string' ? new Date(value) : value;
  return Number.isNaN(date.getTime()) ? null : date;
}

/** 服务端页面与个人主页的客户端列表共用；传入的字符串仍是库内墙上时间。 */
export default function BlogTimestamps({ createdAt, updatedAt, detail = false, sort = 'created' }: Props) {
  const published = asDate(createdAt);
  const modified = asDate(updatedAt);
  // 新建时两个时间相等，只显示发布；历史更新早于发布的异常值也不冒充后续编辑。
  const showModified = modified && (!published || modified.getTime() > published.getTime());
  if (!published && !showModified) return null;

  const updateFirst = !published || (!detail && sort === 'updated' && showModified);
  const primary = updateFirst ? modified! : published!;

  if (!detail) {
    // 库内日期与「今年」都按本站墙上时间读，避免 UTC 跨年时多出/丢掉年份。
    const year = primary.getUTCFullYear();
    const label = `${year === nowForDb().getUTCFullYear() ? '' : `${year}年`}${primary.getUTCMonth() + 1}月${primary.getUTCDate()}日`;
    const tooltip = [
      published && `发布时间：${ymdhms(published)}`,
      showModified && `更新时间：${ymdhms(modified)}`,
      '北京时间',
    ].filter(Boolean).join('\n');

    return (
      <div className="blog-timestamps" aria-label="文章时间">
        <span className="blog-timestamps__item">
          <time
            dateTime={isoWithOffset(primary) ?? undefined}
            title={tooltip}
            aria-label={`${updateFirst ? '更新' : '发布'}于${ymdhms(primary)}（北京时间）`}
          >
            {label}
          </time>
        </span>
      </div>
    );
  }

  const secondary = showModified && published ? (updateFirst ? published : modified) : null;
  // 同日的两份日期没有辨识价值；编辑事实保留，完整时间仍在提示/详情里。
  const sameDay = secondary && ymd(primary) === ymd(secondary);
  const renderTime = (date: Date, full = false) => (
    <time
      dateTime={isoWithOffset(date) ?? undefined}
      title={`${date === published ? '发布时间' : '更新时间'}：${ymdhms(date)}（北京时间）`}
    >
      {full ? ymdhms(date) : ymd(date)}
    </time>
  );
  const overview = (
    <>
      <span className="blog-timestamps__item blog-timestamps__item--primary">
        <span className="blog-timestamps__label">{updateFirst ? '更新于' : '发布于'}</span>
        {renderTime(primary)}
      </span>
      {secondary && (!sameDay || !updateFirst) && (
        <span
          className="blog-timestamps__item blog-timestamps__item--secondary"
          title={`${updateFirst ? '发布时间' : '更新时间'}：${ymdhms(secondary)}（北京时间）`}
        >
          {sameDay ? '已编辑' : (
            <>
              <span className="blog-timestamps__label">{updateFirst ? '发布于' : '更新于'}</span>
              {renderTime(secondary)}
            </>
          )}
        </span>
      )}
    </>
  );

  return (
    <div
      className={detail ? 'blog-timestamps blog-timestamps--detail' : 'blog-timestamps'}
      aria-label="文章时间"
    >
      {detail ? (
        <details className="blog-timestamps__details">
          <summary className="blog-timestamps__summary" title="查看完整时间（北京时间）">
            {overview}
            <span className="blog-timestamps__chevron" aria-hidden="true" />
          </summary>
          <div className="blog-timestamps__panel">
            <p className="blog-timestamps__zone">北京时间 · UTC+8</p>
            {published && (
              <span className="blog-timestamps__item">
                <span className="blog-timestamps__label">发布</span>
                {renderTime(published, true)}
              </span>
            )}
            {showModified && (
              <span className="blog-timestamps__item">
                <span className="blog-timestamps__label">更新</span>
                {renderTime(modified, true)}
              </span>
            )}
          </div>
        </details>
      ) : overview}
    </div>
  );
}
