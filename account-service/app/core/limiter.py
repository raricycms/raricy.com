"""Shared rate limiter instance — used by main.py middleware and route decorators."""

from slowapi import Limiter
from slowapi.util import get_remote_address

limiter = Limiter(key_func=get_remote_address)
