"""add fish_transactions table

Revision ID: b7e0b10c30bf
Revises: 6cdfe7d6d546
Create Date: 2026-06-27 16:52:52.813583

"""
from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision = 'b7e0b10c30bf'
down_revision = '6cdfe7d6d546'
branch_labels = None
depends_on = None


def upgrade():
    op.create_table('fish_transactions',
    sa.Column('id', sa.Integer(), nullable=False),
    sa.Column('user_id', sa.String(length=36), nullable=False),
    sa.Column('amount', sa.Integer(), nullable=False),
    sa.Column('type', sa.String(length=32), nullable=False),
    sa.Column('description', sa.String(length=255), nullable=True),
    sa.Column('reference_type', sa.String(length=32), nullable=True),
    sa.Column('reference_id', sa.String(length=255), nullable=True),
    sa.Column('created_at', sa.DateTime(), nullable=True),
    sa.ForeignKeyConstraint(['user_id'], ['users.id'], ),
    sa.PrimaryKeyConstraint('id')
    )
    with op.batch_alter_table('fish_transactions', schema=None) as batch_op:
        batch_op.create_index(batch_op.f('ix_fish_transactions_created_at'), ['created_at'], unique=False)
        batch_op.create_index(batch_op.f('ix_fish_transactions_type'), ['type'], unique=False)
        batch_op.create_index(batch_op.f('ix_fish_transactions_user_id'), ['user_id'], unique=False)


def downgrade():
    with op.batch_alter_table('fish_transactions', schema=None) as batch_op:
        batch_op.drop_index(batch_op.f('ix_fish_transactions_user_id'))
        batch_op.drop_index(batch_op.f('ix_fish_transactions_type'))
        batch_op.drop_index(batch_op.f('ix_fish_transactions_created_at'))

    op.drop_table('fish_transactions')
