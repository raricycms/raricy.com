"""add role to users and backfill

Revision ID: b1a2c3d4e5f6
Revises: cbf9e467bf1d
Create Date: 2025-11-08 00:00:00.000000

"""
from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision = 'b1a2c3d4e5f6'
down_revision = 'cbf9e467bf1d'
branch_labels = None
depends_on = None


def upgrade():
    with op.batch_alter_table('users', schema=None) as batch_op:
        batch_op.add_column(
            sa.Column('role', sa.String(length=20), nullable=False, server_default='user')
        )
        batch_op.create_index(batch_op.f('ix_users_role'), ['role'], unique=False)

    # 回填：管理员 -> admin；核心用户 -> core；否则 user
    op.execute("UPDATE users SET role = 'admin' WHERE is_admin = 1")
    op.execute("UPDATE users SET role = 'core' WHERE authenticated = 1 AND (is_admin IS NULL OR is_admin = 0)")
    # 若未来需要设置站长，可手动将特定用户 role 更新为 'owner'，并建议保留 is_admin=1 以兼容旧逻辑


def downgrade():
    with op.batch_alter_table('users', schema=None) as batch_op:
        batch_op.drop_index(batch_op.f('ix_users_role'))
        batch_op.drop_column('role')


