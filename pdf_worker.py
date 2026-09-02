#!/usr/bin/env python3
"""
pdf_worker.py — Worker CLI de preprocesamiento documental para Oficialia-Digital-DSA.

Este script procesa buffers binarios de archivos PDF recibidos por stdin y emite
resultados por stdout. Está diseñado para integrarse con el contrato
IPdfProcessorProvider, proporcionando inspección estructural, sanitización y
renderizado de páginas para inferencia multimodal.

Dependencias:
    - PyMuPDF (fitz) : parseo, sanitización y renderizado de PDF.
    - Pillow         : conversión opcional a JPEG.

Uso:
    python pdf_worker.py inspect < input.pdf
    python pdf_worker.py sanitize < input.pdf > sanitized.pdf
    python pdf_worker.py render --dpi 300 --format png < input.pdf

Salidas:
    - inspect  : JSON con metadatos técnicos (sin buffer sanitizado).
    - sanitize : binario del PDF sanitizado por stdout (sin JSON).
    - render   : JSON con imágenes base64 por página.

Códigos de salida:
    0  Éxito
    10 Cabecera PDF inválida
    11 PDF protegido con contraseña
    12 Estructura de PDF corrupta
    13 Error de renderizado
    14 Argumentos inválidos
    15 Error desconocido
"""

import sys
import json
import time
import base64
import hashlib
import argparse
import io
from typing import Any, List, Optional, Dict

import fitz  # PyMuPDF
from PIL import Image

# ---------------------------------------------------------------------------
# Excepción controlada y constantes de error
# ---------------------------------------------------------------------------
class PdfProcessingError(Exception):
    """Excepción para errores de procesamiento con código y mensaje."""

    def __init__(self, code: str, message: str):
        self.code = code
        self.message = message
        super().__init__(f"[{code}] {message}")


# Códigos de salida
EXIT_OK = 0
EXIT_INVALID_HEADER = 10
EXIT_PASSWORD = 11
EXIT_CORRUPTED = 12
EXIT_RENDER_ERROR = 13
EXIT_BAD_ARGS = 14
EXIT_UNKNOWN = 15

# Mapeo de códigos de error a códigos de salida
ERROR_CODES = {
    "INVALID_PDF_HEADER": EXIT_INVALID_HEADER,
    "PASSWORD_PROTECTED_FILE": EXIT_PASSWORD,
    "CORRUPTED_PDF_STRUCTURE": EXIT_CORRUPTED,
    "RENDER_ERROR": EXIT_RENDER_ERROR,
    "INVALID_ARGUMENTS": EXIT_BAD_ARGS,
    "UNKNOWN_ERROR": EXIT_UNKNOWN,
}

# ---------------------------------------------------------------------------
# Utilidades de bajo nivel
# ---------------------------------------------------------------------------
def has_valid_pdf_header(buffer: bytes) -> bool:
    """Verifica si el buffer comienza con la firma mágica %PDF-."""
    return buffer[:5] == b"%PDF-" if len(buffer) >= 5 else False


def calculate_sha256(buffer: bytes) -> str:
    """Calcula el hash SHA-256 del buffer y retorna su representación hexadecimal."""
    return hashlib.sha256(buffer).hexdigest()


def open_pdf(buffer: bytes) -> fitz.Document:
    """
    Abre un documento PDF desde un buffer binario.

    Lanza PdfProcessingError con el código correspondiente si el PDF es inválido,
    está protegido por contraseña o su estructura es corrupta.
    """
    if not has_valid_pdf_header(buffer):
        raise PdfProcessingError("INVALID_PDF_HEADER", "El archivo no tiene cabecera PDF válida")

    try:
        doc = fitz.open(stream=buffer, filetype="pdf")
    except Exception as e:
        msg = str(e).lower()
        if "password" in msg or "encrypted" in msg:
            raise PdfProcessingError("PASSWORD_PROTECTED_FILE", "PDF protegido con contraseña")
        raise PdfProcessingError("CORRUPTED_PDF_STRUCTURE", f"Parser falló: {e}")

    # Comprobación adicional por si el documento indica necesidad de contraseña
    if doc.needs_pass:
        doc.close()
        raise PdfProcessingError("PASSWORD_PROTECTED_FILE", "PDF protegido con contraseña")

    if doc.page_count == 0:
        doc.close()
        raise PdfProcessingError("CORRUPTED_PDF_STRUCTURE", "PDF sin páginas")

    return doc


def sanitize_pdf(doc: fitz.Document) -> bytes:
    """
    Regenera el PDF limpiando el árbol xref y eliminando objetos no referenciados.
    Devuelve el buffer sanitizado.
    """
    return doc.tobytes(garbage=3, deflate=True, clean=True)


def get_page_dimensions(doc: fitz.Document, dpi: int = 300) -> List[Dict[str, Any]]:
    """
    Obtiene las dimensiones en píxeles para cada página según el DPI de renderizado.

    Nota: Los PDF son vectoriales, por lo que el "DPI real" de las imágenes embebidas
    no se extrae aquí; se reporta el DPI usado para el renderizado.
    """
    pages_info = []
    for page_num in range(len(doc)):
        page = doc.load_page(page_num)
        rect = page.rect
        width_px = int(round(rect.width * dpi / 72))
        height_px = int(round(rect.height * dpi / 72))
        pages_info.append({
            "pageNumber": page_num + 1,
            "widthPx": width_px,
            "heightPx": height_px,
            "dpi": dpi,
        })
    return pages_info


def render_page_to_base64(page: fitz.Page, dpi: int, fmt: str) -> Dict[str, Any]:
    """
    Renderiza una página a imagen y la devuelve como base64 en un diccionario.

    Parámetros:
        page : objeto Page de PyMuPDF.
        dpi  : resolución en puntos por pulgada.
        fmt  : formato de salida ('png', 'jpeg', 'jpg').

    Retorna:
        Diccionario con número de página, formato, dimensiones y datos base64.
    """
    matrix = fitz.Matrix(dpi / 72, dpi / 72)
    pix = page.get_pixmap(matrix=matrix, alpha=False)

    if fmt.lower() in ("jpeg", "jpg"):
        # Convertir a JPEG usando Pillow (optimizado para calidad/tamaño)
        img = Image.frombytes("RGB", [pix.width, pix.height], pix.samples)
        buffer = io.BytesIO()
        img.save(buffer, format="JPEG", quality=90, optimize=True)
        img_bytes = buffer.getvalue()
    else:
        # PNG nativo de PyMuPDF
        img_bytes = pix.tobytes("png")

    b64 = base64.b64encode(img_bytes).decode("ascii")
    return {
        "pageNumber": page.number + 1,
        "format": "jpeg" if fmt.lower() in ("jpeg", "jpg") else "png",
        "width": pix.width,
        "height": pix.height,
        "base64": b64,
    }

# ---------------------------------------------------------------------------
# Acciones principales
# ---------------------------------------------------------------------------
def action_inspect(raw_buffer: bytes) -> Dict[str, Any]:
    """
    Inspecciona el PDF, valida integridad, calcula hash y extrae métricas.

    No incluye el buffer sanitizado en la salida para minimizar el consumo de RAM.
    """
    start = time.perf_counter()

    doc = open_pdf(raw_buffer)
    try:
        # Realizar una sanitización de comprobación (sin almacenar el resultado)
        _ = sanitize_pdf(doc)

        sha256 = calculate_sha256(raw_buffer)
        pages_dim = get_page_dimensions(doc, dpi=300)
        duration_ms = int(round((time.perf_counter() - start) * 1000))

        result = {
            "pageCount": len(doc),
            "fileSizeBytes": len(raw_buffer),
            "sha256Hash": sha256,
            "paginas": pages_dim,
            "processingDurationMs": duration_ms,
            "isSanitized": True,
        }
        return result
    finally:
        doc.close()


def action_sanitize(raw_buffer: bytes) -> None:
    """
    Sanitiza el PDF y lo emite como binario puro por stdout.

    No se produce salida JSON; solo el flujo binario del PDF limpio.
    """
    doc = open_pdf(raw_buffer)
    try:
        sanitized = sanitize_pdf(doc)
        sys.stdout.buffer.write(sanitized)
        sys.stdout.buffer.flush()
    finally:
        doc.close()


def action_render(raw_buffer: bytes, dpi: int, fmt: str, pages: Optional[List[int]]) -> Dict[str, Any]:
    """
    Renderiza las páginas seleccionadas a imágenes base64.

    Parámetros:
        raw_buffer : bytes del PDF.
        dpi        : resolución en DPI.
        fmt        : formato de imagen ('png', 'jpeg', 'jpg').
        pages      : lista de números de página (1-indexados) o None para todas.

    Retorna:
        Diccionario con clave 'pages' que contiene la lista de imágenes.
    """
    doc = open_pdf(raw_buffer)
    try:
        total_pages = len(doc)
        if pages is None:
            pages_to_render = list(range(total_pages))
        else:
            if len(pages) == 0:
                raise PdfProcessingError("INVALID_ARGUMENTS", "La lista de páginas no puede estar vacía")
            pages_to_render = []
            for p in pages:
                if p < 1 or p > total_pages:
                    raise PdfProcessingError(
                        "INVALID_ARGUMENTS",
                        f"Número de página inválido: {p}. El PDF tiene {total_pages} páginas."
                    )
                pages_to_render.append(p - 1)  # convertir a índice 0

        rendered = []
        for page_idx in pages_to_render:
            page = doc.load_page(page_idx)
            rendered.append(render_page_to_base64(page, dpi, fmt))
        return {"pages": rendered}
    finally:
        doc.close()

# ---------------------------------------------------------------------------
# Punto de entrada principal
# ---------------------------------------------------------------------------
def main() -> None:
    """Analiza argumentos, lee stdin y ejecuta la acción solicitada."""
    parser = argparse.ArgumentParser(description="Worker CLI de procesamiento PDF")
    subparsers = parser.add_subparsers(dest="action", required=True)

    # Subcomando inspect
    subparsers.add_parser("inspect", help="Inspeccionar y sanitizar PDF (solo metadatos)")

    # Subcomando sanitize
    subparsers.add_parser("sanitize", help="Emitir PDF sanitizado binario por stdout")

    # Subcomando render con opciones
    parser_render = subparsers.add_parser("render", help="Renderizar páginas a imágenes")
    parser_render.add_argument("--dpi", type=int, default=300,
                               help="Resolución en DPI (default: 300)")
    parser_render.add_argument("--format", choices=["png", "jpeg", "jpg"], default="png",
                               help="Formato de imagen (default: png)")
    parser_render.add_argument("--pages", type=str, default=None,
                               help="Lista de páginas separadas por comas (1-indexadas). "
                                    "Si no se especifica, se renderizan todas.")

    args = parser.parse_args()

    try:
        # Leer buffer binario completo desde stdin
        raw_buffer = sys.stdin.buffer.read()
        if not raw_buffer:
            raise PdfProcessingError("INVALID_ARGUMENTS", "No se recibió ningún dato por stdin")

        if args.action == "inspect":
            result = action_inspect(raw_buffer)
            output = {"success": True, "result": result}
            sys.stdout.write(json.dumps(output, ensure_ascii=False))
            sys.stdout.flush()
            sys.exit(EXIT_OK)

        elif args.action == "sanitize":
            action_sanitize(raw_buffer)
            sys.exit(EXIT_OK)   # La salida binaria ya se emitió

        elif args.action == "render":
            pages = None
            if args.pages is not None:
                parts = [x.strip() for x in args.pages.split(",") if x.strip()]
                if not parts:
                    raise PdfProcessingError("INVALID_ARGUMENTS",
                                            "La lista de páginas no puede estar vacía")
                try:
                    pages = [int(x) for x in parts]
                except ValueError:
                    raise PdfProcessingError(
                        "INVALID_ARGUMENTS",
                        "Formato de páginas inválido. Use números enteros separados por comas."
                    )
            result = action_render(raw_buffer, args.dpi, args.format, pages)
            output = {"success": True, "result": result}
            sys.stdout.write(json.dumps(output, ensure_ascii=False))
            sys.stdout.flush()
            sys.exit(EXIT_OK)

        else:
            raise PdfProcessingError("INVALID_ARGUMENTS", f"Acción desconocida: {args.action}")

    except PdfProcessingError as e:
        # Error controlado: emitir JSON y salir con código específico
        output = {"success": False, "errorCode": e.code, "message": e.message}
        sys.stdout.write(json.dumps(output, ensure_ascii=False))
        sys.stdout.flush()
        sys.exit(ERROR_CODES.get(e.code, EXIT_UNKNOWN))

    except Exception as e:
        # Error inesperado
        output = {"success": False, "errorCode": "UNKNOWN_ERROR", "message": str(e)}
        sys.stdout.write(json.dumps(output, ensure_ascii=False))
        sys.stdout.flush()
        sys.exit(EXIT_UNKNOWN)


if __name__ == "__main__":
    main()