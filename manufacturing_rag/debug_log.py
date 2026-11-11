"""UTF-8 JSONL debug logging for ingest and retrieval traces."""

from __future__ import annotations

import json
from datetime import datetime
from pathlib import Path
from threading import Lock
from typing import Any, Iterable, List

from manufacturing_rag.schemas import DocumentChunk, RetrievalResult

_LOG_LOCK = Lock()


def write_debug_log(config: Any, event: str, **payload: Any) -> None:
    if not getattr(config, "debug_log_enabled", False):
        return
    log_path = Path(str(getattr(config, "debug_log_path", "logs/rag_debug.jsonl")))
    if not log_path.is_absolute():
        log_path = Path.cwd() / log_path
    record = {
        "ts": datetime.now().astimezone().isoformat(timespec="seconds"),
        "event": event,
        **to_jsonable(payload),
    }
    try:
        log_path.parent.mkdir(parents=True, exist_ok=True)
        with _LOG_LOCK:
            with log_path.open("a", encoding="utf-8") as handle:
                handle.write(json.dumps(record, ensure_ascii=False) + "\n")
    except OSError:
        return


def chunks_for_debug(chunks: Iterable[DocumentChunk], text_chars: int, limit: int = 10) -> List[dict[str, Any]]:
    rows: List[dict[str, Any]] = []
    for chunk in list(chunks)[:limit]:
        text = str(chunk.text or "")
        rows.append(
            {
                "id": chunk.id,
                "source": chunk.source,
                "page": chunk.page,
                "block_id": chunk.block_id,
                "modality": chunk.modality,
                "metadata": chunk.metadata,
                "text_length": len(text),
                "text_preview": text[:text_chars],
            }
        )
    return rows


def retrieval_results_for_debug(
    results: Iterable[RetrievalResult], text_chars: int, limit: int = 10
) -> List[dict[str, Any]]:
    rows: List[dict[str, Any]] = []
    for result in list(results)[:limit]:
        chunk = result.chunk
        text = str(chunk.text or "")
        rows.append(
            {
                "rank": result.rank,
                "score": result.score,
                "reason": result.reason,
                "id": chunk.id,
                "source": chunk.source,
                "page": chunk.page,
                "block_id": chunk.block_id,
                "modality": chunk.modality,
                "metadata": chunk.metadata,
                "text_length": len(text),
                "text_preview": text[:text_chars],
            }
        )
    return rows


def to_jsonable(value: Any) -> Any:
    if isinstance(value, dict):
        return {str(key): to_jsonable(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [to_jsonable(item) for item in value]
    if isinstance(value, (str, int, float, bool)) or value is None:
        return value
    return str(value)
