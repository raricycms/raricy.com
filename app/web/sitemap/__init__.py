from flask import Blueprint, render_template

sitemap_bp = Blueprint('sitemap', __name__)

@sitemap_bp.route('/')
def index():
    return render_template('sitemap/index.html')