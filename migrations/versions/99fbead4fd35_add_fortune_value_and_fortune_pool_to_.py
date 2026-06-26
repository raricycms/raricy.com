"""add fortune_value and fortune_pool to daily_checkins, total_fortune to users

Revision ID: 99fbead4fd35
Revises: cb7f4bb976a5
Create Date: 2026-06-26 21:59:07.182131

"""
import random
from alembic import op
import sqlalchemy as sa
from sqlalchemy.sql import text


# revision identifiers, used by Alembic.
revision = '99fbead4fd35'
down_revision = 'cb7f4bb976a5'
branch_labels = None
depends_on = None


def _shuffled_pool():
    """Generate a random shuffle of 1-5 as comma-separated string."""
    nums = [1, 2, 3, 4, 5]
    random.shuffle(nums)
    return ','.join(map(str, nums))


def upgrade():
    # 1. Add columns
    with op.batch_alter_table('daily_checkins', schema=None) as batch_op:
        batch_op.add_column(sa.Column('fortune_value', sa.Integer(), nullable=True))
        batch_op.add_column(sa.Column('fortune_pool', sa.String(length=50), nullable=True))

    with op.batch_alter_table('users', schema=None) as batch_op:
        batch_op.add_column(sa.Column('total_fortune', sa.Integer(), server_default='0', nullable=False))

    # 2. Backfill existing check-in records with random fortune values
    conn = op.get_bind()

    # Get all existing check-in IDs
    existing = conn.execute(text("SELECT id FROM daily_checkins WHERE fortune_value IS NULL")).fetchall()

    for (record_id,) in existing:
        pool = _shuffled_pool()
        fortune_val = int(pool.split(',')[0])  # pick first position as the "chosen" one
        conn.execute(
            text("UPDATE daily_checkins SET fortune_value = :fv, fortune_pool = :fp WHERE id = :id"),
            {"fv": fortune_val, "fp": pool, "id": record_id}
        )

    # 3. Compute total_fortune for existing users
    conn.execute(text("""
        UPDATE users
        SET total_fortune = COALESCE(
            (SELECT SUM(fortune_value) FROM daily_checkins
             WHERE daily_checkins.user_id = users.id),
            0
        )
    """))


def downgrade():
    with op.batch_alter_table('users', schema=None) as batch_op:
        batch_op.drop_column('total_fortune')

    with op.batch_alter_table('daily_checkins', schema=None) as batch_op:
        batch_op.drop_column('fortune_pool')
        batch_op.drop_column('fortune_value')
