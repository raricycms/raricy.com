from flask_sitemap import Sitemap

sitemap = Sitemap()

def init_extensions(app):
    sitemap.init_app(app)