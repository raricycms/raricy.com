from flask import Blueprint

story_bp = Blueprint("story", __name__)

from . import views  # noqa: E402, F401 — routes are registered via decorators
