import random
from datetime import datetime, timedelta
from app.extensions import db
from app.models.checkin import DailyCheckIn
from app.models.user import User
from sqlalchemy import func
from sqlalchemy.exc import IntegrityError


def _today_utc8():
    """Return today's date in UTC+8 timezone."""
    return (datetime.utcnow() + timedelta(hours=8)).date()


def _shuffled_pool():
    """Return a shuffled comma-separated string of 1-5, e.g. '3,1,5,2,4'."""
    nums = [1, 2, 3, 4, 5]
    random.shuffle(nums)
    return ','.join(map(str, nums))


def check_in(user_id):
    """
    Perform a daily check-in for the given user.
    Creates a record with a shuffled fortune pool but does NOT assign
    fortune_value yet — the user must pick a card via claim_fortune().

    Returns a dict with success, message, total_count, and show_fortune.
    """
    today = _today_utc8()

    # Fast path: check if already checked in today
    existing = DailyCheckIn.query.filter_by(
        user_id=user_id, checkin_date=today
    ).first()

    if existing:
        total = DailyCheckIn.query.filter_by(user_id=user_id).count()
        return {
            'success': False,
            'message': '今天已经签到了，明天再来吧！',
            'already_checked': True,
            'total_count': total,
            'fortune_value': existing.fortune_value,
            'fortune_pending': existing.fortune_value is None,
            'show_fortune': False,
        }

    # Insert — generate fortune pool but leave fortune_value as None
    try:
        record = DailyCheckIn(
            user_id=user_id,
            checkin_date=today,
            fortune_value=None,
            fortune_pool=_shuffled_pool(),
        )
        db.session.add(record)
        db.session.commit()
    except IntegrityError:
        db.session.rollback()
        existing = DailyCheckIn.query.filter_by(
            user_id=user_id, checkin_date=today
        ).first()
        total = DailyCheckIn.query.filter_by(user_id=user_id).count()
        return {
            'success': False,
            'message': '今天已经签到了，明天再来吧！',
            'already_checked': True,
            'total_count': total,
            'fortune_value': existing.fortune_value if existing else None,
            'fortune_pending': existing is not None and existing.fortune_value is None,
            'show_fortune': False,
        }

    total = DailyCheckIn.query.filter_by(user_id=user_id).count()

    return {
        'success': True,
        'message': '签到成功！',
        'already_checked': False,
        'total_count': total,
        'fortune_value': None,
        'fortune_pending': True,
        'show_fortune': True,
    }


def claim_fortune(user_id, chosen_index):
    """
    User picks a card (0-4) after check-in. Server looks up the fortune_value
    from the shuffled fortune_pool, assigns it to the record, and increments
    the user's total_fortune.

    Uses an atomic UPDATE to prevent race conditions (TOCTOU) —
    only the first concurrent request wins; subsequent requests see
    the already-claimed value.

    Returns dict with success, fortune_value, pool, total_fortune.
    """
    today = _today_utc8()

    # Read the record to get fortune_pool (read-only — the UPDATE below is atomic)
    record = DailyCheckIn.query.filter_by(
        user_id=user_id, checkin_date=today
    ).first()

    if not record:
        return {'success': False, 'message': '今天还没有签到'}

    # Already claimed — idempotent return (fast path)
    if record.fortune_value is not None:
        pool = _parse_pool(record.fortune_pool)
        user = User.query.get(user_id)
        return {
            'success': True,
            'fortune_value': record.fortune_value,
            'pool': pool,
            'total_fortune': user.total_fortune if user else 0,
            'dried_fish': user.dried_fish if user else 0,
            'already_claimed': True,
        }

    # Parse fortune_pool and validate chosen_index
    pool = _parse_pool(record.fortune_pool)
    if pool is None:
        return {'success': False, 'message': '运势池数据异常'}
    if chosen_index < 0 or chosen_index >= len(pool):
        return {'success': False, 'message': '无效的选择'}

    fortune_val = pool[chosen_index]

    # Atomic UPDATE: only set fortune_value if it's still NULL.
    # Uses the table's update() to bypass the ORM session and avoid TOCTOU.
    stmt = (
        DailyCheckIn.__table__.update()
        .where(DailyCheckIn.user_id == user_id)
        .where(DailyCheckIn.checkin_date == today)
        .where(DailyCheckIn.fortune_value.is_(None))
        .values(fortune_value=fortune_val)
    )
    result = db.session.execute(stmt)

    if result.rowcount == 0:
        # Another request already claimed it — re-read and return
        db.session.expire(record)
        record = DailyCheckIn.query.filter_by(
            user_id=user_id, checkin_date=today
        ).first()
        pool = _parse_pool(record.fortune_pool) if record else []
        user = User.query.get(user_id)
        return {
            'success': True,
            'fortune_value': record.fortune_value if record else None,
            'pool': pool,
            'total_fortune': user.total_fortune if user else 0,
            'dried_fish': user.dried_fish if user else 0,
            'already_claimed': True,
        }

    # Atomic increment of total_fortune (avoids read-modify-write race)
    db.session.execute(
        User.__table__.update()
        .where(User.id == user_id)
        .values(total_fortune=User.total_fortune + fortune_val)
    )

    # Atomic increment of dried_fish (same value — avoids read-modify-write race)
    db.session.execute(
        User.__table__.update()
        .where(User.id == user_id)
        .values(dried_fish=User.dried_fish + fortune_val)
    )
    db.session.commit()

    # Re-read user for the response
    user = User.query.get(user_id)

    return {
        'success': True,
        'fortune_value': fortune_val,
        'pool': pool,
        'total_fortune': user.total_fortune if user else 0,
        'dried_fish': user.dried_fish if user else 0,
        'already_claimed': False,
    }


def _parse_pool(fortune_pool):
    """Parse fortune_pool string into a list of ints. Returns None on malformed data."""
    if not fortune_pool:
        return None
    try:
        vals = [int(x) for x in fortune_pool.split(',')]
        if len(vals) != 5:
            return None
        return vals
    except (ValueError, TypeError):
        return None


def get_today_status(user_id):
    """
    Get today's check-in status for the given user.
    Returns a dict with checked_in, total_count, today, fortune_value,
    total_fortune, and fortune_pending.
    """
    today = _today_utc8()

    record = DailyCheckIn.query.filter_by(
        user_id=user_id, checkin_date=today
    ).first()

    total = DailyCheckIn.query.filter_by(user_id=user_id).count()
    user = User.query.get(user_id)

    checked_in = record is not None
    fortune_pending = checked_in and record.fortune_value is None

    return {
        'checked_in': checked_in,
        'total_count': total,
        'today': today.isoformat(),
        'fortune_value': record.fortune_value if record else None,
        'total_fortune': user.total_fortune if user else 0,
        'dried_fish': user.dried_fish if user else 0,
        'fortune_pending': fortune_pending,
    }


def get_user_count(user_id):
    """Return the total check-in count for the given user."""
    return DailyCheckIn.query.filter_by(user_id=user_id).count()


def get_leaderboard(limit=50):
    """
    Return the check-in count leaderboard as a list of dicts.
    Each dict: {rank, user_id, username, avatar_path, count}
    """
    rows = (
        db.session.query(
            DailyCheckIn.user_id,
            func.count(DailyCheckIn.id).label('count'),
            func.max(DailyCheckIn.checkin_date).label('last_checkin')
        )
        .group_by(DailyCheckIn.user_id)
        .order_by(func.count(DailyCheckIn.id).desc(), func.max(DailyCheckIn.created_at).asc())
        .limit(limit)
        .all()
    )

    if not rows:
        return []

    user_ids = [row.user_id for row in rows]
    users = User.query.filter(User.id.in_(user_ids)).all()
    user_map = {u.id: u for u in users}

    leaderboard = []
    for rank, row in enumerate(rows, start=1):
        user = user_map.get(row.user_id)
        if user is None:
            continue
        leaderboard.append({
            'rank': rank,
            'user_id': user.id,
            'username': user.username,
            'avatar_path': user.avatar_path,
            'count': row.count,
        })

    return leaderboard


def get_fortune_leaderboard(limit=50):
    """
    Return the fortune leaderboard sorted by total_fortune desc.
    Each dict: {rank, user_id, username, avatar_path, total_fortune}
    """
    users = (
        User.query
        .filter(User.total_fortune > 0)
        .order_by(User.total_fortune.desc())
        .limit(limit)
        .all()
    )

    if not users:
        return []

    leaderboard = []
    for rank, user in enumerate(users, start=1):
        leaderboard.append({
            'rank': rank,
            'user_id': user.id,
            'username': user.username,
            'avatar_path': user.avatar_path,
            'total_fortune': user.total_fortune,
        })

    return leaderboard
