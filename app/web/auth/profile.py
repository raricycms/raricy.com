from flask import Blueprint, render_template, request, jsonify
from app.models import User
from flask_login import login_user, logout_user, login_required

profile_bp = Blueprint('profile', __name__)

@profile_bp.route('/profile')
@login_required
def profile():
    return render_template('auth/profile.html')