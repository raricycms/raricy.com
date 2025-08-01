from flask import Flask
from .web import register_blueprints
from .extensions import init_extensions
from .config import get_config
from .cli import register_commands
def create_app():
    app = Flask(__name__)
    app.config.from_object(get_config())
    register_blueprints(app)
    init_extensions(app)
    register_commands(app)
    return app
