from manufacturing_rag.adapters.embedding import extract_embedding_vector
from manufacturing_rag.adapters.ocr import BaiduOCRAdapter, location_to_coordinates, render_pdf_pages_to_png_bytes
from manufacturing_rag.adapters.rerank import RuleBasedReranker, extract_rerank_scores
from manufacturing_rag.schemas import DocumentChunk, RetrievalResult

import pytest


def test_extract_embedding_vector_openai_shape():
    payload = {"data": [{"embedding": [0.1, "0.2", 0.3]}]}

    assert extract_embedding_vector(payload) == [0.1, 0.2, 0.3]


def test_extract_embedding_vector_dashscope_shape():
    payload = {"output": {"embeddings": [{"embedding": [1, 2, 3]}]}}

    assert extract_embedding_vector(payload) == [1.0, 2.0, 3.0]


def test_extract_rerank_scores_dashscope_shape():
    payload = {"output": {"results": [{"index": 2, "relevance_score": 0.91}]}}

    assert extract_rerank_scores(payload) == {2: 0.91}


def test_rule_reranker_keeps_low_vector_score_with_keyword_hits():
    chunk = DocumentChunk(
        id="mysql-p5",
        text="8.乐观锁适合读多写少，悲观锁适合写多读少。乐观锁通过版本号或时间戳控制并发更新。",
        source="MySQL锁基础知识.pdf",
    )
    result = RetrievalResult(chunk=chunk, score=0.058, rank=1, reason="zilliz_vector_search")

    contexts = RuleBasedReranker().rerank("什么是乐观锁？", [result], top_k=5, threshold=0.08)

    assert len(contexts) == 1
    assert contexts[0].score >= 0.08


def test_baidu_location_to_coordinates():
    coordinates = location_to_coordinates({"left": 10, "top": 20, "width": 30, "height": 40})

    assert coordinates is not None
    assert (coordinates.x1, coordinates.y1, coordinates.x2, coordinates.y2) == (10, 20, 40, 60)


def test_baidu_pdf_response_to_chunks_merges_lines_by_page():
    adapter = BaiduOCRAdapter()
    chunks = adapter._response_to_chunks(
        {
            "words_result": [
                {"words": "MySQL 锁机制", "location": {"left": 1, "top": 2, "width": 30, "height": 4}},
                {"words": "包括共享锁和排他锁", "location": {"left": 5, "top": 12, "width": 40, "height": 8}},
            ]
        },
        source="locks.pdf",
        page=2,
        doc_type="PDF OCR",
        ingest_format="pdf_ocr",
    )

    assert len(chunks) == 1
    assert chunks[0].id == "locks.pdf:baidu-ocr:p2"
    assert chunks[0].text == "MySQL 锁机制\n包括共享锁和排他锁"
    assert chunks[0].page == 2
    assert chunks[0].block_id == "baidu-ocr-p2"
    assert chunks[0].coordinates is not None
    assert (chunks[0].coordinates.x1, chunks[0].coordinates.y1, chunks[0].coordinates.x2, chunks[0].coordinates.y2) == (1, 2, 45, 20)
    assert chunks[0].metadata["doc_type"] == "PDF OCR"
    assert chunks[0].metadata["ingest_format"] == "pdf_ocr"
    assert chunks[0].metadata["line_count"] == 2


def test_baidu_pdf_recognize_error_falls_back_to_rendered_image_ocr(monkeypatch):
    adapter = BaiduOCRAdapter()

    def fail_pdf(_pdf_bytes, page_number=1):
        raise RuntimeError("Baidu OCR error 216630: recognize error")

    def fake_render(_pdf_bytes, max_pages, dpi):
        assert max_pages == 2
        assert dpi == adapter.config.baidu_ocr_pdf_render_dpi
        yield 1, b"page-one-png"
        yield 2, b"page-two-png"

    responses = [
        {"words_result": [{"words": "第一页内容"}, {"words": "函数极限"}]},
        {"words_result": [{"words": "第二页内容"}, {"words": "导数积分"}]},
    ]

    monkeypatch.setattr(adapter, "recognize_pdf_bytes", fail_pdf)
    monkeypatch.setattr("manufacturing_rag.adapters.ocr.render_pdf_pages_to_png_bytes", fake_render)
    monkeypatch.setattr(adapter, "recognize_image_bytes", lambda _image_bytes: responses.pop(0))

    chunks = adapter.parse_pdf_bytes(b"pdf", source="math.pdf", max_pages=2)

    assert [chunk.id for chunk in chunks] == ["math.pdf:baidu-ocr:p1", "math.pdf:baidu-ocr:p2"]
    assert chunks[0].text == "第一页内容\n函数极限"
    assert chunks[1].text == "第二页内容\n导数积分"
    assert chunks[0].metadata["ingest_format"] == "pdf_rendered_image_ocr"


def test_baidu_pdf_later_page_error_falls_back_to_rendered_image_ocr(monkeypatch):
    adapter = BaiduOCRAdapter()

    def mixed_pdf(_pdf_bytes, page_number=1):
        if page_number == 1:
            return {"words_result": [{"words": "第一页PDF识别成功"}]}
        raise RuntimeError("Baidu OCR error 216630: recognize error")

    monkeypatch.setattr(adapter, "recognize_pdf_bytes", mixed_pdf)
    monkeypatch.setattr(
        "manufacturing_rag.adapters.ocr.render_pdf_pages_to_png_bytes",
        lambda _pdf_bytes, max_pages, dpi: [(1, b"page-one"), (2, b"page-two")],
    )
    monkeypatch.setattr(
        adapter,
        "recognize_image_bytes",
        lambda image_bytes: {"words_result": [{"words": f"rendered {image_bytes.decode('ascii')}"}]},
    )

    chunks = adapter.parse_pdf_bytes(b"pdf", source="math.pdf", max_pages=2)

    assert [chunk.text for chunk in chunks] == ["rendered page-one", "rendered page-two"]
    assert all(chunk.metadata["ingest_format"] == "pdf_rendered_image_ocr" for chunk in chunks)


def test_baidu_pdf_zero_page_limit_uses_actual_page_count(monkeypatch):
    adapter = BaiduOCRAdapter()
    requested_pages = []

    monkeypatch.setattr("manufacturing_rag.adapters.ocr.pdf_page_count", lambda _pdf_bytes: 3)

    def fake_pdf(_pdf_bytes, page_number=1):
        requested_pages.append(page_number)
        return {"words_result": [{"words": f"第 {page_number} 页"}]}

    monkeypatch.setattr(adapter, "recognize_pdf_bytes", fake_pdf)
    chunks = adapter.parse_pdf_bytes(b"pdf", source="all.pdf", max_pages=0)

    assert requested_pages == [1, 2, 3]
    assert [chunk.page for chunk in chunks] == [1, 2, 3]


def test_baidu_pdf_empty_later_page_renders_remaining_pages(monkeypatch):
    adapter = BaiduOCRAdapter()
    rendered_calls = []

    def fake_pdf(_pdf_bytes, page_number=1):
        if page_number <= 5:
            return {"words_result": [{"words": f"直传第 {page_number} 页"}]}
        return {"words_result": []}

    def fake_render(_pdf_bytes, max_pages, dpi, start_page=1):
        rendered_calls.append((max_pages, dpi, start_page))
        for page_number in range(start_page, max_pages + 1):
            yield page_number, f"page-{page_number}".encode("ascii")

    monkeypatch.setattr("manufacturing_rag.adapters.ocr.pdf_page_count", lambda _pdf_bytes: 8)
    monkeypatch.setattr(adapter, "recognize_pdf_bytes", fake_pdf)
    monkeypatch.setattr("manufacturing_rag.adapters.ocr.render_pdf_pages_to_png_bytes", fake_render)
    monkeypatch.setattr(
        adapter,
        "recognize_image_bytes",
        lambda image_bytes: {"words_result": [{"words": f"渲染{image_bytes.decode('ascii')}"}]},
    )

    chunks = adapter.parse_pdf_bytes(b"pdf", source="long.pdf", max_pages=0)

    assert [chunk.page for chunk in chunks] == list(range(1, 9))
    assert [chunk.text for chunk in chunks[:5]] == [f"直传第 {page_number} 页" for page_number in range(1, 6)]
    assert [chunk.text for chunk in chunks[5:]] == ["渲染page-6", "渲染page-7", "渲染page-8"]
    assert rendered_calls == [(8, adapter.config.baidu_ocr_pdf_render_dpi, 6)]


def test_render_pdf_zero_page_limit_renders_all_pages():
    fitz = pytest.importorskip("fitz")
    document = fitz.open()
    try:
        document.new_page()
        document.new_page()
        document.new_page()
        pdf_bytes = document.tobytes()
    finally:
        document.close()

    pages = list(render_pdf_pages_to_png_bytes(pdf_bytes, max_pages=0, dpi=96))

    assert [page_number for page_number, _image_bytes in pages] == [1, 2, 3]


def test_rendered_image_ocr_retries_lower_dpi(monkeypatch):
    adapter = BaiduOCRAdapter()
    attempts = []

    def fake_render(_pdf_bytes, max_pages, dpi):
        attempts.append(dpi)
        yield 1, f"dpi-{dpi}".encode("ascii")

    def fake_image_ocr(image_bytes):
        if image_bytes == b"dpi-150":
            raise RuntimeError("Baidu OCR error 216630: recognize error")
        return {"words_result": [{"words": "低DPI识别成功"}]}

    monkeypatch.setattr("manufacturing_rag.adapters.ocr.render_pdf_pages_to_png_bytes", fake_render)
    monkeypatch.setattr(adapter, "recognize_image_bytes", fake_image_ocr)

    chunks = adapter.parse_pdf_bytes_as_images(b"pdf", source="math.pdf", max_pages=1)

    assert attempts[:2] == [150, 120]
    assert chunks[0].text == "低DPI识别成功"
