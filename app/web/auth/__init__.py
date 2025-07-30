from flask import Blueprint

auth_bp = Blueprint('auth', __name__)

from . import authentic, profile, sign_in, sign_up
