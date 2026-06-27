"""文章投喂小鱼干服务"""
from app.extensions import db
from app.models.blog import Blog
from app.models.blog_feed import BlogFeed
from app.models.user import User
from app.service.fish import add_fish, deduct_fish
from app.service.notifications import send_notification


def get_feed_status(blog_id, user_id):
    """返回用户对该文章的投喂状态。"""
    feed = BlogFeed.query.filter_by(blog_id=blog_id, user_id=user_id).first()
    fed = feed.amount if feed else 0
    return {
        'fed': fed,
        'remaining': max(0, 5 - fed),
        'is_full': fed >= 5,
    }


def feed_fish(blog_id, user_id, amount):
    """
    用户投喂小鱼干给文章。作者收到 20%。

    原子操作，防并发超限。

    Returns:
        dict: {fed_total, remaining, fish_count, balance, author_income}

    Raises:
        ValueError: 博客不存在、余额不足、超过单篇上限等
    """
    if amount <= 0 or amount > 5:
        raise ValueError('投喂数量需在 1~5 之间')

    blog = Blog.query.get(blog_id)
    if not blog or blog.ignore:
        raise ValueError('文章不存在')

    # 1. 扣减投喂者小鱼干（原子操作）
    balance_after = deduct_fish(user_id, amount, 'feed',
                                f'投喂文章「{blog.title}」',
                                reference_type='blog', reference_id=blog_id,
                                related_user_id=blog.author_id,
                                auto_commit=False)

    # 2. 作者收入 20%
    author_income = round(amount * 0.2, 1)
    add_fish(blog.author_id, author_income, 'feed_receive',
             f'文章「{blog.title}」被投喂',
             reference_type='blog', reference_id=blog_id,
             related_user_id=user_id,
             auto_commit=False)

    # 3. 原子更新或创建 BlogFeed 记录
    existing = BlogFeed.query.filter_by(blog_id=blog_id, user_id=user_id).first()
    if existing:
        # 原子 UPDATE：仅当累计不超 5 时才更新
        result = db.session.execute(
            BlogFeed.__table__.update()
            .where(BlogFeed.blog_id == blog_id)
            .where(BlogFeed.user_id == user_id)
            .where(BlogFeed.amount + amount <= 5)
            .values(amount=BlogFeed.amount + amount)
        )
        if result.rowcount == 0:
            raise ValueError('投喂已满（单篇文章每人最多投喂 5 条）')
    else:
        feed = BlogFeed(blog_id=blog_id, user_id=user_id, amount=amount)
        db.session.add(feed)

    # 4. 原子更新 blog.fish_count（投喂总量）
    db.session.execute(
        Blog.__table__.update()
        .where(Blog.id == blog_id)
        .values(fish_count=Blog.fish_count + amount)
    )

    db.session.commit()

    # 通知文章作者（自投喂不通知）
    if user_id != blog.author_id:
        try:
            send_notification(
                recipient_id=blog.author_id,
                action='文章投喂',
                actor_id=user_id,
                object_type='blog',
                object_id=blog_id,
                detail=f'你的文章《{blog.title}》收到了 {amount} 条小鱼干投喂！',
            )
        except Exception:
            pass  # 通知失败不应阻断主流程

    # 重新读取最新状态
    feed = BlogFeed.query.filter_by(blog_id=blog_id, user_id=user_id).first()
    fed_total = feed.amount if feed else amount
    blog = Blog.query.get(blog_id)

    return {
        'fed_total': fed_total,
        'remaining': max(0, 5 - fed_total),
        'fish_count': blog.fish_count if blog else 0,
        'balance': balance_after,
        'author_income': author_income,
    }


def get_feeders(blog_id, offset=0, limit=50):
    """分页查询投喂者列表。"""
    total = BlogFeed.query.filter_by(blog_id=blog_id).count()
    feeds = (
        BlogFeed.query
        .filter_by(blog_id=blog_id)
        .order_by(BlogFeed.amount.desc())
        .offset(offset)
        .limit(limit)
        .all()
    )

    user_ids = [f.user_id for f in feeds]
    users = User.query.filter(User.id.in_(user_ids)).all() if user_ids else []
    user_map = {u.id: u for u in users}

    feeders = []
    for f in feeds:
        u = user_map.get(f.user_id)
        feeders.append({
            'user_id': f.user_id,
            'username': u.username if u else '未知',
            'avatar_path': u.avatar_path if u else None,
            'amount': f.amount,
        })

    return {
        'feeders': feeders,
        'total': total,
        'offset': offset,
        'limit': limit,
    }
