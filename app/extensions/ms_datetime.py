"""
ms_datetime.py —— 让 Flask/SQLAlchemy 以 **Unix 毫秒整数** 读写 DATETIME 列。

【为什么需要】
迁移到 Next.js 后，Prisma 往 SQLite 写 DateTime 用的是 INTEGER（Unix 毫秒），
而 SQLAlchemy 默认写的是 "2026-07-16 10:00:00.123456" 文本。同一列两种存储格式：
  · Prisma 读到 SQLAlchemy 的文本 → 直接抛 Conversion failed（登录 500）
  · SQLAlchemy 读到 Prisma 的整数 → 解析失败
因此 scripts/normalize-datetimes.mjs 会把全库时间戳统一成 INTEGER 毫秒 ——
**规整之后 Flask 就读不了这个库了**。

本模块就是补这一刀：装上它，Flask 也按 INTEGER 毫秒读写，于是新旧两套栈
可以共读同一个库 —— 这是「可回滚灰度」（切换路线 B）的前提。
若走硬切换（停 Flask → 规整 → 起 Next，不再回头），则不需要本模块。

【时区语义】
本库的既有约定是「naive UTC+8 墙上时间」：Flask 原本就用 datetime.now() 写服务器
本地时间，而生产服务器 TZ=UTC+8（该结论由真实数据反推证实：daily_checkins 里
显式按 UTC+8 计算的 checkin_date 与 date(created_at) 2170/2170 全等；若服务器为 UTC，
UTC 16:00–23:59 的 548 条签到必然跨日不等）。
normalize-datetimes 转换时**不做时区平移**，故墙上时间被原样保留。
本模块同样按 naive 值直接换算，不做 tz 转换 —— 三方（Flask / 脚本 / Prisma）口径一致。

【安装】在 app/__init__.py 的 create_app() 里、注册蓝图之前调用：

    from app.extensions.ms_datetime import install_ms_datetime
    install_ms_datetime()

它用 SQLAlchemy 的方言级类型适配全局生效，**不需要改 13 个模型文件里的 33 处
db.Column(db.DateTime)** —— 那样改动面太大、容易漏。

【验证】装好后跑一次双向验证：
    Flask 写一条 → Next 读得到；Next 写一条 → Flask 读得到。
    再 `npm run diagnose` 确认 typeof(created_at) 全库为 integer、无混存。
"""

import datetime as dt

from sqlalchemy import DateTime, Date
from sqlalchemy.dialects.sqlite import dialect as sqlite_dialect
from sqlalchemy.types import TypeDecorator, BigInteger

_EPOCH = dt.datetime(1970, 1, 1)


def _to_ms(value):
    """naive datetime → Unix 毫秒（按墙上时间直接换算，不做 tz 转换）。"""
    if value is None:
        return None
    if isinstance(value, dt.datetime):
        dt_val = value
    elif isinstance(value, dt.date):
        # DATE 列（如 daily_checkins.checkin_date）：当天零点
        dt_val = dt.datetime(value.year, value.month, value.day)
    else:
        return value  # 已是数字/其它，交给驱动
    if dt_val.tzinfo is not None:
        # 带时区的值：先转成 UTC+8 墙上时间，再取 naive
        dt_val = dt_val.astimezone(dt.timezone(dt.timedelta(hours=8))).replace(tzinfo=None)
    return int((dt_val - _EPOCH).total_seconds() * 1000)


def _from_ms(value):
    """Unix 毫秒 → naive datetime。也兼容历史遗留的文本值（规整前的老库）。"""
    if value is None:
        return None
    if isinstance(value, (int, float)):
        return _EPOCH + dt.timedelta(milliseconds=int(value))
    if isinstance(value, dt.datetime):
        return value
    # 文本兜底：既吃 SQLAlchemy 的空格格式，也吃 ISO —— 让本模块在
    # 「尚未规整的库」上也不炸（便于灰度期分批切换）。
    s = str(value)
    for fmt in ('%Y-%m-%d %H:%M:%S.%f', '%Y-%m-%d %H:%M:%S',
                '%Y-%m-%dT%H:%M:%S.%fZ', '%Y-%m-%dT%H:%M:%SZ',
                '%Y-%m-%dT%H:%M:%S.%f', '%Y-%m-%dT%H:%M:%S',
                '%Y-%m-%d'):
        try:
            return dt.datetime.strptime(s, fmt)
        except ValueError:
            continue
    raise ValueError(f'无法解析的时间值: {value!r}')


class MsDateTime(TypeDecorator):
    """以 Unix 毫秒整数存取 datetime。"""

    impl = BigInteger
    cache_ok = True

    def process_bind_param(self, value, dialect):
        return _to_ms(value)

    def process_result_value(self, value, dialect):
        return _from_ms(value)


class MsDate(TypeDecorator):
    """DATE 列（存当天零点的毫秒值，与 Prisma 对 checkin_date 的处理一致）。"""

    impl = BigInteger
    cache_ok = True

    def process_bind_param(self, value, dialect):
        return _to_ms(value)

    def process_result_value(self, value, dialect):
        v = _from_ms(value)
        return v.date() if isinstance(v, dt.datetime) else v


def install_ms_datetime():
    """
    全局生效：让 SQLite 方言把 DateTime/Date 列按毫秒整数处理。

    用 colspecs 而非逐个模型改字段 —— 一处生效、不会漏，
    且回退时只需不调用本函数。
    """
    sqlite_dialect.colspecs = dict(sqlite_dialect.colspecs or {})
    sqlite_dialect.colspecs[DateTime] = MsDateTime
    sqlite_dialect.colspecs[Date] = MsDate
