import os
from dotenv import load_dotenv

load_dotenv()

class Config:
    SECRET_KEY = os.getenv('SECRET_KEY')
    SQLALCHEMY_DATABASE_URI = os.getenv('SQLALCHEMY_DATABASE_URI')
    SQLALCHEMY_TRACK_MODIFICATIONS = False
    TURNSTILE_SITEKEY = os.getenv('TURNSTILE_SITEKEY')
    TURNSTILE_SECRETKEY = os.getenv('TURNSTILE_SECRETKEY')
    TURNSTILE_AVAILABLE = os.getenv('TURNSTILE_AVAILABLE') == 'True'
    SEND_FILE_MAX_AGE_DEFAULT = 2592000  # 30天缓存


class DevelopmentConfig(Config):
    DEBUG = True
    PORT = int(os.getenv('PORT', 5000))
    HOST = os.getenv('HOST', '127.0.0.1')
    DEBUG = os.getenv('DEBUG', 'True') == 'True'

class ProductionConfig(Config):
    DEBUG = False
    PORT = int(os.getenv('PORT', 5000))
    HOST = os.getenv('HOST', '0.0.0.0')
    DEBUG = os.getenv('DEBUG', 'False') == 'False'

class TestingConfig(Config):
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