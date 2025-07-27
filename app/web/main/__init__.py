from flask import Blueprint, render_template, current_app, url_for
home_bp = Blueprint('home', __name__)

@home_bp.route('/')
def index():
    return render_template('home/homepage.html')

@home_bp.route('/robots.txt')
def robots_txt():
    """动态生成robots.txt"""
    sitemap_url = url_for('sitemap.xml', _external=True)
    
    robots_content = f"""User-agent: *
Allow: /
Disallow: /zhh/

Sitemap: {sitemap_url}
"""
    
    response = current_app.response_class(
        robots_content,
        mimetype='text/plain'
    )
    return response

from app.utils.invite_code import generate_invite_code
@home_bp.route('/zhh')
def zhh():
    return generate_invite_code()

@home_bp.route('/valid_user')
def valid_user():
    return render_template('home/valid_user.html')

@home_bp.route('/contact')
def contact():
    return render_template('home/contact.html')
