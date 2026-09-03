/**
 * SISTEMA OFICIALIA-DIGITAL-DSA
 * Watcher del directorio físico de ingesta (storage/01_entrada/)
 * Versión: 1.0.0
 *
 * Cierra la mitad que faltaba de la "Ingesta Dual" del PRD (§2.1). Antes de este
 * archivo, `IngestaOrigen: 'SCANNER_ADF'` solo existía como valor de enum/query param
 * que el propio cliente HTTP podía declarar al llamar `POST /documents/upload` — ningún
 * proceso vigilaba realmente la carpeta que un escáner departamental llenaría de forma
 * asíncrona (vía ADF, sobre un volumen SMB montado en `storage/01_entrada/`, prd.md
 * §5.2), sin que nadie invocara el endpoint HTTP por él.
 *
 * Diseño — POLLING, no `fs.watch`/inotify:
 *   `fs.watch` no es confiable sobre volúmenes de red (SMB/CIFS): los eventos inotify
 *   frecuentemente no se disparan o se pierden sobre el montaje remoto que el propio PRD
 *   describe como origen de este directorio. Un poll periódico con `fs.readdir` funciona
 *   igual sobre disco local o sobre SMB, a costa de una latencia de detección acotada por
 *   `intervalMs` (aceptable: el flujo es asíncrono por diseño en todo el pipeline).
 *
 * "Estabilidad" de archivo:
 *   Un escáner puede tardar varios segundos en terminar de escribir un PDF grande al
 *   volumen SMB. Leerlo a medias produciría CORRUPTED_PDF_STRUCTURE en PyMuPDF (que,
 *   tras el fix de ERROR_PREPROCESO, ya no rompería el pipeline — pero seguiría siendo
 *   un falso error evitable). Un archivo se considera "estable" y listo para ingerir
 *   solo cuando su tamaño no cambió entre dos polls consecutivos Y su mtime es más
 *   antiguo que `stableForMs`.
 *
 * Deduplicación con la ruta de subida HTTP (`saveIncoming`):
 *   `LocalFileStorageAdapter.saveIncoming` escribe los archivos subidos por
 *   Drag & Drop en el mismo directorio (`storage/01_entrada/`) con el prefijo
 *   `${Date.now()}_` antes de moverlos a `02_en_proceso/` — hay una ventana real entre
 *   ese `write` y el `move` (el `await` a `inspectAndSanitize`, que lanza un subproceso
 *   Python) en la que este watcher podría verlos. Se filtran por ese prefijo para nunca
 *   reingerir un archivo que ya está siendo procesado por el otro camino de entrada.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';

import {
  PdfPreprocessFailedError,
  type DocumentWorkflowOrchestrator,
} from '../../application/DocumentWorkflowOrchestrator';

export interface WatcherLogger {
  info(msg: string, meta?: unknown): void;
  warn(msg: string, meta?: unknown): void;
  error(msg: string, meta?: unknown): void;
}

export interface IncomingFolderWatcherOptions {
  /** Directorio raíz del watchfolder (mismo valor que STORAGE_ROOT / IFileStorageProvider). */
  storageRoot: string;
  orchestrator: DocumentWorkflowOrchestrator;
  /** Intervalo entre polls, en ms (default 5000). */
  intervalMs?: number;
  /** Tiempo mínimo sin cambios de tamaño/mtime para considerar un archivo "estable" (default 4000). */
  stableForMs?: number;
  /** Reintentos ante fallos inesperados (no PdfPreprocessFailedError ni duplicado) antes de aislar el archivo (default 5). */
  maxUnexpectedRetries?: number;
  logger?: WatcherLogger;
}

interface TrackedFile {
  size: number;
  mtimeMs: number;
  failedAttempts: number;
}

const DEFAULT_INTERVAL_MS = 5_000;
const DEFAULT_STABLE_FOR_MS = 4_000;
const DEFAULT_MAX_UNEXPECTED_RETRIES = 5;

/** Prefijo que `LocalFileStorageAdapter.saveIncoming` antepone a los archivos subidos por HTTP. */
const HTTP_UPLOAD_PREFIX_RE = /^\d{10,}_/;

const NOOP_LOGGER: WatcherLogger = { info: () => undefined, warn: () => undefined, error: () => undefined };

export class IncomingFolderWatcher {
  private readonly entradaDir: string;
  private readonly errorDir: string;
  private readonly intervalMs: number;
  private readonly stableForMs: number;
  private readonly maxUnexpectedRetries: number;
  private readonly orchestrator: DocumentWorkflowOrchestrator;
  private readonly logger: WatcherLogger;

  private timer: NodeJS.Timeout | null = null;
  private polling = false;
  private readonly tracked = new Map<string, TrackedFile>();
  /** Archivos ya estables e ingestándose — evita doble-procesamiento si un poll se solapa. */
  private readonly inFlight = new Set<string>();

  constructor(options: IncomingFolderWatcherOptions) {
    this.entradaDir = path.resolve(options.storageRoot, '01_entrada');
    this.errorDir = path.resolve(options.storageRoot, '04_errores');
    this.orchestrator = options.orchestrator;
    this.intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
    this.stableForMs = options.stableForMs ?? DEFAULT_STABLE_FOR_MS;
    this.maxUnexpectedRetries = options.maxUnexpectedRetries ?? DEFAULT_MAX_UNEXPECTED_RETRIES;
    this.logger = options.logger ?? NOOP_LOGGER;
  }

  start(): void {
    if (this.timer) return;
    this.logger.info(`[IncomingFolderWatcher] Vigilando ${this.entradaDir} cada ${this.intervalMs}ms`);
    this.timer = setInterval(() => {
      void this.pollOnce();
    }, this.intervalMs);
    this.timer.unref();
    void this.pollOnce();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** Público (no solo por el timer interno) para permitir pruebas deterministas sin fake timers. */
  async pollOnce(): Promise<void> {
    if (this.polling) return; // evita solapar polls si uno tarda más que intervalMs
    this.polling = true;
    try {
      const entries = await fs.readdir(this.entradaDir, { withFileTypes: true }).catch(() => []);
      const seenNow = new Set<string>();

      for (const entry of entries) {
        if (!entry.isFile()) continue;
        if (!entry.name.toLowerCase().endsWith('.pdf')) continue;
        if (HTTP_UPLOAD_PREFIX_RE.test(entry.name)) continue;
        if (this.inFlight.has(entry.name)) continue;

        seenNow.add(entry.name);
        const absolutePath = path.join(this.entradaDir, entry.name);

        let stat;
        try {
          stat = await fs.stat(absolutePath);
        } catch {
          continue; // desapareció entre el readdir y el stat (raro, pero no fatal)
        }

        const previous = this.tracked.get(entry.name);

        if (!previous || previous.size !== stat.size || previous.mtimeMs !== stat.mtimeMs) {
          this.tracked.set(entry.name, {
            size: stat.size,
            mtimeMs: stat.mtimeMs,
            failedAttempts: previous?.failedAttempts ?? 0,
          });
          continue; // cambió (o es nuevo) desde el último poll: sigue "caliente"
        }

        if (Date.now() - stat.mtimeMs < this.stableForMs) continue; // sin cambios pero aún muy reciente

        this.inFlight.add(entry.name);
        void this.processFile(entry.name, absolutePath, previous).finally(() => {
          this.inFlight.delete(entry.name);
        });
      }

      // Deja de rastrear archivos que ya no están en el directorio (ingeridos o removidos externamente).
      for (const trackedName of this.tracked.keys()) {
        if (!seenNow.has(trackedName)) this.tracked.delete(trackedName);
      }
    } finally {
      this.polling = false;
    }
  }

  private async processFile(fileName: string, absolutePath: string, tracked: TrackedFile): Promise<void> {
    let buffer: Buffer;
    try {
      buffer = await fs.readFile(absolutePath);
    } catch (error) {
      this.logger.warn(`[IncomingFolderWatcher] No se pudo leer ${fileName}, se reintenta en el próximo poll`, error);
      return;
    }

    if (buffer.byteLength === 0) {
      this.logger.warn(`[IncomingFolderWatcher] ${fileName} está vacío, se aísla sin reintentar`);
      await this.quarantine(absolutePath, fileName, 'EMPTY_FILE_FROM_WATCHFOLDER');
      return;
    }

    try {
      const record = await this.orchestrator.ingestAndExtract(fileName, 'SCANNER_ADF', buffer);
      this.logger.info(`[IncomingFolderWatcher] Ingerido ${fileName} -> documento ${record.id}`);
      await this.consumeOriginal(absolutePath, fileName);
    } catch (error) {
      if (error instanceof PdfPreprocessFailedError || (error instanceof Error && /duplicado/i.test(error.message))) {
        // El orquestador ya persistió el resultado (ERROR_PREPROCESO, o el registro
        // duplicado preexistente) y aisló SU PROPIA copia del buffer — ver
        // recordPreprocessFailure / la rama de duplicado en ingestAndExtract. El
        // original que dejó el escáner en 01_entrada/ ya es redundante.
        this.logger.warn(`[IncomingFolderWatcher] ${fileName}: ${error.message}`);
        await this.consumeOriginal(absolutePath, fileName);
        return;
      }

      const attempts = tracked.failedAttempts + 1;
      this.logger.error(`[IncomingFolderWatcher] Fallo inesperado ingiriendo ${fileName} (intento ${attempts})`, error);

      if (attempts >= this.maxUnexpectedRetries) {
        await this.quarantine(
          absolutePath,
          fileName,
          `WATCHFOLDER_MAX_RETRIES :: ${error instanceof Error ? error.message : String(error)}`
        );
        return;
      }

      this.tracked.set(fileName, { ...tracked, failedAttempts: attempts });
    }
  }

  /** Elimina el archivo original del watchfolder tras una ingesta que el orquestador ya persistió. */
  private async consumeOriginal(absolutePath: string, fileName: string): Promise<void> {
    try {
      await fs.unlink(absolutePath);
    } catch (error) {
      this.logger.warn(`[IncomingFolderWatcher] No se pudo borrar el original ${fileName} tras ingerirlo`, error);
    } finally {
      this.tracked.delete(fileName);
    }
  }

  /** Último recurso: aísla en 04_errores/ un archivo que el watcher no logra procesar tras agotar reintentos. */
  private async quarantine(absolutePath: string, fileName: string, reason: string): Promise<void> {
    try {
      await fs.mkdir(this.errorDir, { recursive: true });
      const target = path.join(this.errorDir, fileName);
      await fs.rename(absolutePath, target);
      await fs.writeFile(`${target}.error.txt`, `${new Date().toISOString()} :: ${reason}\n`, { flag: 'a' });
    } catch (error) {
      this.logger.error(`[IncomingFolderWatcher] No se pudo aislar ${fileName}`, error);
    } finally {
      this.tracked.delete(fileName);
    }
  }
}
