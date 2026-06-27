"""add dried_fish to users

Revision ID: 6cdfe7d6d546
Revises: 99fbead4fd35
Create Date: 2026-06-27 15:41:50.325096

"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.sql import text


# revision identifiers, used by Alembic.
revision = '6cdfe7d6d546'
down_revision = '99fbead4fd35'
branch_labels = None
depends_on = None


def upgrade():
    with op.batch_alter_table('users', schema=None) as batch_op:
        batch_op.add_column(sa.Column('dried_fish', sa.Integer(), server_default='0', nullable=False))

    # 已有运势分 1:1 折成小鱼干
    conn = op.get_bind()
    conn.execute(text("UPDATE users SET dried_fish = total_fortune WHERE total_fortune > 0"))


def downgrade():
    with op.batch_alter_table('users', schema=None) as batch_op:
        batch_op.drop_column('dried_fish')
