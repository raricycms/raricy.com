"""drop legacy boolean flags from users

Revision ID: da7e9f10c2ab
Revises: b1a2c3d4e5f6
Create Date: 2025-11-08 00:30:00.000000

"""
from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision = 'da7e9f10c2ab'
down_revision = 'b1a2c3d4e5f6'
branch_labels = None
depends_on = None


def upgrade():
    with op.batch_alter_table('users', schema=None) as batch_op:
        # 某些旧数据可能允许 NULL；安全起见先去除默认值，再删除列
        try:
            batch_op.drop_column('authenticated')
        except Exception:
            pass
        try:
            batch_op.drop_column('is_admin')
        except Exception:
            pass


def downgrade():
    with op.batch_alter_table('users', schema=None) as batch_op:
        batch_op.add_column(sa.Column('authenticated', sa.Boolean(), nullable=True))
        batch_op.add_column(sa.Column('is_admin', sa.Boolean(), nullable=True))


