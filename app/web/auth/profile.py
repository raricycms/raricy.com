from flask import Blueprint, render_template, request, jsonify
from app.models import User
from flask_login import login_user, logout_user, login_required
from flask import send_from_directory, abort, current_app
import os

from . import auth_bp

@auth_bp.route('/profile/<user_id>')
def profile(user_id):
    user = User.query.filter_by(id=user_id).first_or_404()
    return render_template('auth/profile.html', user=user)


@auth_bp.route('/avatar/<user_id>')
def get_avatar(user_id):
    user = User.query.filter_by(id=user_id).first_or_404()
    avatar_dir = os.path.normpath(os.path.join(current_app.instance_path, 'avatars', f'{user.id}.png'))
    if not os.path.exists(avatar_dir):
        abort(404)
    return send_from_directory(
        directory=os.path.dirname(avatar_dir),
        path=os.path.basename(avatar_dir),
        mimetype='image/png'
    )