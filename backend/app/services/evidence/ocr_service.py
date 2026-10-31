from __future__ import annotations

import io
from pathlib import Path
from typing import Any

import fitz


def _ocr_bytes(data: bytes, lang: str = "eng") -> str:
    try:
        from PIL import Image
        import pytesseract
    except ImportError as exc:
        raise RuntimeError("Install OCR dependencies: pip install pytesseract pillow") from exc
    try:
        return pytesseract.image_to_string(Image.open(io.BytesIO(data)).convert("RGB"), lang=lang).strip()
    except Exception as exc:
        raise RuntimeError(f"Tesseract OCR failed: {type(exc).__name__}: {exc}") from exc


def ocr_image(path: Path, lang: str = "eng") -> str:
    return _ocr_bytes(path.read_bytes(), lang)


def ocr_pdf_pages(
    path: Path,
    page_numbers: set[int] | None = None,
    lang: str = "eng",
    dpi: int = 220,
) -> list[dict[str, Any]]:
    """OCR selected 1-based PDF pages locally.

    A failure on one page no longer aborts the others. Each result has:
      page, text, method, error
    where `error` is None on success, or a message (and `text` is "") on failure,
    so the caller can keep native text from other pages and report the failure.
    """
    results: list[dict[str, Any]] = []
    with fitz.open(path) as doc:
        for index, page in enumerate(doc):
            number = index + 1
            if page_numbers is not None and number not in page_numbers:
                continue
            try:
                pix = page.get_pixmap(matrix=fitz.Matrix(dpi / 72, dpi / 72), alpha=False)
                text = _ocr_bytes(pix.tobytes("png"), lang)
                results.append({"page": number, "text": text, "method": "tesseract_ocr", "error": None})
            except Exception as exc:
                results.append(
                    {
                        "page": number,
                        "text": "",
                        "method": "tesseract_ocr",
                        "error": f"{type(exc).__name__}: {exc}",
                    }
                )
    return results