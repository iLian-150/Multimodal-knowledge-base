"""Adapters for the education multimodal RAG architecture."""

from manufacturing_rag.adapters.embedding import (
    BGEM3EmbeddingAdapter,
    BailianEmbeddingAdapter,
    HashEmbeddingAdapter,
    build_embedding_adapter,
)
from manufacturing_rag.adapters.ocr import BaiduOCRAdapter, OCRStructuredLoader, PaddleOCRAdapter
from manufacturing_rag.adapters.query_optimizer import AdaptiveQueryOptimizer
from manufacturing_rag.adapters.rerank import BailianReranker, CrossEncoderReranker, RuleBasedReranker, build_reranker
from manufacturing_rag.adapters.retriever import HybridRetriever, InMemoryMultimodalRetriever, MilvusHybridRetriever
from manufacturing_rag.adapters.vector_store import MilvusVectorStore
from manufacturing_rag.adapters.vision import QwenVLAdapter

__all__ = [
    "AdaptiveQueryOptimizer",
    "BGEM3EmbeddingAdapter",
    "BaiduOCRAdapter",
    "BailianEmbeddingAdapter",
    "BailianReranker",
    "CrossEncoderReranker",
    "HashEmbeddingAdapter",
    "HybridRetriever",
    "InMemoryMultimodalRetriever",
    "MilvusHybridRetriever",
    "MilvusVectorStore",
    "OCRStructuredLoader",
    "PaddleOCRAdapter",
    "QwenVLAdapter",
    "RuleBasedReranker",
    "build_embedding_adapter",
    "build_reranker",
]
