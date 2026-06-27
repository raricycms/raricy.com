"""小鱼干服务层 — 与 Flask 解耦，所有函数接受显式 user_id 参数。

外部项目可直接 import 使用：
    from app.service.fish import get_balance, add_fish, deduct_fish, get_transactions
"""
from app.extensions import db
from app.models.user import User
from app.models.fish import FishTransaction


# ── 查询 ──────────────────────────────────────────────

def get_balance(user_id):
    """查询单个用户的小鱼干余额。返回 int，用户不存在返回 0。"""
    user = User.query.get(user_id)
    return user.dried_fish if user else 0


def get_balance_batch(user_ids):
    """批量查询余额，返回 {user_id: balance}。

    对不存在的 user_id，对应值为 0。
    最大支持 500 个 ID，超出截断。
    """
    if not user_ids:
        return {}
    ids = list(user_ids)[:500]
    users = User.query.filter(User.id.in_(ids)).all()
    result = {uid: 0 for uid in ids}
    for u in users:
        result[u.id] = u.dried_fish
    return result


def get_transactions(user_id, page=1, per_page=20, type=None):
    """分页查询用户交易流水。返回格式和通知服务一致。

    返回 dict:
        {transactions, total, page, per_page, pages, has_prev, has_next, prev_num, next_num}
    """
    query = FishTransaction.query.filter_by(user_id=user_id)
    if type:
        query = query.filter_by(type=type)
    query = query.order_by(FishTransaction.created_at.desc())
    pagination = query.paginate(page=page, per_page=per_page, error_out=False)
    return {
        'transactions': [t.to_dict() for t in pagination.items],
        'total': pagination.total,
        'page': page,
        'per_page': per_page,
        'pages': pagination.pages,
        'has_prev': pagination.has_prev,
        'has_next': pagination.has_next,
        'prev_num': pagination.prev_num,
        'next_num': pagination.next_num,
    }


def get_balance_leaderboard(limit=50):
    """小鱼干排行榜（公开）。返回 [{rank, user_id, username, avatar_path, balance}]。"""
    users = (
        User.query
        .filter(User.dried_fish > 0)
        .order_by(User.dried_fish.desc())
        .limit(limit)
        .all()
    )
    return [
        {
            'rank': i + 1,
            'user_id': u.id,
            'username': u.username,
            'avatar_path': u.avatar_path,
            'balance': u.dried_fish,
        }
        for i, u in enumerate(users)
    ]


def get_today_checkin_fish(user_id):
    """查询今日签到获得的小鱼干数量。未签到返回 0。"""
    from app.service.checkin import _today_utc8
    today = _today_utc8()
    tx = FishTransaction.query.filter_by(
        user_id=user_id,
        type='checkin',
    ).filter(
        db.func.date(FishTransaction.created_at) == today.isoformat()
    ).first()
    return tx.amount if tx else 0


# ── 核心操作 ──────────────────────────────────────────

def add_fish(user_id, amount, type, description=None,
             reference_type=None, reference_id=None,
             related_user_id=None, auto_commit=True):
    """增加小鱼干 + 写流水。返回新的余额。

    Args:
        user_id: 用户ID
        amount: 数量（正整数）
        type: 类型标识 (checkin / admin_grant / purchase / refund / transfer / tip_receive)
        description: 人类可读描述
        reference_type: 关联对象类型
        reference_id: 关联对象ID
        related_user_id: 对手方用户ID（转账/打赏等场景）
        auto_commit: 是否自动提交（默认 True；调用方可设 False 统一提交）

    Returns:
        新余额 (int)

    Raises:
        ValueError: 用户不存在
    """
    if amount <= 0:
        raise ValueError('amount 必须为正整数')

    # 原子 UPDATE
    result = db.session.execute(
        User.__table__.update()
        .where(User.id == user_id)
        .values(dried_fish=User.dried_fish + amount)
    )
    if result.rowcount == 0:
        raise ValueError('用户不存在')

    # 写流水
    tx = FishTransaction(
        user_id=user_id,
        amount=amount,
        type=type,
        description=description,
        reference_type=reference_type,
        reference_id=reference_id,
        related_user_id=related_user_id,
    )
    db.session.add(tx)

    if auto_commit:
        db.session.commit()

    # 重新读取余额（expire 确保绕过 identity map，读到 ROW UPDATE 后的最新值）
    db.session.expire_all()
    user = User.query.get(user_id)
    return user.dried_fish if user else 0


def deduct_fish(user_id, amount, type, description=None,
                reference_type=None, reference_id=None,
                related_user_id=None, auto_commit=True):
    """扣减小鱼干 + 写流水。使用原子操作防并发超扣。

    Args:
        user_id: 用户ID
        amount: 数量（正整数，实际写入流水为负数）
        type: 类型标识 (purchase / transfer / tip / ...)
        description: 人类可读描述
        reference_type: 关联对象类型
        reference_id: 关联对象ID
        related_user_id: 对手方用户ID（转账/打赏等场景）
        auto_commit: 是否自动提交（默认 True）

    Returns:
        新余额 (int)

    Raises:
        ValueError: 用户不存在 或 余额不足
    """
    if amount <= 0:
        raise ValueError('amount 必须为正整数')

    # 原子 UPDATE：WHERE dried_fish >= amount 防止超扣
    result = db.session.execute(
        User.__table__.update()
        .where(User.id == user_id)
        .where(User.dried_fish >= amount)
        .values(dried_fish=User.dried_fish - amount)
    )

    if result.rowcount == 0:
        # 区分：用户不存在 vs 余额不足
        user = User.query.get(user_id)
        if not user:
            raise ValueError('用户不存在')
        raise ValueError('小鱼干不足')

    # 写流水（amount 为负数表示支出）
    tx = FishTransaction(
        user_id=user_id,
        amount=-amount,
        type=type,
        description=description,
        reference_type=reference_type,
        reference_id=reference_id,
        related_user_id=related_user_id,
    )
    db.session.add(tx)

    if auto_commit:
        db.session.commit()

    db.session.expire_all()
    user = User.query.get(user_id)
    return user.dried_fish if user else 0
