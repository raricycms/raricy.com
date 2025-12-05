from flask import Flask, url_for
from .web import register_blueprints
from .extensions import init_extensions
from .config import get_config
from .cli import register_commands
from .cli_import import register_import_commands
from datetime import datetime
from werkzeug.middleware.proxy_fix import ProxyFix
import os

def create_app():
    app = Flask(__name__)
    app.config.from_object(get_config())
    # Trust reverse proxy headers from Nginx for host/scheme so url_for builds correct external URLs
    app.wsgi_app = ProxyFix(app.wsgi_app, x_proto=1, x_host=1)
    
    # 注册自定义 Jinja2 过滤器
    @app.template_filter('datetime_format')
    def datetime_format(value, format='%Y-%m-%d %H:%M:%S'):
        """格式化日期时间"""
        if isinstance(value, str):
            try:
                # 如果是 ISO 格式字符串，先转换为 datetime 对象
                value = datetime.fromisoformat(value.replace('Z', '+00:00'))
            except ValueError:
                return value
        if isinstance(value, datetime):
            return value.strftime(format)
        return value

    # 为静态资源追加基于文件修改时间的版本号，避免浏览器使用旧缓存
    def static_url(filename: str):
        file_path = os.path.join(app.static_folder, filename)
        try:
            version = int(os.path.getmtime(file_path))
        except OSError:
            version = None
        return url_for('static', filename=filename, v=version) if version else url_for('static', filename=filename)

    app.jinja_env.globals['static_url'] = static_url
    
    register_blueprints(app)
    init_extensions(app)
    register_commands(app)
    register_import_commands(app)
    return app
