"""In-process rate limiting for expensive routes (Claude calls, retrain).

NOTE: this is deliberately in-memory and PER-PROCESS. The production
deployment is a single Railway replica, so a process-local sliding window
is sufficient. If the API is ever scaled to multiple replicas, move this
to a shared store (e.g. Redis).

Defaults: 30 requests/minute per route per client IP. Override per route
with QTX_RATE_LIMIT_<ROUTE_KEY> (e.g. QTX_RATE_LIMIT_ASK=10) or globally
with QTX_RATE_LIMIT_DEFAULT. A value <= 0 disables limiting for that route.
Limited requests receive 429 with a Retry-After header (seconds).
"""
from __future__ import annotations

import logging
import math
import os
import threading
import time
from collections import defaultdict, deque

from fastapi import HTTPException, Request

logger = logging.getLogger(__name__)

_WINDOW_SECONDS = 60.0
_DEFAULT_LIMIT = 30


class SlidingWindowLimiter:
    """Thread-safe sliding-window hit counter keyed by an arbitrary hashable."""

    def __init__(self, window_seconds: float = _WINDOW_SECONDS) -> None:
        self._window = window_seconds
        self._hits: dict = defaultdict(deque)
        self._lock = threading.Lock()

    def acquire(self, key, limit: int) -> float | None:
        """Record a hit for ``key``.

        Returns None when the request is allowed, otherwise the number of
        seconds until the oldest hit leaves the window (Retry-After).
        """
        now = time.monotonic()
        with self._lock:
            q = self._hits[key]
            cutoff = now - self._window
            while q and q[0] <= cutoff:
                q.popleft()
            if len(q) >= limit:
                return q[0] + self._window - now
            q.append(now)
            return None

    def reset(self) -> None:
        with self._lock:
            self._hits.clear()


_limiter = SlidingWindowLimiter()


def _limit_for(route_key: str, default: int) -> int:
    raw = os.environ.get(
        f"QTX_RATE_LIMIT_{route_key.upper()}",
        os.environ.get("QTX_RATE_LIMIT_DEFAULT", str(default)),
    )
    try:
        return int(raw)
    except ValueError:
        logger.warning("Invalid rate limit %r for route %s — using %d", raw, route_key, default)
        return default


def rate_limit(route_key: str, default_limit: int = _DEFAULT_LIMIT):
    """Return a FastAPI dependency enforcing a per-route + client-IP limit."""

    def dependency(request: Request) -> None:
        limit = _limit_for(route_key, default_limit)
        if limit <= 0:
            return
        client_ip = request.client.host if request.client else "unknown"
        retry_after = _limiter.acquire((route_key, client_ip), limit)
        if retry_after is not None:
            seconds = max(1, math.ceil(retry_after))
            logger.warning(
                "Rate limit exceeded: route=%s ip=%s limit=%d/min", route_key, client_ip, limit
            )
            raise HTTPException(
                status_code=429,
                detail=f"Rate limit exceeded for this endpoint ({limit}/min). Retry in {seconds}s.",
                headers={"Retry-After": str(seconds)},
            )

    return dependency


def reset_rate_limits() -> None:
    """Clear all recorded hits (test helper)."""
    _limiter.reset()
