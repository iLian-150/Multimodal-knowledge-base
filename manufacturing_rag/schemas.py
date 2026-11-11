"""Typed data contracts used across the manufacturing RAG pipeline."""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import asdict, dataclass, field
from typing import Any, Dict, List, Optional


DEFAULT_WORKSPACE_ID = "campus-default"


@dataclass(frozen=True)
class Coordinates:
    """OCR bounding box in page or image pixel coordinates."""

    x1: int
    y1: int
    x2: int
    y2: int

    @classmethod
    def from_value(cls, value: Any) -> Optional["Coordinates"]:
        if value is None:
            return None
        if isinstance(value, cls):
            return value
        if isinstance(value, dict):
            keys = ("x1", "y1", "x2", "y2")
            if all(key in value for key in keys):
                return cls(*(int(value[key]) for key in keys))
        if isinstance(value, Sequence) and not isinstance(value, (str, bytes)) and len(value) == 4:
            return cls(*(int(item) for item in value))
        raise ValueError("coordinates must be a dict or a 4-item sequence")


@dataclass
class SourceRef:
    """Traceable source metadata attached to retrieved context and answers."""

    document_id: str
    source_path: str
    page: Optional[int] = None
    block_id: Optional[str] = None
    modality: str = "ocr_text"
    coordinates: Optional[Coordinates] = None
    score: Optional[float] = None
    parent_id: Optional[str] = None
    chunk_level: str = "child"
    metadata: Dict[str, Any] = field(default_factory=dict)

    def label(self) -> str:
        parts = [self.source_path or self.document_id]
        if self.page is not None:
            parts.append(f"页码:{self.page}")
        if self.block_id:
            parts.append(f"块:{self.block_id}")
        if self.modality:
            parts.append(f"模态:{self.modality}")
        return " | ".join(parts)

    def to_dict(self) -> Dict[str, Any]:
        return asdict(self)


@dataclass
class DocumentChunk:
    """Single document-indexed knowledge unit."""

    id: str
    text: str
    source: str
    page: Optional[int] = None
    block_id: Optional[str] = None
    modality: str = "ocr_text"
    coordinates: Optional[Coordinates] = None
    metadata: Dict[str, Any] = field(default_factory=dict)
    image_path: Optional[str] = None
    parent_id: Optional[str] = None
    chunk_level: str = "child"
    confidence: float = 1.0
    needs_review: bool = False

    @classmethod
    def from_mapping(cls, payload: Dict[str, Any]) -> "DocumentChunk":
        text = str(payload.get("text") or payload.get("content") or "").strip()
        if not text:
            raise ValueError("document chunk requires non-empty text/content")
        chunk_id = str(payload.get("id") or payload.get("chunk_id") or payload.get("block_id") or "")
        source = str(payload.get("source") or payload.get("source_path") or payload.get("document") or "unknown")
        if not chunk_id:
            chunk_id = f"{source}:{payload.get('page', '')}:{payload.get('block_id', '')}:{hash(text)}"
        metadata = dict(payload.get("metadata") or {})
        try:
            confidence = float(payload.get("confidence", metadata.get("confidence", 1.0)) or 1.0)
        except (TypeError, ValueError):
            confidence = 1.0
        return cls(
            id=chunk_id,
            text=text,
            source=source,
            page=payload.get("page"),
            block_id=payload.get("block_id"),
            modality=str(payload.get("modality") or "ocr_text"),
            coordinates=Coordinates.from_value(payload.get("coordinates")),
            metadata=metadata,
            image_path=payload.get("image_path"),
            parent_id=payload.get("parent_id") or metadata.get("parent_id"),
            chunk_level=str(payload.get("chunk_level") or metadata.get("chunk_level") or "child"),
            confidence=confidence,
            needs_review=bool(payload.get("needs_review", metadata.get("needs_review", False))),
        )

    def to_source_ref(self, score: Optional[float] = None) -> SourceRef:
        return SourceRef(
            document_id=self.id,
            source_path=self.source,
            page=self.page,
            block_id=self.block_id,
            modality=self.modality,
            coordinates=self.coordinates,
            score=score,
            parent_id=self.parent_id,
            chunk_level=self.chunk_level,
            metadata=dict(self.metadata),
        )


@dataclass
class IntentResult:
    category: str
    allowed: bool
    confidence: float
    reason: str = ""
    difficulty: str = "simple"
    query_strategy: str = "direct"

    def to_dict(self) -> Dict[str, Any]:
        return asdict(self)


@dataclass
class SafetyResult:
    allowed: bool
    risk_level: str
    risk_types: List[str] = field(default_factory=list)
    reason: str = ""

    def to_dict(self) -> Dict[str, Any]:
        return asdict(self)


@dataclass
class EntityExtractionResult:
    raw_query: str
    entities: Dict[str, List[str]] = field(default_factory=dict)

    def to_dict(self) -> Dict[str, Any]:
        return asdict(self)


@dataclass
class RetrievalResult:
    chunk: DocumentChunk
    score: float
    rank: int = 0
    reason: str = ""

    def to_source_ref(self) -> SourceRef:
        return self.chunk.to_source_ref(score=self.score)


@dataclass
class HallucinationCheck:
    passed: bool = True
    issues: List[str] = field(default_factory=list)
    confidence: float = 1.0

    def to_dict(self) -> Dict[str, Any]:
        return asdict(self)


@dataclass
class RAGResponse:
    question: str
    answer: str
    intent: IntentResult
    safety: SafetyResult
    optimized_query: str = ""
    entities: EntityExtractionResult = field(default_factory=lambda: EntityExtractionResult(raw_query=""))
    sources: List[SourceRef] = field(default_factory=list)
    retrieval_confidence: float = 0.0
    hallucination_check: HallucinationCheck = field(default_factory=HallucinationCheck)
    redacted: bool = False
    notices: List[str] = field(default_factory=list)
    cache_hit: bool = False
    query_variants: List[str] = field(default_factory=list)

    def to_dict(self) -> Dict[str, Any]:
        return {
            "question": self.question,
            "answer": self.answer,
            "intent": self.intent.to_dict(),
            "safety": self.safety.to_dict(),
            "optimized_query": self.optimized_query,
            "query_variants": list(self.query_variants),
            "entities": self.entities.to_dict(),
            "sources": [source.to_dict() for source in self.sources],
            "retrieval_confidence": self.retrieval_confidence,
            "hallucination_check": self.hallucination_check.to_dict(),
            "redacted": self.redacted,
            "notices": list(self.notices),
            "cache_hit": self.cache_hit,
        }
