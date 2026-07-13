"""Localhost security (plan D7): random bearer token + Origin check.

The server binds 127.0.0.1 and mints a token at startup; the served page
embeds it, every /api request must carry it, and cross-origin browser
requests are rejected by the Origin check even if a token leaks into a
same-machine web page.
"""

from __future__ import annotations

import secrets

from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request
from starlette.responses import JSONResponse


def mint_token() -> str:
    return secrets.token_urlsafe(24)


class AuthMiddleware(BaseHTTPMiddleware):
    """Reject /api requests without the bearer token or with a foreign Origin."""

    def __init__(self, app, token: str, allowed_origins: set[str]):
        super().__init__(app)
        self.token = token
        self.allowed_origins = allowed_origins

    async def dispatch(self, request: Request, call_next):
        if not request.url.path.startswith("/api"):
            return await call_next(request)
        origin = request.headers.get("origin")
        if origin is not None and origin not in self.allowed_origins:
            return JSONResponse({"error": "forbidden origin"}, status_code=403)
        auth = request.headers.get("authorization", "")
        token = auth.removeprefix("Bearer ").strip() if auth.startswith("Bearer ") else \
            request.query_params.get("token", "")
        if not secrets.compare_digest(token, self.token):
            return JSONResponse({"error": "missing or invalid token"}, status_code=401)
        return await call_next(request)
