import pytest

from weft_ui.lock import UILock, WorkspaceLocked


def test_second_acquire_refused(tmp_path):
    a, b = UILock(tmp_path), UILock(tmp_path)
    a.acquire()
    with pytest.raises(WorkspaceLocked, match="another weft-ui"):
        b.acquire()
    a.release()
    b.acquire()  # released lock is take-able again
    b.release()
