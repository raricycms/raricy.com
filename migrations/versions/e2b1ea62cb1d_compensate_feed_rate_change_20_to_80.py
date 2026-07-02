"""compensate feed rate change 20 to 80

Revision ID: e2b1ea62cb1d
Revises: c3a4f587e97a
Create Date: 2026-07-02 21:58:30.719599

"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.sql import text
from datetime import datetime


# revision identifiers, used by Alembic.
revision = 'e2b1ea62cb1d'
down_revision = 'c3a4f587e97a'
branch_labels = None
depends_on = None


def upgrade():
    conn = op.get_bind()

    # 按文章聚合总投喂量，计算作者补偿
    # compensation = total_fed * 0.6（新税率80% - 旧税率20%）
    rows = conn.execute(text("""
        SELECT b.id AS blog_id,
               b.author_id,
               COALESCE(SUM(bf.amount), 0) AS total_fed
        FROM blog_feeds bf
        JOIN blogs b ON b.id = bf.blog_id
        GROUP BY b.id, b.author_id
        HAVING total_fed > 0
    """)).fetchall()

    if not rows:
        print("No BlogFeed records found -- nothing to compensate.")
        return

    total_compensated = 0
    total_authors = 0

    for blog_id, author_id, total_fed in rows:
        compensation = round(total_fed * 0.6, 1)
        if compensation <= 0:
            continue

        # 1. 原子增加作者余额
        conn.execute(
            text("UPDATE users SET dried_fish = dried_fish + :comp WHERE id = :uid"),
            {"comp": compensation, "uid": author_id},
        )

        # 2. 创建审计交易记录
        conn.execute(
            text("""
                INSERT INTO fish_transactions
                    (user_id, amount, type, description,
                     reference_type, reference_id, related_user_id, created_at)
                VALUES
                    (:uid, :amount, :type, :desc,
                     :ref_type, :ref_id, NULL, :created_at)
            """),
            {
                "uid": author_id,
                "amount": compensation,
                "type": "feed_backpay",
                "desc": f"税率补偿：投喂税率由20%调整为80%，文章共收到{total_fed}条小鱼干投喂",
                "ref_type": "blog",
                "ref_id": blog_id,
                "created_at": datetime.utcnow(),
            },
        )

        total_compensated += compensation
        total_authors += 1

    print(
        f"Compensated {total_authors} authors "
        f"with {total_compensated:.1f} dried_fish in total."
    )


def downgrade():
    """回滚补偿（作者已花掉补偿可能导致负余额，此为预期行为）。"""
    conn = op.get_bind()

    rows = conn.execute(
        text("""
            SELECT id, user_id, amount
            FROM fish_transactions
            WHERE type = 'feed_backpay'
        """)
    ).fetchall()

    if not rows:
        print("No feed_backpay records found -- nothing to revert.")
        return

    for row_id, user_id, amount in rows:
        conn.execute(
            text("UPDATE users SET dried_fish = dried_fish - :amount WHERE id = :uid"),
            {"amount": amount, "uid": user_id},
        )

    conn.execute(text("DELETE FROM fish_transactions WHERE type = 'feed_backpay'"))

    print(f"Reverted {len(rows)} compensation records.")
