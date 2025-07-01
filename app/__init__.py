from flask import Flask
from .web import register_blueprints
from .extensions import init_extensions
from .config import config

def create_app(config_name='default'):
    app = Flask(__name__)
    app.config.from_object(config[config_name])
    register_blueprints(app)
    init_extensions(app)
    with app.app_context():
        from app.models import User
        from app.extensions import db
        db.create_all()
    return app
