from .sign_up import sign_up_bp
from .sign_in import sign_in_bp
from .profile import profile_bp
from .authentic import auth_bp
def register_auth_blueprints(app):
    app.register_blueprint(sign_up_bp, url_prefix='/')
    app.register_blueprint(sign_in_bp, url_prefix='/')
    app.register_blueprint(profile_bp, url_prefix='/')
    app.register_blueprint(auth_bp, url_prefix='/')
