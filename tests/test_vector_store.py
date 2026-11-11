from manufacturing_rag.adapters.vector_store import MilvusVectorStore
from manufacturing_rag.config import RAGConfig
from manufacturing_rag.adapters.vector_store import hybrid_candidate_limit
from manufacturing_rag.schemas import EntityExtractionResult


def test_milvus_status_without_env_is_safe():
    config = RAGConfig(zilliz_endpoint_env="MISSING_ZILLIZ_ENDPOINT", zilliz_token_env="MISSING_ZILLIZ_TOKEN")
    status = MilvusVectorStore(config=config).status().to_dict()

    assert status["provider"] == "milvus"
    assert status["connected"] is False
    assert status["endpoint_configured"] is False
    assert status["token_configured"] is False
    assert "token" in status["message"].lower()


def test_hybrid_candidate_limit_overfetches_and_caps():
    assert hybrid_candidate_limit(1) == 20
    assert hybrid_candidate_limit(5) == 20
    assert hybrid_candidate_limit(30) == 100
