from flask import Blueprint, render_template

story_bp = Blueprint('story', __name__)

@story_bp.route('/')
def menu():
    return render_template('story/menu.html')