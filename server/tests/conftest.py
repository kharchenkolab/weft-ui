import pytest
from fastapi.testclient import TestClient

from weft_ui.main import create_app

TOKEN = "test-token"
AUTH = {"authorization": f"Bearer {TOKEN}"}


@pytest.fixture()
def client(tmp_path):
    app = create_app(tmp_path / "ws", token=TOKEN)
    with TestClient(app) as c:
        c.headers.update(AUTH)
        yield c


@pytest.fixture()
def anyio_backend():
    return "asyncio"
