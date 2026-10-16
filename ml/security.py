"""Local process authentication and finite resource limits for the HTTP sidecar."""
from __future__ import annotations
import hmac
import os
import re
import secrets
import stat
import time
from pathlib import Path
from starlette.responses import JSONResponse


def positive_limit(name: str, default: int) -> int:
    value = int(os.environ.get(name, default))
    if value <= 0:
        raise ValueError(f"Invalid {name}")
    return value


MAX_BODY_BYTES = positive_limit("CHIPTOOL_MAX_SIDECAR_BYTES", 32 * 1024 * 1024)
MAX_REGION_PIXELS = positive_limit("CHIPTOOL_MAX_REGION_PIXELS", 4_194_304)
MAX_REGION_DIMENSION = positive_limit("CHIPTOOL_MAX_REGION_DIMENSION", 4096)


def dev_token() -> str:
    supplied = os.environ.get("CHIPTOOL_DEV_TOKEN")
    if supplied:
        if len(supplied) < 32:
            raise ValueError("CHIPTOOL_DEV_TOKEN must have at least 32 characters")
        return supplied
    token_file = Path(os.environ.get("CHIPTOOL_TOKEN_FILE", str(Path(__file__).resolve().parents[1] / "node_modules/.cache/chiptool-token")))
    token_file.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    try:
        fd = os.open(token_file, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        with os.fdopen(fd, "w") as file:
            file.write(secrets.token_hex(32))
    except FileExistsError:
        pass
    metadata = token_file.lstat()
    if not stat.S_ISREG(metadata.st_mode) or metadata.st_mode & 0o077 or metadata.st_uid != os.getuid():
        raise ValueError("The dev token must be an owner-only regular file")
    for _ in range(50):
        fd = os.open(token_file, os.O_RDONLY | os.O_NOFOLLOW)
        with os.fdopen(fd) as file:
            token = file.read().strip()
        if re.fullmatch(r"[a-f0-9]{64}", token):
            return token
        time.sleep(0.01)
    raise ValueError("Invalid dev token file")


DEV_TOKEN = dev_token()


def confined_path(root: Path, candidate: Path) -> Path:
    """Reject traversal and symlinks, including symlink files inside the root."""
    root = root.absolute()
    candidate = Path(os.path.abspath(candidate))
    if not candidate.is_relative_to(root):
        raise ValueError("Path outside permitted directory")
    current = root
    for part in ("", *candidate.relative_to(root).parts):
        current = current / part
        if current.is_symlink():
            raise ValueError("Symlinks are not allowed")
    return candidate


class _BodyTooLarge(Exception):
    pass


class LocalAccessMiddleware:
    """Authenticate before multipart parsing; count streamed bodies, not just Content-Length."""
    def __init__(self, app):
        self.app = app
        self.active = 0

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            return await self.app(scope, receive, send)
        headers = dict(scope.get("headers", []))
        if not hmac.compare_digest(headers.get(b"x-chiptool-token", b""), DEV_TOKEN.encode()):
            return await JSONResponse({"detail": "Local dev token required"}, status_code=401)(scope, receive, send)
        if b"origin" in headers:
            return await JSONResponse({"detail": "Browser access to sidecar is forbidden"}, status_code=403)(scope, receive, send)
        try:
            size = int(headers.get(b"content-length", b"0"))
        except ValueError:
            size = -1
        if size < 0 or size > MAX_BODY_BYTES:
            return await JSONResponse({"detail": "Request body exceeds limit"}, status_code=413)(scope, receive, send)
        if self.active >= 16:
            return await JSONResponse({"detail": "Sidecar is busy"}, status_code=429)(scope, receive, send)
        seen = 0
        started = False

        async def bounded_receive():
            nonlocal seen
            message = await receive()
            seen += len(message.get("body", b""))
            if seen > MAX_BODY_BYTES:
                raise _BodyTooLarge()
            return message

        async def track_send(message):
            nonlocal started
            if message["type"] == "http.response.start":
                started = True
            await send(message)

        self.active += 1
        try:
            await self.app(scope, bounded_receive, track_send)
        except _BodyTooLarge:
            if not started:
                await JSONResponse({"detail": "Request body exceeds limit"}, status_code=413)(scope, receive, send)
        finally:
            self.active -= 1
