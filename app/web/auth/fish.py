from flask import render_template
from flask_login import login_required, current_user
from . import auth_bp


@auth_bp.route('/fish')
@login_required
def fish_balance():
    """Display the user's dried fish balance."""
    return render_template(
        'auth/fish.html',
        dried_fish=current_user.dried_fish,
    )
