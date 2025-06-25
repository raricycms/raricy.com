from flask import Flask

def register_blueprints(app: Flask):
    from .main import home_bp
    from .story import story_bp
    from .game import game_bp

    app.register_blueprint(home_bp, url_prefix='/')
    app.register_blueprint(story_bp, url_prefix='/story')
    app.register_blueprint(game_bp, url_prefix='/game')