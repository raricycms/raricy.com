"""add related_user_id to fish_transactions

Revision ID: 921dca7b5e98
Revises: b7e0b10c30bf
Create Date: 2026-06-27 17:26:54.015168

"""
from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision = '921dca7b5e98'
down_revision = 'b7e0b10c30bf'
branch_labels = None
depends_on = None


def upgrade():
    with op.batch_alter_table('fish_transactions', schema=None) as batch_op:
        batch_op.add_column(sa.Column('related_user_id', sa.String(length=36), nullable=True))
        batch_op.create_index(batch_op.f('ix_fish_transactions_related_user_id'), ['related_user_id'], unique=False)
        batch_op.create_foreign_key('fk_fish_transactions_related_user', 'users', ['related_user_id'], ['id'])


def downgrade():
    with op.batch_alter_table('fish_transactions', schema=None) as batch_op:
        batch_op.drop_constraint('fk_fish_transactions_related_user', type_='foreignkey')
        batch_op.drop_index(batch_op.f('ix_fish_transactions_related_user_id'))
        batch_op.drop_column('related_user_id')
