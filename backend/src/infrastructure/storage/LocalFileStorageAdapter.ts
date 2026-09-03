/**
 * SISTEMA OFICIALIA-DIGITAL-DSA
 * Adaptador de Infraestructura — Almacenamiento Local en Disco (fs/promises)
 * Implementación del puerto secundario IFileStorageProvider sobre el watchfolder
 * `storage/{01_entrada,02_en_proceso,03_procesados,04_errores}` descrito en prd.md §5.2.
 *
 * Versión: 1.0.0-MVP
 * Runtime: Node.js 22 LTS · TypeScript 5.x (modo estricto)
 *
 * Decisiones de diseño:
 *  - Todas las rutas persistidas (y devueltas al llamador) son RELATIVAS a `rootDir`,
 *    para que el registro en SQLite sea portable entre servidor local y un futuro
 *    montaje SMB/red sin reescribir la base de datos.
 *  - `rename()` se usa como primera opción (operación atómica en el mismo volumen);
 *    se degrada a copy+unlink solo si el rename cruza dispositivos (EXDEV), que es
 *    el único caso realista en un volumen SMB montado con distinto backing store.
 *  - El checksum del `CanonicalStorageResult` se recalcula sobre el archivo ya
 *    escrito en su ubicación final, verificando integridad post-escritura real,
 *    no reutilizando el hash de preprocesamiento a ciegas.
 */

import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

import type {
  CanonicalStorageResult,
  IFileStorageProvider,
  StorageError,
  StorageErrorCode,
} from '../../contracts/IFileStorageProvider';
import type { MetadatosOficio } from '../../contracts/types';

export class LocalStorageError extends Error implements StorageError {
  public readonly code: StorageErrorCode;
  public readonly targetPath?: string;

  constructor(code: StorageErrorCode, message: string, attributes: { targetPath?: string; cause?: unknown } = {}) {
    super(message, { cause: attributes.cause });
    this.name = 'LocalStorageError';
    this.code = code;
    this.targetPath = attributes.targetPath;
  }
}

export interface LocalFileStorageOptions {
  /** Directorio raíz del watchfolder (por defecto: `<cwd>/storage`). */
  rootDir?: string;
}

const STAGE_DIRS = {
  entrada: '01_entrada',
  enProceso: '02_en_proceso',
  procesados: '03_procesados',
  errores: '04_errores',
} as const;

export class LocalFileStorageAdapter implements IFileStorageProvider {
  private readonly rootDir: string;

  constructor(options: LocalFileStorageOptions = {}) {
    this.rootDir = path.resolve(options.rootDir ?? path.join(process.cwd(), 'storage'));
  }

  async saveIncoming(fileName: string, content: Uint8Array): Promise<string> {
    if (content.byteLength === 0) {
      throw new LocalStorageError('INVALID_FILE_NAME', 'El buffer recibido está vacío.');
    }
    const safeName = this.sanitizeFileName(fileName);
    const relativePath = path.join(STAGE_DIRS.entrada, `${Date.now()}_${safeName}`);
    await this.writeAtomic(relativePath, content);
    return relativePath;
  }

  async moveToInProcess(relativeSourcePath: string, targetIdentifier: string): Promise<string> {
    const relativeTarget = path.join(STAGE_DIRS.enProceso, `${targetIdentifier}.pdf`);
    await this.moveFile(relativeSourcePath, relativeTarget);
    return relativeTarget;
  }

  async moveToCanonical(
    currentPath: string,
    year: string,
    month: string,
    canonicalFileName: string,
    metadata: Readonly<MetadatosOficio>
  ): Promise<CanonicalStorageResult> {
    const relativeDir = path.join(STAGE_DIRS.procesados, year, month);
    const relativePdfPath = path.join(relativeDir, canonicalFileName);
    const relativeJsonPath = path.join(relativeDir, canonicalFileName.replace(/\.pdf$/i, '.json'));

    await this.ensureDir(this.resolve(relativeDir));
    await this.moveFile(currentPath, relativePdfPath);

    try {
      await fs.writeFile(this.resolve(relativeJsonPath), JSON.stringify(metadata, null, 2), 'utf-8');
    } catch (cause) {
      throw new LocalStorageError(
        'MIRROR_JSON_WRITE_FAILED',
        `No se pudo escribir el JSON espejo: ${relativeJsonPath}`,
        {
          targetPath: relativeJsonPath,
          cause,
        }
      );
    }

    const finalBytes = await fs.readFile(this.resolve(relativePdfPath));
    const sha256Hash = createHash('sha256').update(finalBytes).digest('hex');

    return {
      canonicalPdfPath: relativePdfPath,
      mirrorJsonPath: relativeJsonPath,
      sha256Hash,
    };
  }

  async moveToError(currentPath: string, reason: string): Promise<string> {
    const baseName = path.basename(currentPath);
    const relativeTarget = path.join(STAGE_DIRS.errores, baseName);
    await this.moveFile(currentPath, relativeTarget, /* allowMissingSource */ true);

    // Trazabilidad del motivo de fallo junto al archivo aislado.
    const reasonPath = `${relativeTarget}.error.txt`;
    await fs.writeFile(this.resolve(reasonPath), `${new Date().toISOString()} :: ${reason}\n`, {
      flag: 'a',
    });

    return relativeTarget;
  }

  async readFile(relativePath: string): Promise<Uint8Array> {
    try {
      return await fs.readFile(this.resolve(relativePath));
    } catch (cause) {
      throw new LocalStorageError('FILE_NOT_FOUND', `Archivo no encontrado: ${relativePath}`, {
        targetPath: relativePath,
        cause,
      });
    }
  }

  async exists(relativePath: string): Promise<boolean> {
    try {
      await fs.access(this.resolve(relativePath));
      return true;
    } catch {
      return false;
    }
  }

  // ---------------------------------------------------------------------
  // Internos
  // ---------------------------------------------------------------------

  private resolve(relativePath: string): string {
    return path.resolve(this.rootDir, relativePath);
  }

  private sanitizeFileName(fileName: string): string {
    const base = path.basename(fileName).trim();
    const cleaned = base.replace(/[\/\\:*?"<>|]/g, '-');
    return cleaned.length > 0 ? cleaned : 'documento.pdf';
  }

  private async ensureDir(absoluteDir: string): Promise<void> {
    try {
      await fs.mkdir(absoluteDir, { recursive: true });
    } catch (cause) {
      throw new LocalStorageError('DIRECTORY_CREATION_FAILED', `No se pudo crear el directorio: ${absoluteDir}`, {
        targetPath: absoluteDir,
        cause,
      });
    }
  }

  private async writeAtomic(relativePath: string, content: Uint8Array): Promise<void> {
    const absolutePath = this.resolve(relativePath);
    await this.ensureDir(path.dirname(absolutePath));
    try {
      await fs.writeFile(absolutePath, content, { flag: 'wx' });
    } catch (cause) {
      const code = (cause as NodeJS.ErrnoException).code;
      throw new LocalStorageError(
        code === 'EEXIST' ? 'FILE_ALREADY_EXISTS' : 'STORAGE_PERMISSION_DENIED',
        `No se pudo escribir el archivo de ingesta: ${relativePath}`,
        { targetPath: relativePath, cause }
      );
    }
  }

  /**
   * Mueve un archivo de forma atómica (rename) dentro del mismo volumen; degrada a
   * copy+unlink únicamente ante EXDEV (cruce de dispositivos, típico en montajes SMB).
   */
  private async moveFile(relativeSource: string, relativeTarget: string, allowMissingSource = false): Promise<void> {
    const absoluteSource = this.resolve(relativeSource);
    const absoluteTarget = this.resolve(relativeTarget);
    await this.ensureDir(path.dirname(absoluteTarget));

    try {
      await fs.rename(absoluteSource, absoluteTarget);
    } catch (cause) {
      const errno = cause as NodeJS.ErrnoException;
      if (errno.code === 'ENOENT' && allowMissingSource) {
        return;
      }
      if (errno.code === 'ENOENT') {
        throw new LocalStorageError('FILE_NOT_FOUND', `Archivo origen no encontrado: ${relativeSource}`, {
          targetPath: relativeSource,
          cause,
        });
      }
      if (errno.code === 'EXDEV') {
        await fs.copyFile(absoluteSource, absoluteTarget);
        await fs.unlink(absoluteSource);
        return;
      }
      throw new LocalStorageError('STORAGE_PERMISSION_DENIED', `No se pudo mover el archivo a: ${relativeTarget}`, {
        targetPath: relativeTarget,
        cause,
      });
    }
  }
}
