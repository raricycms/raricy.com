from flask import Blueprint

auth_bp = Blueprint('auth', __name__)

from . import authentic, profile, settings, sign_in, sign_up, user_management
