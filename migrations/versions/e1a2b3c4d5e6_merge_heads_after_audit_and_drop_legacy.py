"""merge heads after audit and drop legacy

Revision ID: e1a2b3c4d5e6
Revises: da7e9f10c2ab, 2b7f9c1a0d2b
Create Date: 2025-11-08
"""

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision = 'e1a2b3c4d5e6'
down_revision = ('da7e9f10c2ab', '2b7f9c1a0d2b')
branch_labels = None
depends_on = None


def upgrade():
    # No-op merge migration to unify heads.
    pass


def downgrade():
    # Can't unmerge heads automatically.
    pass


