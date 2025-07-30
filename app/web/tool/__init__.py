# todo

from flask import Blueprint, render_template

tool_bp = Blueprint('tool', __name__)

@tool_bp.route('/')
def menu():
    return render_template('tool/menu.html')