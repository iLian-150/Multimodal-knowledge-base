from manufacturing_rag.adapters.embedding import HashEmbeddingAdapter
from manufacturing_rag.adapters.llm import RuleBasedLLMRouter
from manufacturing_rag.adapters.query_optimizer import AdaptiveQueryOptimizer
from manufacturing_rag.adapters.retriever import HybridRetriever, rrf_fuse_results
from manufacturing_rag.config import RAGConfig
from manufacturing_rag.pipeline import ManufacturingRAGPipeline
from manufacturing_rag.pdf_quality import chunks_have_unusable_pdf_text
from manufacturing_rag.schemas import DocumentChunk, EntityExtractionResult, RetrievalResult


def offline_config(**overrides):
    values = {
        "llm_provider": "rule",
        "embedding_provider": "hash",
        "rerank_provider": "rule",
        "vector_store_provider": "memory",
        "query_classifier_provider": "rule",
        "query_agent_provider": "rule",
        "redis_enabled": False,
        "mysql_enabled": False,
        "embedding_dimensions": 64,
        "debug_log_enabled": False,
    }
    values.update(overrides)
    return RAGConfig(**values)


def test_query_expansion_keeps_original_and_adds_semantic_variant():
    config = offline_config()
    optimizer = AdaptiveQueryOptimizer(RuleBasedLLMRouter(config), config)
    intent = optimizer.classify_intent("怎么退货")
    entities = optimizer.extract_entities("怎么退货")

    variants = optimizer.expand_queries("怎么退货", intent, entities)

    assert variants[0] == "怎么退货"
    assert any("售后申请" in variant for variant in variants[1:])


def test_child_index_excludes_parent_context_from_embedding_input():
    class RecordingEmbedding:
        def __init__(self):
            self.texts = []

        def embed_text(self, text):
            self.texts.append(text)
            return [1.0, 0.0]

        def embed_sparse(self, text):
            return {"target": 1.0}

    embedding = RecordingEmbedding()
    chunk = DocumentChunk(
        id="child",
        text="子块目标内容",
        source="lesson.pdf",
        metadata={"parent_text": "父块包含不应进入索引的长上下文"},
        parent_id="parent",
    )

    HybridRetriever([chunk], embedding=embedding, config=offline_config())

    assert embedding.texts == ["子块目标内容 lesson.pdf"]


def test_hybrid_retrieval_reports_rank_fusion_and_query_routes():
    config = offline_config()
    chunks = [
        DocumentChunk(id="target", text="矩阵可逆的充要条件是行列式不等于零。", source="linear.pdf"),
        DocumentChunk(id="other", text="函数极限描述函数值的变化趋势。", source="calculus.pdf"),
    ]
    retriever = HybridRetriever(chunks, embedding=HashEmbeddingAdapter(config), config=config)
    entities = EntityExtractionResult(raw_query="矩阵可逆条件")

    results = retriever.search_many(["矩阵可逆条件", "矩阵行列式 充要条件"], entities, limit=2)

    assert results[0].chunk.id == "target"
    assert "rrf_routes=" in results[0].reason


def test_rrf_prefers_items_retrieved_by_multiple_routes():
    first = DocumentChunk(id="first", text="first", source="a")
    second = DocumentChunk(id="second", text="second", source="b")
    results = rrf_fuse_results(
        [
            [RetrievalResult(first, 0.99), RetrievalResult(second, 0.98)],
            [RetrievalResult(first, 0.10), RetrievalResult(second, 0.09)],
        ],
        limit=2,
    )

    assert results[0].chunk.id == "first"
    assert results[0].reason.count("@") == 2


def test_pipeline_exposes_multi_query_plan_and_answers_from_parent_context():
    config = offline_config(parent_chunk_chars=80, child_chunk_chars=30, child_chunk_overlap=5)
    raw = DocumentChunk(
        id="lesson",
        text="退货申请需要进入售后页面提交，审核通过后安排退换货。补充说明用于保留父级上下文。",
        source="policy.txt",
    )
    from manufacturing_rag.chunking import prepare_chunks

    chunks, _ = prepare_chunks([raw], config)
    response = ManufacturingRAGPipeline(chunks, config=config).answer("怎么退货")

    assert response.query_variants[0] == "怎么退货"
    assert any("售后申请" in variant for variant in response.query_variants)
    assert response.sources
    assert response.sources[0].chunk_level == "parent_context"


def test_pdf_quality_does_not_hide_a_bad_page_in_document_average():
    chunks = [
        DocumentChunk(id="good", text="这是一段足够长且正常的中文 PDF 文本，用来描述课程规则和学习要求。", source="book.pdf", page=1),
        DocumentChunk(id="bad", text="ѧ���ֲ� � � � � � � � � � � � � � � � � � � � � � �", source="book.pdf", page=2),
    ]

    assert chunks_have_unusable_pdf_text(chunks) is True
