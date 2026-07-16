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
        # under an ASGI mount the prefix must not defeat the /api guard;
        # newer Starlette keeps scope["path"] full and records the mount in
        # root_path — strip it explicitly so /weft/x/api/… is still guarded
        path = request.scope["path"]
        root = request.scope.get("root_path", "")
        rel = path[len(root):] if root and path.startswith(root) else path
        if not rel.startswith("/api"):
            return await call_next(request)
        origin = request.headers.get("origin")
        # same-origin requests are always fine — under an ASGI mount the
        # page's origin is the HOST app's, which no static allowlist can
        # know in advance. (Behind a TLS proxy, enable forwarded headers
        # in the host so request.url.scheme is honest.)
        own = f"{request.url.scheme}://{request.headers.get('host', '')}"
        if origin is not None and origin != own \
                and origin not in self.allowed_origins:
            return JSONResponse({"error": "forbidden origin"}, status_code=403)
        auth = request.headers.get("authorization", "")
        token = auth.removeprefix("Bearer ").strip() if auth.startswith("Bearer ") else \
            request.query_params.get("token", "")
        if not secrets.compare_digest(token, self.token):
            return JSONResponse({"error": "missing or invalid token"}, status_code=401)
        return await call_next(request)
