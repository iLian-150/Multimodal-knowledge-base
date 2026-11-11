"""Command-line entry point for the subject-document RAG MVP."""

from __future__ import annotations

import argparse
import json
from typing import List, Optional

from manufacturing_rag.pipeline import ManufacturingRAGPipeline


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Education-document multimodal adaptive RAG CLI")
    parser.add_argument("question", help="User question to answer from document-indexed knowledge base")
    parser.add_argument("--kb", action="append", required=True, help="Path to OCR structured JSONL knowledge file")
    parser.add_argument("--json", action="store_true", help="Print full structured response as JSON")
    return parser


def main(argv: Optional[List[str]] = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    pipeline = ManufacturingRAGPipeline.from_jsonl(args.kb)
    response = pipeline.answer(args.question)
    if args.json:
        print(json.dumps(response.to_dict(), ensure_ascii=False, indent=2))
    else:
        print(response.answer)
        if response.sources:
            print("\n资料来源：")
            for source in response.sources:
                score = f" score={source.score:.3f}" if source.score is not None else ""
                print(f"- {source.label()}{score}")
        if response.notices:
            print("\n系统提示：")
            for notice in response.notices:
                print(f"- {notice}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
