import os
from dotenv import load_dotenv

load_dotenv()

class Config:
    SECRET_KEY = os.getenv('SECRET_KEY')
    SQLALCHEMY_DATABASE_URI = os.getenv('SQLALCHEMY_DATABASE_URI')
    SQLALCHEMY_TRACK_MODIFICATIONS = False
    TURNSTILE_SITEKEY = os.getenv('TURNSTILE_SITEKEY')
    TURNSTILE_SECRETKEY = os.getenv('TURNSTILE_SECRETKEY')

class DevelopmentConfig(Config):
    DEBUG = True
    TURNSTILE_AVAILABLE = False

class ProductionConfig(Config):
    DEBUG = False
    TURNSTILE_AVAILABLE = True

class TestingConfig(Config):
    DEBUG = True
    TURNSTILE_AVAILABLE = True

config = {
    'development': DevelopmentConfig,
    'production': ProductionConfig,
    'testing': TestingConfig,
    'default': DevelopmentConfig
}