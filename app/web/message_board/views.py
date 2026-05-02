from flask import render_template
from app.extensions.decorators import authenticated_required


def register_views(bp):

    @bp.route('/')
    @authenticated_required
    def board():
        return render_template('message_board/board.html')
