"""
Deprecated: This module previously created tables at app startup via db.create_all().
Schema creation and migrations should be handled by Flask-Migrate/Alembic
using CLI commands (flask db init/migrate/upgrade) during deployment,
not within the application runtime.
"""

# Intentionally left without side effects.