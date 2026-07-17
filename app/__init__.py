from flask import Flask, url_for
from .web import register_blueprints
from .extensions import init_extensions
from .config import get_config
from .cli import register_commands
from .cli_import import register_import_commands
from .clients import AccountClient
from .extensions.ms_datetime import install_ms_datetime
from datetime import datetime
from werkzeug.middleware.proxy_fix import ProxyFix
import os

# 账户服务客户端（在 create_app 中通过 init_app 初始化）
account_client = AccountClient()

def create_app():
    # 时间戳格式兼容层（默认关闭）。
    #
    # 置 DB_DATETIME_MS=true 后，Flask 改用 Unix 毫秒整数读写 DATETIME 列，
    # 与 Next.js 侧的 Prisma 同格式 —— 这是「Flask 与 Next 共读一个已规整的库」
    # （灰度切换/可回滚）的前提。详见 app/extensions/ms_datetime.py。
    #
    # 默认关闭，因为尚未规整的库仍是 SQLAlchemy 文本格式，装上反而读不了。
    # 开启时机：跑完 web-next/scripts/normalize-datetimes.mjs 之后。
    # 必须在 init_extensions() 建 engine 之前调用。
    if os.environ.get('DB_DATETIME_MS', '').strip().lower() in ('1', 'true', 'yes'):
        install_ms_datetime()

    app = Flask(__name__)
    app.config.from_object(get_config())
    # Trust reverse proxy headers from Nginx for host/scheme so url_for builds correct external URLs
    app.wsgi_app = ProxyFix(app.wsgi_app, x_proto=1, x_host=1)

    # 初始化账户服务客户端
    account_client.init_app(app)
    app.account_client = account_client

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
    
    os.makedirs(app.config.get('IMAGE_UPLOAD_FOLDER', os.path.join(os.getcwd(), 'instance', 'images')), exist_ok=True)
    register_blueprints(app)
    init_extensions(app)
    register_commands(app)
    register_import_commands(app)
    return app
