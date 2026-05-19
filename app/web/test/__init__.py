from .markdown_upload import markdown_upload_bp
from .deepcaptcha_demo import deepcaptcha_bp

def register_blueprints(app):
    app.register_blueprint(markdown_upload_bp, url_prefix='/test')
    app.register_blueprint(deepcaptcha_bp, url_prefix='/test')
