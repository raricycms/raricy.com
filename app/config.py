import os
from dotenv import load_dotenv

load_dotenv()

class Config:
    """
    基础配置类，包含所有环境的通用配置。
    """
    SECRET_KEY = os.getenv('SECRET_KEY') # 网站密钥
    # 数据库连接URI；若环境变量未提供，默认使用 instance 下的 SQLite，便于携带与备份
    SQLALCHEMY_DATABASE_URI = os.getenv('SQLALCHEMY_DATABASE_URI') or 'sqlite:///' + os.path.join(os.getcwd(), 'instance', 'app.db')
    SQLALCHEMY_TRACK_MODIFICATIONS = False # 关闭数据库修改跟踪
    TURNSTILE_SITE_KEY = os.getenv('TURNSTILE_SITE_KEY') # Cloudflare Turnstile 站点密钥
    TURNSTILE_SECRET_KEY = os.getenv('TURNSTILE_SECRET_KEY') # Cloudflare Turnstile 密钥
    TURNSTILE_AVAILABLE = os.getenv('TURNSTILE_AVAILABLE') == 'True' # 是否启用 Cloudflare Turnstile
    SEND_FILE_MAX_AGE_DEFAULT = 2592000  # 30天缓存
    SERVER_NAME = os.getenv('SERVER_NAME', '127.0.0.1') # 服务器名称


class DevelopmentConfig(Config):
    """
    开发环境配置类，继承自基础配置类。用于本地开发。
    """
    DEBUG = True
    PORT = int(os.getenv('PORT', 5000))
    HOST = os.getenv('HOST', '127.0.0.1')
    DEBUG = os.getenv('DEBUG', 'True') == 'True'

class ProductionConfig(Config):
    """
    生产环境配置类，继承自基础配置类。用于https://raricy.com
    """
    DEBUG = False
    PORT = int(os.getenv('PORT', 5000))
    HOST = os.getenv('HOST', '0.0.0.0')
    DEBUG = os.getenv('DEBUG', 'False') == 'False'

class TestingConfig(Config):
    """
    测试环境配置类，继承自基础配置类。用于http://raricy.com:5000
    """
    DEBUG = True
    PORT = int(os.getenv('PORT', 5000))
    HOST = os.getenv('HOST', '0.0.0.0')
    DEBUG = os.getenv('DEBUG', 'True') == 'True'

def get_config():
    config_type = os.getenv('CONFIG_TYPE')
    if config_type == 'development':
        return DevelopmentConfig
    elif config_type == 'production':
        return ProductionConfig
    elif config_type == 'testing':
        return TestingConfig
    else:
        return DevelopmentConfig