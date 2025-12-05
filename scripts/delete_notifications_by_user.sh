#!/usr/bin/env sh
set -euo pipefail

# Delete all notifications sent by a specific user (by username)
# Usage: scripts/delete_notifications_by_user.sh <username>

if [ $# -lt 1 ]; then
  echo "Usage: $0 <username>" >&2
  exit 1
fi

USERNAME="$1"

# Resolve repo root from this script's directory
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
REPO_ROOT="$SCRIPT_DIR/.."

# Pick a Python interpreter
if command -v python >/dev/null 2>&1; then
  PYTHON_BIN="python"
elif command -v python3 >/dev/null 2>&1; then
  PYTHON_BIN="python3"
else
  echo "Error: python (or python3) is required but not found in PATH." >&2
  exit 1
fi

cd "$REPO_ROOT"

"$PYTHON_BIN" - "$USERNAME" <<'PYCODE'
import sys
from app import create_app
from app.extensions import db
from app.models import User, Notification

def main():
    if len(sys.argv) < 2:
        print("Username argument missing", file=sys.stderr)
        sys.exit(1)
    username = sys.argv[1]

    app = create_app()
    with app.app_context():
        user = User.query.filter_by(username=username).first()
        if not user:
            print(f"Error: user not found: {username}", file=sys.stderr)
            sys.exit(2)

        deleted_count = Notification.query.filter_by(actor_id=user.id).delete(synchronize_session=False)
        db.session.commit()
        print(f"Deleted {deleted_count} notifications from actor '{username}' (id={user.id}).")

if __name__ == "__main__":
    main()
PYCODE


