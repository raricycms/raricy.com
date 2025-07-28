from flask import Blueprint, render_template, request, jsonify
from app.models import User
from flask_login import login_user, logout_user, login_required
from flask import send_from_directory, abort, current_app
import os

profile_bp = Blueprint('profile', __name__)

@profile_bp.route('/profile/<uuid>')
def profile(uuid):
    user = User.query.filter_by(uuid=uuid).first_or_404()
    return render_template('auth/profile.html', user=user)


@profile_bp.route('/avatar/<uuid>')
def get_avatar(uuid):
    print(uuid)
    user = User.query.filter_by(uuid=uuid).first_or_404()
    avatar_dir = os.path.normpath(os.path.join(current_app.instance_path, 'avatars', f'{uuid}.png'))
    if not os.path.exists(avatar_dir):
        abort(404)
    return send_from_directory(
        directory=os.path.dirname(avatar_dir),
        path=os.path.basename(avatar_dir),
        mimetype='image/png'
    )