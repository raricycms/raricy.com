"""add admin action logs and appeals tables

Revision ID: 2b7f9c1a0d2b
Revises: b1a2c3d4e5f6
Create Date: 2025-11-08
"""

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision = '2b7f9c1a0d2b'
down_revision = 'b1a2c3d4e5f6'
branch_labels = None
depends_on = None


def upgrade():
    op.create_table(
        'admin_action_logs',
        sa.Column('id', sa.Integer(), primary_key=True),
        sa.Column('created_at', sa.DateTime(), nullable=True),
        sa.Column('action', sa.String(length=32), nullable=False),
        sa.Column('admin_id', sa.String(length=36), nullable=False),
        sa.Column('target_user_id', sa.String(length=36), nullable=True),
        sa.Column('object_type', sa.String(length=32), nullable=True),
        sa.Column('object_id', sa.String(length=36), nullable=True),
        sa.Column('reason', sa.String(length=255), nullable=True),
        sa.Column('extra', sa.JSON(), nullable=True),
        sa.Column('visibility', sa.String(length=16), nullable=False, server_default='public'),
    )
    op.create_index('ix_admin_action_logs_created_at', 'admin_action_logs', ['created_at'])
    op.create_index('ix_admin_action_logs_action', 'admin_action_logs', ['action'])
    op.create_index('ix_admin_action_logs_admin_id', 'admin_action_logs', ['admin_id'])
    op.create_index('ix_admin_action_logs_target_user_id', 'admin_action_logs', ['target_user_id'])
    op.create_index('ix_admin_action_logs_object_id', 'admin_action_logs', ['object_id'])
    op.create_index('ix_admin_action_logs_visibility', 'admin_action_logs', ['visibility'])

    op.create_table(
        'admin_action_appeals',
        sa.Column('id', sa.Integer(), primary_key=True),
        sa.Column('created_at', sa.DateTime(), nullable=True),
        sa.Column('updated_at', sa.DateTime(), nullable=True),
        sa.Column('log_id', sa.Integer(), nullable=False),
        sa.Column('appellant_id', sa.String(length=36), nullable=False),
        sa.Column('content', sa.Text(), nullable=False),
        sa.Column('status', sa.String(length=16), nullable=False, server_default='pending'),
        sa.Column('decision', sa.Text(), nullable=True),
        sa.Column('decided_by', sa.String(length=36), nullable=True),
        sa.Column('decided_at', sa.DateTime(), nullable=True),
    )
    op.create_index('ix_admin_action_appeals_created_at', 'admin_action_appeals', ['created_at'])
    op.create_index('ix_admin_action_appeals_updated_at', 'admin_action_appeals', ['updated_at'])
    op.create_index('ix_admin_action_appeals_log_id', 'admin_action_appeals', ['log_id'])
    op.create_index('ix_admin_action_appeals_appellant_id', 'admin_action_appeals', ['appellant_id'])
    op.create_index('ix_admin_action_appeals_status', 'admin_action_appeals', ['status'])


def downgrade():
    op.drop_index('ix_admin_action_appeals_status', table_name='admin_action_appeals')
    op.drop_index('ix_admin_action_appeals_appellant_id', table_name='admin_action_appeals')
    op.drop_index('ix_admin_action_appeals_log_id', table_name='admin_action_appeals')
    op.drop_index('ix_admin_action_appeals_updated_at', table_name='admin_action_appeals')
    op.drop_index('ix_admin_action_appeals_created_at', table_name='admin_action_appeals')
    op.drop_table('admin_action_appeals')

    op.drop_index('ix_admin_action_logs_visibility', table_name='admin_action_logs')
    op.drop_index('ix_admin_action_logs_object_id', table_name='admin_action_logs')
    op.drop_index('ix_admin_action_logs_target_user_id', table_name='admin_action_logs')
    op.drop_index('ix_admin_action_logs_admin_id', table_name='admin_action_logs')
    op.drop_index('ix_admin_action_logs_action', table_name='admin_action_logs')
    op.drop_index('ix_admin_action_logs_created_at', table_name='admin_action_logs')
    op.drop_table('admin_action_logs')


