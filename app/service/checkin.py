from datetime import datetime, timedelta
from app.extensions import db
from app.models.checkin import DailyCheckIn
from app.models.user import User
from sqlalchemy import func
from sqlalchemy.exc import IntegrityError


def _today_utc8():
    """Return today's date in UTC+8 timezone."""
    return (datetime.utcnow() + timedelta(hours=8)).date()


def check_in(user_id):
    """
    Perform a daily check-in for the given user.
    Returns a dict with success, message, and total_count.

    Uses a unique constraint on (user_id, checkin_date) to prevent
    duplicates — if two requests race, the second will hit the constraint
    and we catch IntegrityError to return a friendly message.
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
        }

    # Insert — if a concurrent request beats us, the unique constraint saves us
    try:
        record = DailyCheckIn(user_id=user_id, checkin_date=today)
        db.session.add(record)
        db.session.commit()
    except IntegrityError:
        db.session.rollback()
        total = DailyCheckIn.query.filter_by(user_id=user_id).count()
        return {
            'success': False,
            'message': '今天已经签到了，明天再来吧！',
            'already_checked': True,
            'total_count': total,
        }

    total = DailyCheckIn.query.filter_by(user_id=user_id).count()

    return {
        'success': True,
        'message': '签到成功！',
        'already_checked': False,
        'total_count': total,
    }


def get_today_status(user_id):
    """
    Get today's check-in status for the given user.
    Returns a dict with checked_in, total_count, and today.
    """
    today = _today_utc8()

    checked_in = DailyCheckIn.query.filter_by(
        user_id=user_id, checkin_date=today
    ).first() is not None

    total = DailyCheckIn.query.filter_by(user_id=user_id).count()

    return {
        'checked_in': checked_in,
        'total_count': total,
        'today': today.isoformat(),
    }


def get_user_count(user_id):
    """Return the total check-in count for the given user."""
    return DailyCheckIn.query.filter_by(user_id=user_id).count()


def get_leaderboard(limit=50):
    """
    Return the check-in leaderboard as a list of dicts.
    Each dict: {rank, user_id, username, avatar_path, count}
    """
    # Aggregate check-in counts grouped by user, ordered by count desc
    rows = (
        db.session.query(
            DailyCheckIn.user_id,
            func.count(DailyCheckIn.id).label('count')
        )
        .group_by(DailyCheckIn.user_id)
        .order_by(func.count(DailyCheckIn.id).desc())
        .limit(limit)
        .all()
    )

    if not rows:
        return []

    # Batch-fetch user info to avoid N+1
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
