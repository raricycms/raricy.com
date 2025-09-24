"""add featured flag to blogs and exclude_from_all to categories

Revision ID: fe3a1a2c9b1a
Revises: c4c950a806d6
Create Date: 2025-09-24 00:00:00.000000

"""
from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision = 'fe3a1a2c9b1a'
down_revision = 'c4c950a806d6'
branch_labels = None
depends_on = None


def upgrade():
    # blogs.is_featured
    with op.batch_alter_table('blogs', schema=None) as batch_op:
        batch_op.add_column(sa.Column('is_featured', sa.Boolean(), nullable=True))
        batch_op.create_index(batch_op.f('ix_blogs_is_featured'), ['is_featured'], unique=False)

    # backfill default false then set not null
    op.execute("UPDATE blogs SET is_featured = 0 WHERE is_featured IS NULL")
    with op.batch_alter_table('blogs', schema=None) as batch_op:
        batch_op.alter_column('is_featured', nullable=False)

    # categories.exclude_from_all
    with op.batch_alter_table('categories', schema=None) as batch_op:
        batch_op.add_column(sa.Column('exclude_from_all', sa.Boolean(), nullable=True))
        batch_op.create_index(batch_op.f('ix_categories_exclude_from_all'), ['exclude_from_all'], unique=False)

    op.execute("UPDATE categories SET exclude_from_all = 0 WHERE exclude_from_all IS NULL")
    with op.batch_alter_table('categories', schema=None) as batch_op:
        batch_op.alter_column('exclude_from_all', nullable=False)

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

    with op.batch_alter_table('categories', schema=None) as batch_op:
        batch_op.drop_index(batch_op.f('ix_categories_exclude_from_all'))
        batch_op.drop_column('exclude_from_all')

    with op.batch_alter_table('blogs', schema=None) as batch_op:
        batch_op.drop_index(batch_op.f('ix_blogs_is_featured'))
        batch_op.drop_column('is_featured')


