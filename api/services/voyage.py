"""Voyage AI embedding service for patient insight semantic retrieval."""
from __future__ import annotations

import logging
import os

logger = logging.getLogger(__name__)


class VoyageEmbedder:
    MODEL = "voyage-3-lite"
    DIMENSION = 1024

    def embed(self, text: str, input_type: str = "document") -> list[float] | None:
        api_key = os.environ.get("VOYAGE_API_KEY")
        if not api_key:
            return None
        try:
            import voyageai
            client = voyageai.Client(api_key=api_key, timeout=5)
            result = client.embed([text], model=self.MODEL, input_type=input_type)
            return result.embeddings[0]
        except Exception as exc:
            logger.warning("VoyageEmbedder failed: %s", exc)
            return None
