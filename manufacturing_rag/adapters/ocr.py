"""OCR structured data ingestion and Baidu Intelligent Cloud OCR adapter.

The MVP accepts already structured OCR JSONL records. Production deployments can
use BaiduOCRAdapter to convert image files into traceable DocumentChunk records.
"""

from __future__ import annotations

import base64
import json
import os
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional

from manufacturing_rag.config import DEFAULT_CONFIG, RAGConfig
from manufacturing_rag.debug_log import write_debug_log
from manufacturing_rag.resilience import retry_call
from manufacturing_rag.schemas import Coordinates, DocumentChunk


class OCRStructuredLoader:
    """Load OCR-structured text/image chunks from JSONL."""

    def load_jsonl(self, path: str) -> List[DocumentChunk]:
        records: List[DocumentChunk] = []
        file_path = Path(path)
        with file_path.open("r", encoding="utf-8-sig") as handle:
            for line_number, line in enumerate(handle, start=1):
                stripped = line.strip().lstrip("\ufeff")
                if not stripped:
                    continue
                try:
                    payload = json.loads(stripped)
                    records.append(DocumentChunk.from_mapping(payload))
                except Exception as exc:
                    raise ValueError(f"invalid OCR JSONL record at {file_path}:{line_number}: {exc}") from exc
        return records

    def load_many(self, paths: Iterable[str]) -> List[DocumentChunk]:
        chunks: List[DocumentChunk] = []
        for path in paths:
            chunks.extend(self.load_jsonl(path))
        return chunks


class BaiduOCRAdapter:
    """Baidu Intelligent Cloud OCR adapter for image and PDF files."""

    image_suffixes = {".jpg", ".jpeg", ".png", ".bmp", ".webp", ".tif", ".tiff"}

    def __init__(self, config: RAGConfig = DEFAULT_CONFIG) -> None:
        self.config = config
        self.api_key = os.getenv(config.baidu_ocr_api_key_env, "").strip()
        self.secret_key = os.getenv(config.baidu_ocr_secret_key_env, "").strip()
        self._access_token: Optional[str] = None

    def parse_file(self, path: str) -> List[DocumentChunk]:
        file_path = Path(path)
        if file_path.suffix.lower() not in self.image_suffixes:
            raise ValueError("BaiduOCRAdapter currently supports image files; convert PDF pages to images before OCR")
        response = self.recognize_image(file_path)
        return self._response_to_chunks(response, source=str(file_path))

    def parse_image_bytes(self, image_bytes: bytes, source: str) -> List[DocumentChunk]:
        response = self.recognize_image_bytes(image_bytes)
        return self._response_to_chunks(response, source=source, doc_type="图片OCR", ingest_format="image")

    def parse_pdf_bytes(
        self,
        pdf_bytes: bytes,
        source: str,
        max_pages: Optional[int] = None,
        render_dpi: Optional[int] = None,
    ) -> List[DocumentChunk]:
        requested_pages = self.config.baidu_ocr_pdf_max_pages if max_pages is None else int(max_pages)
        page_count = pdf_page_count(pdf_bytes) if requested_pages <= 0 else max(1, requested_pages)
        chunks: List[DocumentChunk] = []
        for page_number in range(1, page_count + 1):
            try:
                response = self.recognize_pdf_bytes(pdf_bytes, page_number=page_number)
            except RuntimeError as exc:
                if is_baidu_recognize_error(exc):
                    write_debug_log(
                        self.config,
                        "baidu_pdf_ocr_direct_error",
                        source=source,
                        page=page_number,
                        error=str(exc),
                        fallback="rendered_image_ocr",
                    )
                    return self.parse_pdf_bytes_as_images(pdf_bytes, source=source, max_pages=page_count, render_dpi=render_dpi)
                raise
            page_chunks = self._response_to_chunks(
                response,
                source=source,
                page=page_number,
                doc_type="PDF OCR",
                ingest_format="pdf_ocr",
            )
            if not page_chunks:
                write_debug_log(
                    self.config,
                    "baidu_pdf_ocr_empty_page_fallback",
                    source=source,
                    page=page_number,
                    expected_pages=page_count,
                    fallback="rendered_image_ocr",
                )
                remaining_chunks = self.parse_pdf_bytes_as_images(
                    pdf_bytes,
                    source=source,
                    max_pages=page_count,
                    render_dpi=render_dpi,
                    start_page=page_number,
                )
                return chunks + remaining_chunks
            chunks.extend(page_chunks)
        return chunks

    def parse_pdf_bytes_as_images(
        self,
        pdf_bytes: bytes,
        source: str,
        max_pages: Optional[int] = None,
        render_dpi: Optional[int] = None,
        start_page: int = 1,
    ) -> List[DocumentChunk]:
        page_count = self.config.baidu_ocr_pdf_max_pages if max_pages is None else int(max_pages)
        first_page = max(1, int(start_page))
        preferred_dpi = int(render_dpi or self.config.baidu_ocr_pdf_render_dpi)
        dpi_candidates = unique_keep_order([preferred_dpi, 120, 96])
        last_error: Optional[RuntimeError] = None
        for dpi in dpi_candidates:
            chunks: List[DocumentChunk] = []
            write_debug_log(
                self.config,
                "pdf_rendered_image_ocr_attempt",
                source=source,
                max_pages=page_count,
                start_page=first_page,
                dpi=dpi,
            )
            try:
                render_kwargs = {"max_pages": page_count, "dpi": dpi}
                if first_page > 1:
                    render_kwargs["start_page"] = first_page
                for page_number, image_bytes in render_pdf_pages_to_png_bytes(pdf_bytes, **render_kwargs):
                    write_debug_log(
                        self.config,
                        "pdf_rendered_image_ocr_page",
                        source=source,
                        page=page_number,
                        dpi=dpi,
                        image_bytes=len(image_bytes),
                    )
                    response = self.recognize_image_bytes(image_bytes)
                    page_chunks = self._response_to_chunks(
                        response,
                        source=source,
                        page=page_number,
                        doc_type="PDF OCR",
                        ingest_format="pdf_rendered_image_ocr",
                    )
                    chunks.extend(page_chunks)
                return chunks
            except RuntimeError as exc:
                if not is_baidu_recognize_error(exc):
                    raise
                last_error = exc
                write_debug_log(
                    self.config,
                    "pdf_rendered_image_ocr_attempt_failed",
                    source=source,
                    dpi=dpi,
                    error=str(exc),
                )
        if last_error:
            write_debug_log(
                self.config,
                "pdf_rendered_image_ocr_all_failed",
                source=source,
                dpi_candidates=dpi_candidates,
                error=str(last_error),
            )
            raise last_error
        return []

    def recognize_image(self, path: Path) -> Dict[str, Any]:
        return self.recognize_image_bytes(path.read_bytes())

    def recognize_image_bytes(self, image_bytes: bytes) -> Dict[str, Any]:
        if not self.api_key or not self.secret_key:
            raise RuntimeError(
                f"Baidu OCR credentials missing: set {self.config.baidu_ocr_api_key_env} and {self.config.baidu_ocr_secret_key_env}"
            )
        image_base64 = base64.b64encode(image_bytes).decode("ascii")
        payload = urllib.parse.urlencode({"image": image_base64}).encode("utf-8")
        url = self._ocr_url_with_token()
        request = urllib.request.Request(
            url,
            data=payload,
            headers={"Content-Type": "application/x-www-form-urlencoded"},
            method="POST",
        )
        return self._open_json(request, timeout=self.config.baidu_ocr_timeout_seconds)

    def recognize_pdf_bytes(self, pdf_bytes: bytes, page_number: int = 1) -> Dict[str, Any]:
        if not self.api_key or not self.secret_key:
            raise RuntimeError(
                f"Baidu OCR credentials missing: set {self.config.baidu_ocr_api_key_env} and {self.config.baidu_ocr_secret_key_env}"
            )
        pdf_base64 = base64.b64encode(pdf_bytes).decode("ascii")
        payload = urllib.parse.urlencode({"pdf_file": pdf_base64, "pdf_file_num": page_number}).encode("utf-8")
        request = urllib.request.Request(
            self._ocr_url_with_token(),
            data=payload,
            headers={"Content-Type": "application/x-www-form-urlencoded"},
            method="POST",
        )
        return self._open_json(request, timeout=self.config.baidu_ocr_timeout_seconds)

    def get_access_token(self) -> str:
        if self._access_token:
            return self._access_token
        payload = urllib.parse.urlencode(
            {
                "grant_type": "client_credentials",
                "client_id": self.api_key,
                "client_secret": self.secret_key,
            }
        ).encode("utf-8")
        request = urllib.request.Request(
            self.config.baidu_ocr_token_url,
            data=payload,
            headers={"Content-Type": "application/x-www-form-urlencoded"},
            method="POST",
        )
        data = self._open_json(request, timeout=self.config.baidu_ocr_timeout_seconds)
        token = str(data.get("access_token") or "").strip()
        if not token:
            raise RuntimeError("Baidu OCR token response missing access_token")
        self._access_token = token
        return token

    def _ocr_url_with_token(self) -> str:
        separator = "&" if "?" in self.config.baidu_ocr_endpoint else "?"
        return f"{self.config.baidu_ocr_endpoint}{separator}access_token={urllib.parse.quote(self.get_access_token())}"

    def _open_json(self, request: urllib.request.Request, timeout: float) -> Dict[str, Any]:
        def execute() -> str:
            try:
                with urllib.request.urlopen(request, timeout=timeout) as response:
                    return response.read().decode("utf-8")
            except urllib.error.HTTPError as exc:
                detail = exc.read().decode("utf-8", errors="replace")[:500]
                raise RuntimeError(f"Baidu OCR HTTP {exc.code}: {detail}") from exc
            except urllib.error.URLError as exc:
                raise RuntimeError(f"Baidu OCR network error: {exc.reason}") from exc

        raw = retry_call(execute, self.config.retry_attempts, self.config.retry_base_seconds)
        data = json.loads(raw)
        if not isinstance(data, dict):
            raise RuntimeError("Baidu OCR response must be a JSON object")
        if data.get("error_code"):
            raise RuntimeError(f"Baidu OCR error {data.get('error_code')}: {data.get('error_msg')}")
        return data

    def _response_to_chunks(
        self,
        response: Dict[str, Any],
        source: str,
        page: int = 1,
        doc_type: str = "图片OCR",
        ingest_format: str = "image",
    ) -> List[DocumentChunk]:
        words_result = response.get("words_result") or []
        page_lines: List[str] = []
        page_coordinates: List[Coordinates] = []
        for index, item in enumerate(words_result, start=1):
            if not isinstance(item, dict):
                continue
            text = str(item.get("words") or "").strip()
            if not text:
                continue
            page_lines.append(text)
            location = item.get("location") if isinstance(item.get("location"), dict) else {}
            coordinates = location_to_coordinates(location)
            if coordinates:
                page_coordinates.append(coordinates)
        if not page_lines:
            return []
        return [
            DocumentChunk(
                id=f"{Path(source).name}:baidu-ocr:p{page}",
                text="\n".join(page_lines),
                source=source,
                page=page,
                block_id=f"baidu-ocr-p{page}",
                modality="ocr_text",
                coordinates=merge_coordinates(page_coordinates),
                metadata={
                    "doc_type": doc_type,
                    "ingest_format": ingest_format,
                    "ocr_provider": "baidu",
                    "line_count": len(page_lines),
                },
            )
        ]


class PaddleOCRAdapter:
    """Lazy PaddleOCR adapter with traceable boxes and confidence metadata."""

    image_suffixes = BaiduOCRAdapter.image_suffixes

    def __init__(self, config: RAGConfig = DEFAULT_CONFIG) -> None:
        self.config = config
        self._engine: Any = None

    def parse_file(self, path: str) -> List[DocumentChunk]:
        file_path = Path(path)
        suffix = file_path.suffix.lower()
        if suffix == ".pdf":
            chunks: List[DocumentChunk] = []
            for page, image_bytes in render_pdf_pages_to_png_bytes(
                file_path.read_bytes(),
                max_pages=self.config.baidu_ocr_pdf_max_pages,
                dpi=self.config.baidu_ocr_pdf_render_dpi,
            ):
                chunks.extend(self.parse_image_bytes(image_bytes, source=str(file_path), page=page))
            return chunks
        if suffix not in self.image_suffixes:
            raise ValueError(f"PaddleOCR does not support file type: {suffix or '<none>'}")
        return self._parse_input(str(file_path), source=str(file_path), page=1)

    def parse_image_bytes(self, image_bytes: bytes, source: str, page: int = 1) -> List[DocumentChunk]:
        try:
            from io import BytesIO

            import numpy as np  # type: ignore[import-not-found]
            from PIL import Image  # type: ignore[import-not-found]
        except ImportError as exc:
            raise RuntimeError("PaddleOCR byte input requires numpy and Pillow") from exc
        image = np.asarray(Image.open(BytesIO(image_bytes)).convert("RGB"))
        return self._parse_input(image, source=source, page=page)

    def _engine_instance(self):
        if self._engine is not None:
            return self._engine
        try:
            from paddleocr import PaddleOCR  # type: ignore[import-not-found]
        except ImportError as exc:
            raise RuntimeError("PaddleOCR is not installed; install the production requirements") from exc
        try:
            self._engine = PaddleOCR(
                lang=self.config.paddle_ocr_language,
                use_doc_orientation_classify=True,
                use_doc_unwarping=True,
                use_textline_orientation=True,
            )
        except (TypeError, ValueError):
            self._engine = PaddleOCR(
                lang=self.config.paddle_ocr_language,
                use_angle_cls=True,
                use_gpu=self.config.paddle_ocr_use_gpu,
            )
        return self._engine

    def _parse_input(self, value: Any, source: str, page: int) -> List[DocumentChunk]:
        engine = self._engine_instance()
        if hasattr(engine, "predict"):
            raw = list(engine.predict(input=value))
        else:
            raw = engine.ocr(value, cls=True)
        lines = normalize_paddle_result(raw)
        if not lines:
            return []
        texts = [line[0] for line in lines]
        scores = [line[1] for line in lines]
        boxes = [line[2] for line in lines if line[2] is not None]
        return [
            DocumentChunk(
                id=f"{Path(source).name}:paddle-ocr:p{page}",
                text="\n".join(texts),
                source=source,
                page=page,
                block_id=f"paddle-ocr-p{page}",
                modality="ocr_text",
                coordinates=merge_coordinates(boxes),
                metadata={
                    "doc_type": "PDF OCR" if str(source).lower().endswith(".pdf") else "图片OCR",
                    "ingest_format": "paddle_ocr",
                    "ocr_provider": "paddleocr",
                    "line_count": len(lines),
                    "line_confidences": [round(score, 4) for score in scores],
                },
                confidence=sum(scores) / max(len(scores), 1),
            )
        ]


def normalize_paddle_result(raw: Any) -> List[tuple[str, float, Optional[Coordinates]]]:
    """Normalize PaddleOCR 2.x and 3.x results to text, score and bounding boxes."""

    lines: List[tuple[str, float, Optional[Coordinates]]] = []
    for result in raw or []:
        payload = getattr(result, "json", None)
        if callable(payload):
            payload = payload()
        if isinstance(payload, dict):
            payload = payload.get("res", payload)
            texts = payload.get("rec_texts") or []
            scores = payload.get("rec_scores") or []
            boxes = payload.get("rec_boxes") or payload.get("dt_polys") or []
            for index, text in enumerate(texts):
                cleaned = str(text or "").strip()
                if cleaned:
                    lines.append((cleaned, safe_confidence(scores, index), paddle_box_to_coordinates(boxes, index)))
            continue
        page_rows = result if isinstance(result, list) else []
        if page_rows and len(page_rows) == 1 and isinstance(page_rows[0], list) and page_rows[0] and isinstance(page_rows[0][0], list):
            page_rows = page_rows[0]
        for row in page_rows:
            if not isinstance(row, (list, tuple)) or len(row) < 2:
                continue
            recognition = row[1]
            if not isinstance(recognition, (list, tuple)) or not recognition:
                continue
            text = str(recognition[0] or "").strip()
            if text:
                score = float(recognition[1]) if len(recognition) > 1 else 1.0
                lines.append((text, score, polygon_to_coordinates(row[0])))
    return lines


def safe_confidence(values: Any, index: int) -> float:
    try:
        return float(values[index])
    except (IndexError, TypeError, ValueError):
        return 1.0


def paddle_box_to_coordinates(boxes: Any, index: int) -> Optional[Coordinates]:
    try:
        box = boxes[index]
    except (IndexError, TypeError):
        return None
    if isinstance(box, (list, tuple)) and len(box) == 4 and all(isinstance(item, (int, float)) for item in box):
        return Coordinates(*(int(item) for item in box))
    return polygon_to_coordinates(box)


def polygon_to_coordinates(polygon: Any) -> Optional[Coordinates]:
    if not isinstance(polygon, (list, tuple)):
        return None
    points = [point for point in polygon if isinstance(point, (list, tuple)) and len(point) >= 2]
    if not points:
        return None
    try:
        xs = [int(point[0]) for point in points]
        ys = [int(point[1]) for point in points]
    except (TypeError, ValueError):
        return None
    return Coordinates(min(xs), min(ys), max(xs), max(ys))


def location_to_coordinates(location: Dict[str, Any]) -> Optional[Coordinates]:
    if not location:
        return None
    try:
        left = int(location.get("left", 0))
        top = int(location.get("top", 0))
        width = int(location.get("width", 0))
        height = int(location.get("height", 0))
    except (TypeError, ValueError):
        return None
    if width <= 0 or height <= 0:
        return None
    return Coordinates(left, top, left + width, top + height)


def merge_coordinates(coordinates: List[Coordinates]) -> Optional[Coordinates]:
    if not coordinates:
        return None
    return Coordinates(
        min(item.x1 for item in coordinates),
        min(item.y1 for item in coordinates),
        max(item.x2 for item in coordinates),
        max(item.y2 for item in coordinates),
    )


def is_baidu_recognize_error(exc: RuntimeError) -> bool:
    message = str(exc)
    return "216630" in message or "recognize error" in message.lower()


def unique_keep_order(values: Iterable[int]) -> List[int]:
    seen = set()
    result: List[int] = []
    for value in values:
        number = int(value)
        if number in seen:
            continue
        seen.add(number)
        result.append(number)
    return result


def pdf_page_count(pdf_bytes: bytes) -> int:
    try:
        import fitz  # type: ignore[import-not-found]
    except ImportError as exc:
        raise RuntimeError("PyMuPDF is required for rendered PDF OCR fallback; install PyMuPDF") from exc
    document = fitz.open(stream=pdf_bytes, filetype="pdf")
    try:
        return max(1, int(document.page_count))
    finally:
        document.close()


def render_pdf_pages_to_png_bytes(
    pdf_bytes: bytes,
    max_pages: int,
    dpi: int,
    start_page: int = 1,
) -> Iterable[tuple[int, bytes]]:
    try:
        import fitz  # type: ignore[import-not-found]
    except ImportError as exc:
        raise RuntimeError("PyMuPDF is required for rendered PDF OCR fallback; install PyMuPDF") from exc
    document = fitz.open(stream=pdf_bytes, filetype="pdf")
    try:
        page_total = document.page_count if int(max_pages) <= 0 else min(int(max_pages), document.page_count)
        first_page_index = min(max(int(start_page) - 1, 0), page_total)
        zoom = max(dpi, 72) / 72.0
        matrix = fitz.Matrix(zoom, zoom)
        for page_index in range(first_page_index, page_total):
            page = document.load_page(page_index)
            pixmap = page.get_pixmap(matrix=matrix, alpha=False)
            try:
                yield page_index + 1, pixmap.tobytes("png")
            finally:
                pixmap = None
    finally:
        document.close()
