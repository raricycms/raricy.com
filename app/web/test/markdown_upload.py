from flask import render_template, Blueprint

markdown_upload_bp = Blueprint('markdown_upload', __name__)

@markdown_upload_bp.route('/markdown_upload')
def markdown_upload():
    return render_template('test/markdown_upload_test.html')
