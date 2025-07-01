from flask import Flask

def register_blueprints(app: Flask):
    from .main import home_bp
    from .story import story_bp
    from .game import game_bp
    from .tool import tool_bp
    from .sitemap import sitemap_bp
    from .error import error_bp
    from .auth import register_auth_blueprints
    app.register_blueprint(home_bp, url_prefix='/')
    app.register_blueprint(story_bp, url_prefix='/story')
    app.register_blueprint(game_bp, url_prefix='/game')
    app.register_blueprint(tool_bp, url_prefix='/tool')
    app.register_blueprint(sitemap_bp, url_prefix='/sitemap')
    app.register_blueprint(error_bp, url_prefix='/error')
    register_auth_blueprints(app)