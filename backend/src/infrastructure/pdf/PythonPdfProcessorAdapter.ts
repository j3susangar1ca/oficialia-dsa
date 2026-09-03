/**
 * SISTEMA OFICIALIA-DIGITAL-DSA
 * Adaptador de Infraestructura — Preprocesamiento de PDF vía Subproceso Python
 * Implementación del puerto secundario IPdfProcessorProvider sobre `scripts/pdf_worker.py`
 * (PyMuPDF / Pillow), aislada en `child_process.spawn` conforme al diagrama de secuencia
 * de contracts.md (§ IPdfProcessorProvider).
 *
 * Versión: 1.0.0-MVP
 * Runtime: Node.js 22 LTS · TypeScript 5.x (modo estricto) · Python 3 + PyMuPDF + Pillow
 *
 * Decisiones de diseño:
 *  - `inspectAndSanitize` dispara dos subprocesos en paralelo (`inspect` para métricas,
 *    `sanitize` para el buffer binario limpio) porque el CLI separa ambas salidas para
 *    minimizar el tamaño de la respuesta JSON (evita re-codificar el PDF completo a Base64
 *    cuando solo se necesitan metadatos).
 *  - `renderPagesForInference` acepta `maxPages`: como el CLI solo trunca por lista
 *    explícita `--pages`, se resuelve primero el conteo real de páginas (subproceso
 *    `inspect` ligero) y se construye la lista `1..min(maxPages, pageCount)`.
 *  - Cada invocación tiene un timeout duro; el proceso se mata (`SIGKILL`) si lo excede,
 *    mapeando a `RENDERING_EXECUTION_TIMEOUT` / `WORKER_SUBPROCESS_FAULT`.
 */

import { spawn } from 'node:child_process';
import path from 'node:path';

import type {
  IPdfProcessorProvider,
  PageRenderOptions,
  PdfInspectionResult,
  PdfProcessingError,
  PdfProcessingErrorCode,
  RenderedPageImage,
} from '../../contracts/IPdfProcessorProvider';

const PDF_MAGIC_HEADER = Buffer.from('%PDF-', 'ascii');

/** Mapeo del `errorCode` textual emitido por pdf_worker.py al enum tipado del contrato. */
const WORKER_ERROR_MAP: Record<string, PdfProcessingErrorCode> = {
  INVALID_PDF_HEADER: 'ZERO_BYTE_OR_EMPTY_BUFFER',
  PASSWORD_PROTECTED_FILE: 'PASSWORD_PROTECTED_FILE',
  CORRUPTED_PDF_STRUCTURE: 'CORRUPTED_PDF_STRUCTURE',
  RENDER_ERROR: 'RENDERING_EXECUTION_TIMEOUT',
  INVALID_ARGUMENTS: 'WORKER_SUBPROCESS_FAULT',
  UNKNOWN_ERROR: 'WORKER_SUBPROCESS_FAULT',
};

export class PdfWorkerError extends Error implements PdfProcessingError {
  public readonly code: PdfProcessingErrorCode;
  public readonly underlyingExitCode?: number;

  constructor(
    code: PdfProcessingErrorCode,
    message: string,
    attributes: { underlyingExitCode?: number; cause?: unknown } = {}
  ) {
    super(message, { cause: attributes.cause });
    this.name = 'PdfWorkerError';
    this.code = code;
    this.underlyingExitCode = attributes.underlyingExitCode;
  }
}

interface InspectWorkerResult {
  pageCount: number;
  fileSizeBytes: number;
  sha256Hash: string;
  paginas: Array<{ pageNumber: number; widthPx: number; heightPx: number; dpi: number }>;
  processingDurationMs: number;
  isSanitized: boolean;
}

interface RenderWorkerPage {
  pageNumber: number;
  format: 'png' | 'jpeg';
  width: number;
  height: number;
  base64: string;
}

export interface PythonPdfProcessorOptions {
  /** Ruta al intérprete de Python (por defecto: `python3` del PATH). */
  pythonBin?: string;
  /** Ruta absoluta o relativa al script CLI (por defecto: `<repo>/backend/scripts/pdf_worker.py`). */
  scriptPath?: string;
  /** Límite de tiempo por subproceso en milisegundos (por defecto: 30 000). */
  timeoutMs?: number;
}

export class PythonPdfProcessorAdapter implements IPdfProcessorProvider {
  private readonly pythonBin: string;
  private readonly scriptPath: string;
  private readonly timeoutMs: number;

  constructor(options: PythonPdfProcessorOptions = {}) {
    this.pythonBin = options.pythonBin ?? process.env.PYTHON_BIN ?? 'python3';
    this.scriptPath = options.scriptPath ?? path.resolve(process.cwd(), 'scripts', 'pdf_worker.py');
    this.timeoutMs = options.timeoutMs ?? 30_000;
  }

  hasValidPdfHeader(buffer: Uint8Array): boolean {
    if (buffer.byteLength < PDF_MAGIC_HEADER.byteLength) return false;
    return Buffer.from(buffer.buffer, buffer.byteOffset, PDF_MAGIC_HEADER.byteLength).equals(PDF_MAGIC_HEADER);
  }

  async inspectAndSanitize(rawFileBuffer: Uint8Array): Promise<PdfInspectionResult> {
    if (rawFileBuffer.byteLength === 0) {
      throw new PdfWorkerError('ZERO_BYTE_OR_EMPTY_BUFFER', 'El buffer recibido para inspección está vacío.');
    }
    if (!this.hasValidPdfHeader(rawFileBuffer)) {
      throw new PdfWorkerError('CORRUPTED_PDF_STRUCTURE', 'El archivo no posee la cabecera mágica %PDF- esperada.');
    }

    const [inspection, sanitizedBuffer] = await Promise.all([
      this.runJsonAction<InspectWorkerResult>('inspect', [], rawFileBuffer),
      this.runBinaryAction('sanitize', [], rawFileBuffer),
    ]);

    return {
      metadata: {
        pageCount: inspection.pageCount,
        fileSizeBytes: inspection.fileSizeBytes,
        sha256Hash: inspection.sha256Hash,
        paginas: inspection.paginas,
        processingDurationMs: inspection.processingDurationMs,
        isSanitized: inspection.isSanitized,
      },
      sanitizedBuffer,
    };
  }

  async renderPagesForInference(
    sanitizedBuffer: Uint8Array,
    options: PageRenderOptions = {}
  ): Promise<ReadonlyArray<RenderedPageImage>> {
    const dpi = options.targetDpi ?? 300;
    const format = options.format === 'image/jpeg' ? 'jpeg' : 'png';

    const args = ['--dpi', String(dpi), '--format', format];

    if (options.maxPages !== undefined) {
      const { pageCount } = await this.runJsonAction<InspectWorkerResult>('inspect', [], sanitizedBuffer);
      const upperBound = Math.max(1, Math.min(options.maxPages, pageCount));
      const pages = Array.from({ length: upperBound }, (_, index) => index + 1);
      args.push('--pages', pages.join(','));
    }

    const result = await this.runJsonAction<{ pages: RenderWorkerPage[] }>('render', args, sanitizedBuffer);

    return result.pages
      .map((page): RenderedPageImage => ({
        pageNumber: page.pageNumber,
        imageBuffer: Buffer.from(page.base64, 'base64'),
        mimeType: page.format === 'jpeg' ? 'image/jpeg' : 'image/png',
        widthPx: page.width,
        heightPx: page.height,
        dpi,
      }))
      .sort((a, b) => a.pageNumber - b.pageNumber);
  }

  // ---------------------------------------------------------------------
  // Internos: invocación del subproceso CLI
  // ---------------------------------------------------------------------

  private async runJsonAction<T>(action: string, extraArgs: string[], stdin: Uint8Array): Promise<T> {
    const { stdout } = await this.spawnWorker([action, ...extraArgs], stdin, /* expectBinaryStdout */ false);
    let parsed: { success: boolean; result?: T; errorCode?: string; message?: string };
    try {
      // Defensa adicional: pdf_worker.py solo debe emitir el objeto JSON por stdout, pero
      // una librería de terceros (p. ej. un aviso de deprecación de PyMuPDF) podría anteponer
      // texto espurio. Se recorta hasta la primera `{` en vez de confiar ciegamente en que
      // stdout esté "limpio" — si aun así no es JSON válido, el error se propaga tal cual.
      const raw = stdout.toString('utf-8');
      const jsonStart = raw.indexOf('{');
      parsed = JSON.parse(jsonStart >= 0 ? raw.slice(jsonStart) : raw);
    } catch (cause) {
      throw new PdfWorkerError('WORKER_SUBPROCESS_FAULT', `Salida no-JSON del worker Python (acción=${action}).`, {
        cause,
      });
    }
    if (!parsed.success || parsed.result === undefined) {
      throw new PdfWorkerError(
        WORKER_ERROR_MAP[parsed.errorCode ?? 'UNKNOWN_ERROR'] ?? 'WORKER_SUBPROCESS_FAULT',
        parsed.message ?? `El worker Python reportó un fallo no especificado (acción=${action}).`
      );
    }
    return parsed.result;
  }

  private async runBinaryAction(action: string, extraArgs: string[], stdin: Uint8Array): Promise<Uint8Array> {
    const { stdout } = await this.spawnWorker([action, ...extraArgs], stdin, /* expectBinaryStdout */ true);
    return stdout;
  }

  private spawnWorker(args: string[], stdin: Uint8Array, expectBinaryStdout: boolean): Promise<{ stdout: Buffer }> {
    return new Promise((resolve, reject) => {
      const child = spawn(this.pythonBin, [this.scriptPath, ...args], {
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      const stdoutChunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];
      let settled = false;

      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        child.kill('SIGKILL');
        reject(
          new PdfWorkerError(
            'RENDERING_EXECUTION_TIMEOUT',
            `El subproceso Python (${args[0]}) excedió el límite de ${this.timeoutMs} ms.`
          )
        );
      }, this.timeoutMs);
      timer.unref?.();

      child.stdout.on('data', (chunk: Buffer) => stdoutChunks.push(chunk));
      child.stderr.on('data', (chunk: Buffer) => stderrChunks.push(chunk));

      child.on('error', (cause) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(
          new PdfWorkerError(
            'WORKER_SUBPROCESS_FAULT',
            `No se pudo iniciar el subproceso Python en "${this.pythonBin}". ¿Está instalado y en el PATH?`,
            { cause }
          )
        );
      });

      child.on('close', (exitCode) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);

        const stdout = Buffer.concat(stdoutChunks);
        if (exitCode === 0) {
          resolve({ stdout });
          return;
        }

        // Fallos controlados: el CLI emite {success:false, errorCode, message} incluso
        // con código de salida distinto de cero, salvo en `sanitize` (salida binaria pura).
        if (!expectBinaryStdout) {
          resolve({ stdout }); // se delega el parseo/errorCode a runJsonAction
          return;
        }

        reject(
          new PdfWorkerError(
            'WORKER_SUBPROCESS_FAULT',
            `El subproceso Python terminó con código ${exitCode}: ${stderrChunks.join('')}`,
            {
              underlyingExitCode: exitCode ?? undefined,
            }
          )
        );
      });

      child.stdin.on('error', () => {
        // EPIPE si el proceso ya terminó (p.ej. cabecera inválida detectada antes de leer todo stdin).
        // El manejador 'close' resuelve/rechaza igualmente; se ignora aquí para no duplicar el rechazo.
      });
      child.stdin.write(Buffer.from(stdin.buffer, stdin.byteOffset, stdin.byteLength));
      child.stdin.end();
    });
  }
}
