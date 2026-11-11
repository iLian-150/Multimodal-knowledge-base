import json

from manufacturing_rag.debug_log import chunks_for_debug, retrieval_results_for_debug, write_debug_log
from manufacturing_rag.config import RAGConfig
from manufacturing_rag.schemas import DocumentChunk, RetrievalResult


def test_write_debug_log_writes_utf8_jsonl(tmp_path):
    log_path = tmp_path / "rag_debug.jsonl"
    config = RAGConfig(debug_log_enabled=True, debug_log_path=str(log_path), debug_log_text_chars=20)

    write_debug_log(config, "unit_test_event", text="MySQL 锁机制")

    record = json.loads(log_path.read_text(encoding="utf-8"))
    assert record["event"] == "unit_test_event"
    assert record["text"] == "MySQL 锁机制"


def test_debug_helpers_limit_text_preview():
    chunk = DocumentChunk(id="c1", text="MySQL 锁机制包括共享锁和排他锁", source="locks.pdf")
    result = RetrievalResult(chunk=chunk, score=0.9, rank=1, reason="test")

    chunk_rows = chunks_for_debug([chunk], text_chars=8)
    result_rows = retrieval_results_for_debug([result], text_chars=8)

    assert chunk_rows[0]["text_preview"] == "MySQL 锁机"
    assert result_rows[0]["text_preview"] == "MySQL 锁机"
    assert result_rows[0]["score"] == 0.9
