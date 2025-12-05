from .markdown_upload import markdown_upload_bp

def register_blueprints(app):
    app.register_blueprint(markdown_upload_bp, url_prefix='/test')
