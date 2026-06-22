"""add profile privacy settings

Revision ID: cb7f4bb976a5
Revises: 1eec418c5754
Create Date: 2026-06-22 21:15:53.546500

"""
from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision = 'cb7f4bb976a5'
down_revision = '1eec418c5754'
branch_labels = None
depends_on = None


def upgrade():
    # Step 1: add columns (nullable, no existing rows have values yet)
    with op.batch_alter_table('users', schema=None) as batch_op:
        batch_op.add_column(sa.Column('show_recent_blogs', sa.Boolean(), nullable=True))
        batch_op.add_column(sa.Column('show_recent_comments', sa.Boolean(), nullable=True))

    # Step 2: backfill existing users — default to visible (SQLite uses 0/1 for booleans)
    op.execute("UPDATE users SET show_recent_blogs = 1, show_recent_comments = 1")

    # Step 3: enforce NOT NULL now that every row has a value
    with op.batch_alter_table('users', schema=None) as batch_op:
        batch_op.alter_column('show_recent_blogs',
               existing_type=sa.BOOLEAN(),
               nullable=False)
        batch_op.alter_column('show_recent_comments',
               existing_type=sa.BOOLEAN(),
               nullable=False)


def downgrade():
    with op.batch_alter_table('users', schema=None) as batch_op:
        batch_op.drop_column('show_recent_comments')
        batch_op.drop_column('show_recent_blogs')
