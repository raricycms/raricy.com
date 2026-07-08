"""Timezone helpers — UTC+8 (China Standard Time) used by the blog.

The blog system treats UTC+8 as the canonical day boundary for check-ins,
fortune, and other daily-resetting features. Ledger entry `created_at` is
stored as naive UTC (via `datetime.utcnow()`), so to translate a "UTC+8
calendar day" into the corresponding UTC window we need to compute:

    utc8_day_start(naive_date) = naive_utc(00:00 UTC+8) - 8h
    utc8_day_end(naive_date)   = naive_utc(23:59:59 UTC+8) - 8h

We expose these as naive UTC datetimes for direct comparison with
`LedgerEntry.created_at`.

Reference: app/service/checkin.py uses `datetime.utcnow() + timedelta(hours=8)`
to compute "today" in UTC+8 — this module centralizes that arithmetic.
"""
from datetime import datetime, timedelta

# UTC+8 offset — Beijing time (CST). Fixed offset (no DST in China).
UTC8_OFFSET = timedelta(hours=8)


def utc8_day_bounds(today: datetime | None = None) -> tuple[datetime, datetime]:
    """Return (start, end) naive UTC datetimes covering the UTC+8 day.

    The bounds are inclusive on both ends. `end` is set to 23:59:59.999999
    so any datetime later in the same UTC+8 day is captured.

    Args:
        today: Override "today" — must be a naive datetime interpreted as
            UTC+8. If None, uses the current UTC+8 date.

    Returns:
        (start_utc, end_utc) — both naive datetimes in UTC, suitable for
        comparison with `LedgerEntry.created_at` (also naive UTC).
    """
    if today is None:
        now_utc8 = datetime.utcnow() + UTC8_OFFSET
        today = datetime(now_utc8.year, now_utc8.month, now_utc8.day)
    elif today.tzinfo is not None:
        raise ValueError("today must be a naive datetime (no tzinfo)")

    # `today` is treated as UTC+8 midnight. Convert to UTC by subtracting offset.
    start_utc = today - UTC8_OFFSET
    end_utc = start_utc + timedelta(days=1) - timedelta(microseconds=1)
    return start_utc, end_utc