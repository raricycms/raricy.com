"""add admin-only and notify-on-post flags to categories

Revision ID: 8c1c9c0fd3a2
Revises: fe3a1a2c9b1a
Create Date: 2025-09-24 12:34:56.000000

"""
from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision = '8c1c9c0fd3a2'
down_revision = 'fe3a1a2c9b1a'
branch_labels = None
depends_on = None


def upgrade():
    # categories.admin_only_posting
    with op.batch_alter_table('categories', schema=None) as batch_op:
        batch_op.add_column(sa.Column('admin_only_posting', sa.Boolean(), nullable=True))
        batch_op.create_index(batch_op.f('ix_categories_admin_only_posting'), ['admin_only_posting'], unique=False)
    op.execute("UPDATE categories SET admin_only_posting = 0 WHERE admin_only_posting IS NULL")
    with op.batch_alter_table('categories', schema=None) as batch_op:
        batch_op.alter_column('admin_only_posting', nullable=False)

    # categories.notify_admin_on_post
    with op.batch_alter_table('categories', schema=None) as batch_op:
        batch_op.add_column(sa.Column('notify_admin_on_post', sa.Boolean(), nullable=True))
        batch_op.create_index(batch_op.f('ix_categories_notify_admin_on_post'), ['notify_admin_on_post'], unique=False)
    op.execute("UPDATE categories SET notify_admin_on_post = 0 WHERE notify_admin_on_post IS NULL")
    with op.batch_alter_table('categories', schema=None) as batch_op:
        batch_op.alter_column('notify_admin_on_post', nullable=False)


def downgrade():
    with op.batch_alter_table('categories', schema=None) as batch_op:
        batch_op.drop_index(batch_op.f('ix_categories_notify_admin_on_post'))
        batch_op.drop_column('notify_admin_on_post')

    with op.batch_alter_table('categories', schema=None) as batch_op:
        batch_op.drop_index(batch_op.f('ix_categories_admin_only_posting'))
        batch_op.drop_column('admin_only_posting')


