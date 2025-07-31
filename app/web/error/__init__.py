from flask import Blueprint, render_template

error_bp = Blueprint('error', __name__)

@error_bp.app_errorhandler(404)
def page_not_found(e):
    return render_template('errorhandlers/404.html'), 404

@error_bp.app_errorhandler(403)
def internal_server_error(e):
    return render_template('errorhandlers/403.html'), 403