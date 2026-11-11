"""Parent-child chunking and confidence validation for multimodal ETL."""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Iterable, List

from manufacturing_rag.config import DEFAULT_CONFIG, RAGConfig
from manufacturing_rag.schemas import DocumentChunk


@dataclass(frozen=True)
class ETLValidationReport:
    total_chunks: int
    review_chunks: int
    rejected_chunks: int

    def to_dict(self) -> dict[str, int]:
        return {
            "total_chunks": self.total_chunks,
            "review_chunks": self.review_chunks,
            "rejected_chunks": self.rejected_chunks,
        }


class HierarchicalChunker:
    """Create small retrieval children while retaining their larger parent context."""

    def __init__(self, config: RAGConfig = DEFAULT_CONFIG) -> None:
        self.config = config
        if config.child_chunk_overlap >= config.child_chunk_chars:
            raise ValueError("child chunk overlap must be smaller than child chunk size")

    def transform(self, chunks: Iterable[DocumentChunk]) -> List[DocumentChunk]:
        transformed: List[DocumentChunk] = []
        for raw in chunks:
            transformed.extend(self._transform_one(raw))
        return transformed

    def _transform_one(self, raw: DocumentChunk) -> List[DocumentChunk]:
        parents = split_natural(raw.text, self.config.parent_chunk_chars, overlap=0)
        children: List[DocumentChunk] = []
        for parent_index, parent_text in enumerate(parents, start=1):
            parent_id = f"{raw.id}:parent:{parent_index}"
            child_texts = split_natural(
                parent_text,
                self.config.child_chunk_chars,
                overlap=self.config.child_chunk_overlap,
            )
            for child_index, child_text in enumerate(child_texts, start=1):
                preserve_original_id = len(parents) == 1 and len(child_texts) == 1
                chunk_id = raw.id if preserve_original_id else f"{raw.id}:p{parent_index}:c{child_index}"
                metadata = dict(raw.metadata)
                metadata.update(
                    {
                        "parent_id": parent_id,
                        "parent_text": parent_text,
                        "chunk_level": "child",
                        "parent_index": parent_index,
                        "child_index": child_index,
                        "confidence": raw.confidence,
                        "needs_review": raw.needs_review,
                    }
                )
                children.append(
                    DocumentChunk(
                        id=chunk_id,
                        text=child_text,
                        source=raw.source,
                        page=raw.page,
                        block_id=raw.block_id if preserve_original_id else f"{raw.block_id or raw.id}-c{child_index}",
                        modality=raw.modality,
                        coordinates=raw.coordinates,
                        metadata=metadata,
                        image_path=raw.image_path,
                        parent_id=parent_id,
                        chunk_level="child",
                        confidence=raw.confidence,
                        needs_review=raw.needs_review,
                    )
                )
        return children


class ConfidenceValidator:
    """Mark low-quality OCR chunks for review without silently losing source data."""

    def __init__(self, config: RAGConfig = DEFAULT_CONFIG) -> None:
        self.threshold = config.min_etl_confidence

    def validate(self, chunks: Iterable[DocumentChunk]) -> tuple[List[DocumentChunk], ETLValidationReport]:
        accepted: List[DocumentChunk] = []
        review_count = 0
        rejected_count = 0
        for chunk in chunks:
            text = normalize_document_text(chunk.text)
            if not text:
                rejected_count += 1
                continue
            confidence = min(1.0, max(0.0, float(chunk.confidence)))
            needs_review = chunk.needs_review or confidence < self.threshold or replacement_ratio(text) >= 0.08
            if needs_review:
                review_count += 1
            metadata = dict(chunk.metadata)
            metadata.update({"confidence": confidence, "needs_review": needs_review})
            accepted.append(
                DocumentChunk(
                    id=chunk.id,
                    text=text,
                    source=chunk.source,
                    page=chunk.page,
                    block_id=chunk.block_id,
                    modality=chunk.modality,
                    coordinates=chunk.coordinates,
                    metadata=metadata,
                    image_path=chunk.image_path,
                    parent_id=chunk.parent_id,
                    chunk_level=chunk.chunk_level,
                    confidence=confidence,
                    needs_review=needs_review,
                )
            )
        return accepted, ETLValidationReport(len(accepted), review_count, rejected_count)


def normalize_document_text(text: str) -> str:
    lines = [re.sub(r"[ \t]+", " ", line).strip() for line in str(text or "").splitlines()]
    return "\n".join(line for line in lines if line).strip()


def replacement_ratio(text: str) -> float:
    suspicious = text.count("�") + text.count("?")
    return suspicious / max(len(text), 1)


def split_natural(text: str, max_chars: int, overlap: int = 0) -> List[str]:
    """Split on paragraphs/sentences first and use a bounded sliding window as fallback."""

    normalized = normalize_document_text(text)
    if not normalized:
        return []
    if len(normalized) <= max_chars:
        return [normalized]
    units = [item.strip() for item in re.split(r"(?<=[。！？.!?；;])|\n+", normalized) if item.strip()]
    chunks: List[str] = []
    current = ""
    for unit in units:
        if len(unit) > max_chars:
            if current:
                chunks.append(current)
                current = ""
            step = max(1, max_chars - overlap)
            chunks.extend(unit[start : start + max_chars] for start in range(0, len(unit), step))
            continue
        candidate = f"{current}\n{unit}".strip() if current else unit
        if len(candidate) <= max_chars:
            current = candidate
            continue
        chunks.append(current)
        prefix_length = min(overlap, max(0, max_chars - len(unit)))
        prefix = current[-prefix_length:] if prefix_length else ""
        current = f"{prefix}{unit}"
    if current:
        chunks.append(current)
    return [chunk for chunk in chunks if chunk]


def prepare_chunks(chunks: Iterable[DocumentChunk], config: RAGConfig = DEFAULT_CONFIG) -> tuple[List[DocumentChunk], ETLValidationReport]:
    validated, report = ConfidenceValidator(config).validate(chunks)
    return HierarchicalChunker(config).transform(validated), report
