"""Tests for VoyageEmbedder service."""
from __future__ import annotations

import sys
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "api"))

from services.voyage import VoyageEmbedder  # noqa: E402


def test_embed_returns_none_when_no_api_key(monkeypatch):
    """Returns None when VOYAGE_API_KEY is not set."""
    monkeypatch.delenv("VOYAGE_API_KEY", raising=False)
    result = VoyageEmbedder().embed("test text")
    assert result is None


def test_embed_returns_none_on_timeout(monkeypatch):
    """Returns None when the voyageai client raises an exception (e.g. timeout)."""
    monkeypatch.setenv("VOYAGE_API_KEY", "test-key")
    fake_client = MagicMock()
    fake_client.embed.side_effect = Exception("timeout")
    mock_voyageai = MagicMock()
    mock_voyageai.Client.return_value = fake_client
    with patch.dict("sys.modules", {"voyageai": mock_voyageai}):
        result = VoyageEmbedder().embed("test text")
    assert result is None


def test_embed_returns_512_floats_on_success(monkeypatch):
    """Returns a list of 512 floats on a successful API call."""
    monkeypatch.setenv("VOYAGE_API_KEY", "test-key")
    fake_embedding = [0.1] * 512
    fake_result = MagicMock()
    fake_result.embeddings = [fake_embedding]
    fake_client = MagicMock()
    fake_client.embed.return_value = fake_result
    mock_voyageai = MagicMock()
    mock_voyageai.Client.return_value = fake_client
    with patch.dict("sys.modules", {"voyageai": mock_voyageai}):
        result = VoyageEmbedder().embed("test text")
    assert result is not None
    assert len(result) == 512


def test_embed_uses_correct_input_type(monkeypatch):
    """Passes the correct input_type for document vs query embedding."""
    monkeypatch.setenv("VOYAGE_API_KEY", "test-key")
    fake_embedding = [0.1] * 512
    fake_result = MagicMock()
    fake_result.embeddings = [fake_embedding]
    fake_client = MagicMock()
    fake_client.embed.return_value = fake_result
    mock_voyageai = MagicMock()
    mock_voyageai.Client.return_value = fake_client
    with patch.dict("sys.modules", {"voyageai": mock_voyageai}):
        VoyageEmbedder().embed("doc text", input_type="document")
        VoyageEmbedder().embed("query text", input_type="query")
    calls = fake_client.embed.call_args_list
    assert len(calls) == 2
    # First call: input_type="document"
    first_kwargs = calls[0][1]
    first_args = calls[0][0]
    assert first_kwargs.get("input_type") == "document" or (len(first_args) > 2 and first_args[2] == "document")
    # Second call: input_type="query"
    second_kwargs = calls[1][1]
    second_args = calls[1][0]
    assert second_kwargs.get("input_type") == "query" or (len(second_args) > 2 and second_args[2] == "query")


def test_embed_passes_timeout_to_client(monkeypatch):
    """voyageai.Client is initialized with timeout=5."""
    monkeypatch.setenv("VOYAGE_API_KEY", "test-key")
    fake_embedding = [0.1] * 512
    fake_result = MagicMock()
    fake_result.embeddings = [fake_embedding]
    fake_client = MagicMock()
    fake_client.embed.return_value = fake_result
    mock_voyageai = MagicMock()
    mock_voyageai.Client.return_value = fake_client
    with patch.dict("sys.modules", {"voyageai": mock_voyageai}):
        VoyageEmbedder().embed("test text")
    mock_voyageai.Client.assert_called_once_with(api_key="test-key", timeout=5)


def test_embed_returns_none_on_empty_embeddings(monkeypatch):
    """Returns None when the API returns an empty embeddings list (IndexError caught)."""
    monkeypatch.setenv("VOYAGE_API_KEY", "test-key")
    fake_result = MagicMock()
    fake_result.embeddings = []
    fake_client = MagicMock()
    fake_client.embed.return_value = fake_result
    mock_voyageai = MagicMock()
    mock_voyageai.Client.return_value = fake_client
    with patch.dict("sys.modules", {"voyageai": mock_voyageai}):
        result = VoyageEmbedder().embed("test text")
    assert result is None
