from flask import Flask

def register_blueprints(app: Flask):
    from .main import home_bp

    app.register_blueprint(home_bp, url_prefix='/')