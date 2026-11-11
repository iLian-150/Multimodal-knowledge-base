"""Small bounded exponential retry helper for transient upstream failures."""

from __future__ import annotations

import time
from collections.abc import Callable
from typing import TypeVar


T = TypeVar("T")


def retry_call(operation: Callable[[], T], attempts: int = 3, base_seconds: float = 0.35) -> T:
    last_error: Exception | None = None
    for attempt in range(max(1, attempts)):
        try:
            return operation()
        except Exception as exc:  # noqa: BLE001 - callers decide whether final failure can fall back.
            last_error = exc
            if attempt + 1 >= max(1, attempts):
                break
            time.sleep(max(0.0, base_seconds) * (2**attempt))
    assert last_error is not None
    raise last_error
