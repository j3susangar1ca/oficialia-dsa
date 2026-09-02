/**
 * SISTEMA OFICIALIA-DIGITAL-DSA
 * Adaptador RPA Playwright para integración con Intranet SII HCG (op_cucs.fwx)
 * Implementa: IRpaInjectionProvider
 * Versión: 1.0.0-MVP
 *
 * Implementación real (no placeholder) de la automatización Webix descrita en
 * `docs/rpa/webix_dump_for_qwen.json`: navega a `op_cucs.fwx`, resuelve el iframe
 * `op_ningr.fwx`, rellena los controles Webix por `view id` (cve, nume_cont, fech_ofic,
 * remi_nomb, dest_nomb, asunto, dependen, tipo_ofic, …) y extrae el folio de acuse.
 *
 * No sustituye por defecto al `PlaywrightRpaInjectionAdapter` (placeholder) en el
 * composition root (`server.ts`): requiere un `Browser` de Playwright ya lanzado y
 * credenciales/selectores validados contra la Intranet real. Se activa explícitamente
 * con `RPA_MODE=playwright` (ver `presentation/config/env.ts` y `.env.example`) — sin
 * esa variable, el servidor sigue arrancando con el stub honesto que reporta
 * `checkIntranetHealth() === false`.
 *
 * `tsconfig.json` del backend usa `lib: ["ES2023"]` (sin DOM, correcto para un proceso
 * Node). Las funciones pasadas a `frame.evaluate()`/`page.evaluate()` en este archivo,
 * en cambio, se serializan y ejecutan DENTRO del navegador (contexto Webix), donde
 * `window`/`document` sí existen — de ahí esta referencia local, que no afecta al
 * resto del backend.
 */
/// <reference lib="dom" />

import type {
  Browser,
  BrowserContext,
  Page,
  Frame,
  Dialog,
  Response as PlaywrightResponse
} from 'playwright';

import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import type { MetadatosOficio, RpaEjecucion } from '../../contracts/types';
import type {
  IRpaInjectionProvider,
  RpaInjectionPayload,
  RpaExecutionOptions,
  RpaErrorCode,
  RpaExecutionError as IRpaExecutionError
} from '../../contracts/IRpaInjectionProvider';

const INTRANET_DEFAULT_BASE_URL = 'https://sii.hcg.gob.mx/intranet/op_cucs.fwx';
const FRAME_SELECTOR = 'iframe[src*="op_ningr.fwx"]';

/**
 * Regex para detectar folios institucionales comunes.
 * Ejemplo esperado: HCG-OP-2026-009821
 */
const FOLIO_REGEX =
  /(HCG-OP-\d{4}-\d{4,}|[A-Z]{2,}(?:[-/][A-Z0-9]+)*-\d{4}-\d{3,})/;

type WebixValue = string | number | boolean | null | string[];

export interface PlaywrightRpaAdapterConfig {
  baseUrl?: string;
  username?: string;
  password?: string;
  oficialiaCve?: string;
  hcgDependenciaCve?: string;
  seccionCve?: string;
  storageRoot?: string;
  defaultNavigationTimeoutMs?: number;
  defaultActionTimeoutMs?: number;
}

interface DialogState {
  folio: string | null;
  dialogSeen: Promise<void>;
  resolveDialog: () => void;
  handler: (dialog: Dialog) => Promise<void>;
}

/**
 * Error concreto del adaptador RPA.
 * Implementa el contrato RpaExecutionError definido en el puerto.
 */
export class RpaExecutionError extends Error implements IRpaExecutionError {
  public readonly code: RpaErrorCode;
  public readonly screenshotErrorPath?: string;
  public readonly attemptCount: number;
  public readonly durationMs: number;

  constructor(init: IRpaExecutionError) {
    super(init.message);
    this.name = 'RpaExecutionError';
    this.code = init.code;
    this.screenshotErrorPath = init.screenshotErrorPath;
    this.attemptCount = init.attemptCount;
    this.durationMs = init.durationMs;

    if (init.cause !== undefined) {
      (this as { cause?: unknown }).cause = init.cause;
    }
  }
}

export class PlaywrightRpaAdapter implements IRpaInjectionProvider {
  /**
   * Explicaciones accionables por código, usadas SOLO por `normalizeError` para los
   * errores clasificados automáticamente a partir de un mensaje crudo (Playwright/red) —
   * no para los `createError(...)` explícitos de este archivo, que ya redactan el suyo.
   */
  private static readonly FRIENDLY_ERROR_PREFIX: Partial<Record<RpaErrorCode, string>> = {
    INTRANET_AUTH_FAILED:
      'Credenciales de la Intranet rechazadas por el servidor (HTTP Basic/Digest). Verifique ' +
      'INTRANET_HTTP_USERNAME/INTRANET_HTTP_PASSWORD (o los alias RPA_INTRANET_USER/RPA_INTRANET_PASSWORD). ' +
      'Si op_cucs.fwx usa autenticación integrada de Windows (NTLM) en vez de Basic/Digest, `httpCredentials` de ' +
      'Playwright no es el mecanismo correcto: se requiere habilitar NTLM/Negotiate para este host ' +
      '(flag de Chromium --auth-server-whitelist) y, normalmente, un usuario con formato DOMINIO\\usuario.',
    INTRANET_UNREACHABLE_OR_OFFLINE:
      'La Intranet no respondió o la red institucional (VPN/LAN hospitalaria) no es alcanzable desde este servidor.',
    SESSION_EXPIRED: 'La sesión contra la Intranet expiró o fue rechazada (posible cierre de sesión concurrente).',
  };

  constructor(
    private readonly browser: Browser,
    private readonly config: PlaywrightRpaAdapterConfig = {}
  ) {}

  // ------------------------------------------------------------------
  // IRpaInjectionProvider
  // ------------------------------------------------------------------

  async injectDocument(
    payload: RpaInjectionPayload,
    options?: RpaExecutionOptions
  ): Promise<Readonly<RpaEjecucion>> {
    const executionId = randomUUID();
    return this.executeWithRetries(payload, options, 1, executionId);
  }

  async retryInjection(
    previousExecutionId: string,
    payload: RpaInjectionPayload,
    options?: RpaExecutionOptions
  ): Promise<Readonly<RpaEjecucion>> {
    // previousExecutionId se conserva para trazabilidad en logs externos si se desea.
    void previousExecutionId;

    const executionId = randomUUID();
    return this.executeWithRetries(payload, options, 2, executionId);
  }

  async checkIntranetHealth(): Promise<boolean> {
    let context: BrowserContext | undefined;

    try {
      context = await this.createBrowserContext();
      const page = await context.newPage();
      const response = await page.goto(this.baseUrl, {
        waitUntil: 'domcontentloaded',
        timeout: 15_000
      });

      return Boolean(response && response.status() < 400);
    } catch {
      return false;
    } finally {
      await context?.close().catch(() => undefined);
    }
  }

  // ------------------------------------------------------------------
  // Orquestación interna con reintentos
  // ------------------------------------------------------------------

  private async executeWithRetries(
    payload: RpaInjectionPayload,
    options: RpaExecutionOptions | undefined,
    baseAttempt: number,
    executionId: string
  ): Promise<Readonly<RpaEjecucion>> {
    const timeoutMs =
      options?.timeoutMs ??
      this.config.defaultActionTimeoutMs ??
      90_000;

    const maxRetries = Math.max(1, options?.maxRetries ?? 3);
    const startedAt = Date.now();

    let lastError: unknown = null;

    for (let attemptIndex = 0; attemptIndex < maxRetries; attemptIndex += 1) {
      const attemptNumber = baseAttempt + attemptIndex;
      let context: BrowserContext | undefined;

      try {
        context = await this.createBrowserContext();
        const page = await context.newPage();
        page.setDefaultTimeout(timeoutMs);

        const result = await this.performInjection(
          page,
          payload,
          executionId,
          attemptNumber,
          timeoutMs
        );

        return {
          ...result,
          intentos: attemptNumber,
          duracionMs: Date.now() - startedAt
        };
      } catch (error) {
        lastError = error;

        const isLastAttempt = attemptIndex === maxRetries - 1;

        if (!this.isTransientError(error) || isLastAttempt) {
          throw this.normalizeError(error, attemptNumber, Date.now() - startedAt);
        }

        const backoff = Math.min(1000 * 2 ** attemptIndex, 5000);
        await this.delay(backoff);
      } finally {
        await context?.close().catch(() => undefined);
      }
    }

    throw this.normalizeError(
      lastError ?? new Error('Fallo RPA desconocido'),
      baseAttempt + maxRetries - 1,
      Date.now() - startedAt
    );
  }

  private async performInjection(
    page: Page,
    payload: RpaInjectionPayload,
    executionId: string,
    attemptNumber: number,
    timeoutMs: number
  ): Promise<Omit<RpaEjecucion, 'intentos' | 'duracionMs'>> {
    const startedAt = Date.now();
    const dialogs = this.registerDialogHandler(page);

    try {
      const response = await page.goto(this.baseUrl, {
        waitUntil: 'domcontentloaded',
        timeout: timeoutMs
      });

      this.assertNavigationResponse(response);

      const frame = await this.resolveOpNingrFrame(page, timeoutMs);
      await this.waitForWebixReady(frame, timeoutMs);

      await this.fillWebixForm(frame, payload.metadata);
      await this.attachCanonicalPdfIfUploadControlExists(page, frame, payload.canonicalPdfPath);

      await this.submitForm(frame, timeoutMs);
      await this.stabilizeAfterSubmit(page, dialogs, timeoutMs);

      const folio = await this.extractConfirmationFolio(page, dialogs, timeoutMs);

      const capturaAcusePath = await this.saveEvidence(
        page,
        executionId,
        '03_procesados',
        'acuse'
      );

      // `intentos` y `duracionMs` los añade `executeWithRetries` al desenvolver esta
      // promesa (ahí se conoce el número de intento real y la duración total con
      // reintentos incluidos) — de ahí el `Omit<RpaEjecucion, 'intentos' | 'duracionMs'>`
      // en la firma de este método.
      return {
        id: executionId,
        documentoId: payload.documentId,
        folioAcuseInstitucional: folio,
        fechaEjecucion: new Date().toISOString(),
        capturaAcusePath,
        mensajeError: null,
        exitoso: true
      };
    } catch (error) {
      const screenshotErrorPath = await this.saveEvidence(
        page,
        executionId,
        '04_errores',
        'error'
      ).catch(() => undefined);

      throw this.normalizeError(
        error,
        attemptNumber,
        Date.now() - startedAt,
        screenshotErrorPath
      );
    } finally {
      page.removeListener('dialog', dialogs.handler);
    }
  }

  // ------------------------------------------------------------------
  // Sesión, navegación y detección de Webix
  // ------------------------------------------------------------------

  private get baseUrl(): string {
    return (
      this.config.baseUrl ??
      process.env.INTRANET_BASE_URL ??
      INTRANET_DEFAULT_BASE_URL
    );
  }

  private async createBrowserContext(): Promise<BrowserContext> {
    const httpCredentials = this.resolveHttpCredentials();

    return this.browser.newContext({
      ...(httpCredentials ? { httpCredentials } : {}),
      ignoreHTTPSErrors: true,
      viewport: { width: 1920, height: 1080 },
      locale: 'es-MX',
      timezoneId: 'America/Mexico_City'
    });
  }

  private resolveHttpCredentials():
    | { username: string; password: string }
    | undefined {
    const username =
      this.config.username ??
      process.env.INTRANET_HTTP_USERNAME ??
      process.env.RPA_INTRANET_USER;

    const password =
      this.config.password ??
      process.env.INTRANET_HTTP_PASSWORD ??
      process.env.RPA_INTRANET_PASSWORD;

    if (!username || !password) {
      return undefined;
    }

    return { username, password };
  }

  private assertNavigationResponse(response: PlaywrightResponse | null): void {
    if (!response) {
      throw this.createError(
        'INTRANET_UNREACHABLE_OR_OFFLINE',
        'No se recibió respuesta HTTP de la Intranet.'
      );
    }

    const status = response.status();

    if (status === 401) {
      throw this.createError(
        'INTRANET_AUTH_FAILED',
        `Autenticación fallida (HTTP ${status}).`
      );
    }

    if (status === 403) {
      throw this.createError(
        'SESSION_EXPIRED',
        `Acceso denegado o sesión expirada (HTTP ${status}).`
      );
    }

    if (status >= 500) {
      throw this.createError(
        'INTRANET_UNREACHABLE_OR_OFFLINE',
        `Error de servidor en Intranet (HTTP ${status}).`
      );
    }

    if (status >= 400) {
      throw this.createError(
        'INTRANET_UNREACHABLE_OR_OFFLINE',
        `Respuesta inesperada de Intranet (HTTP ${status}).`
      );
    }
  }

  private async resolveOpNingrFrame(page: Page, timeoutMs: number): Promise<Frame> {
    const iframeHandle = await page.waitForSelector(FRAME_SELECTOR, {
      state: 'attached',
      timeout: timeoutMs
    });

    const frame = await iframeHandle.contentFrame();

    if (!frame) {
      throw this.createError(
        'WEBIX_FORM_TIMEOUT',
        'No fue posible obtener el contentFrame del iframe op_ningr.fwx.'
      );
    }

    return frame;
  }

  private async waitForWebixReady(frame: Frame, timeoutMs: number): Promise<void> {
    await frame.waitForFunction(
      () => {
        const w = (window as any).webix;
        return Boolean(
          w &&
            typeof w.$$ === 'function' &&
            w.$$('frm1') &&
            w.$$('btnGuardar') &&
            w.$$('cve')
        );
      },
      undefined,
      { timeout: timeoutMs }
    );
  }

  // ------------------------------------------------------------------
  // Inyección de datos en Webix
  // ------------------------------------------------------------------

  private async fillWebixForm(
    frame: Frame,
    metadata: Readonly<MetadatosOficio>
  ): Promise<void> {
    const now = new Date();

    const oficialiaCve = await this.resolveOficialiaCve(frame);
    if (!oficialiaCve) {
      throw this.createError(
        'WEBIX_FORM_TIMEOUT',
        'No fue posible resolver la oficialía (campo Webix cve).'
      );
    }

    // Campos base del formulario op_ningr.fwx
    await this.setWebixValue(frame, 'cve', oficialiaCve);
    await this.setOptionalWebixValue(frame, 'oficio_bis', false);

    await this.setWebixValue(frame, 'anio_ingr', String(now.getFullYear()));
    await this.setWebixValue(frame, 'nume_cont', metadata.numeroOficio);

    await this.setWebixValue(
      frame,
      'fech_ofic',
      this.formatDate(this.parseIsoDate(metadata.fechaEmision))
    );

    await this.setWebixValue(frame, 'info_sens', metadata.contieneDatosSensibles ? '1' : '0');
    await this.setWebixValue(frame, 'tipo_info', '0');

    await this.setWebixValue(frame, 'fech_rece', this.formatDate(now));
    await this.setWebixValue(frame, 'hora_rece', this.formatTime(now));
    await this.setWebixValue(frame, 'nume_ofic', metadata.numeroOficio);

    // Limpieza de ligados por si la sesión arrastra valores previos
    await this.setOptionalWebixValue(frame, 'cmbLiga_ofic', '');
    await this.setOptionalWebixValue(frame, 'liga_sali', []);
    await this.setOptionalWebixValue(frame, 'liga_entr', []);

    // Procedencia / dependencia
    await this.setWebixValue(frame, 'rbDepe', metadata.procedencia === 'HCG' ? '1' : '2');
    await this.delay(50);
    await this.applyDependencia(frame, metadata);

    // Remitente
    await this.setWebixValue(frame, 'remi_nomb', this.cleanText(metadata.remitenteNombre));
    await this.setWebixValue(frame, 'remi_carg', this.cleanText(metadata.remitenteCargo));

    // Destinatario
    await this.setWebixValue(frame, 'dest_nomb', this.cleanText(metadata.destinatarioNombre));
    await this.setWebixValue(frame, 'dest_carg', this.cleanText(metadata.destinatarioCargo));

    // Tipo de oficio con lógica especial:
    // - plazoDias > 0 => "5" (CON TERMINO)
    // - resto        => "1" (ORIGINAL)
    const tipoOficio =
      metadata.plazoDias !== null && metadata.plazoDias > 0 ? '5' : '1';

    await this.setWebixValue(frame, 'tipo_ofic', tipoOficio);
    await this.delay(50);

    if (tipoOficio === '5' && metadata.plazoDias !== null && metadata.plazoDias > 0) {
      const fechaTermino = this.addDays(
        this.parseIsoDate(metadata.fechaEmision),
        metadata.plazoDias
      );

      const fechaTerminoStr = this.formatDate(fechaTermino);

      await this.setOptionalWebixValue(frame, 'fech_term', fechaTerminoStr);
      await this.setOptionalWebixValue(frame, 'txtFech_term', fechaTerminoStr);
    }

    await this.setWebixValue(
      frame,
      'clase',
      /INVITACI[ÓO]N/i.test(metadata.asunto) ? '5' : '4'
    );

    await this.setWebixValue(frame, 'tipo_ingr', '0');

    await this.setWebixValue(frame, 'asunto', this.cleanText(metadata.asunto));

    const seccionCve = this.config.seccionCve ?? process.env.RPA_SECCION_CVE;
    if (seccionCve) {
      await this.setOptionalWebixValue(frame, 'seccion', seccionCve);
    }

    await this.setOptionalWebixValue(
      frame,
      'nota',
      metadata.plazoDias !== null && metadata.plazoDias > 0
        ? `PLAZO ESTIPULADO: ${metadata.plazoDias} DÍA(S)`
        : ''
    );

    await this.setOptionalWebixValue(frame, 'ligado_a', '');
  }

  private async applyDependencia(frame: Frame, metadata: Readonly<MetadatosOficio>): Promise<void> {
    const dependencia = this.cleanText(metadata.dependenciaArea);

    if (metadata.procedencia === 'HCG') {
      const hcgDependenciaCve =
        this.config.hcgDependenciaCve ?? process.env.RPA_HCG_DEPENDENCIA_CVE;

      if (hcgDependenciaCve) {
        await this.setWebixValue(frame, 'dependen', hcgDependenciaCve);
      } else {
        await this.setWebixComboByText(frame, 'dependen', dependencia);
      }
    } else {
      await this.setOptionalWebixValue(frame, 'txtDepen', dependencia);
      await this.setOptionalWebixValue(frame, 'dependen', dependencia);
    }
  }

  private async resolveOficialiaCve(frame: Frame): Promise<string> {
    const configured = this.config.oficialiaCve ?? process.env.RPA_OFICIALIA_CVE;
    if (configured) return configured;

    try {
      await frame.waitForFunction(
        () => {
          const control = (window as any).webix?.$$('cve');
          const list = control?.getList?.();
          return Boolean(list?.getFirstData?.());
        },
        undefined,
        { timeout: 5000 }
      );
    } catch {
      // Si no hay opciones cargadas, se intenta recuperar igualmente y se valida después.
    }

    return frame.evaluate(() => {
      const control = (window as any).webix?.$$('cve');
      const list = control?.getList?.();
      return list?.getFirstData?.()?.id ?? '';
    });
  }

  private async setWebixValue(
    frame: Frame,
    viewId: string,
    value: WebixValue
  ): Promise<void> {
    await frame.evaluate(
      ([id, val]: [string, WebixValue]) => {
        const w = (window as any).webix;

        if (!w || typeof w.$$ !== 'function') {
          throw new Error('webix API no está disponible en el iframe.');
        }

        const control = w.$$(id);
        if (!control) {
          throw new Error(`Webix control no encontrado: ${id}`);
        }

        if (typeof control.setValue !== 'function') {
          throw new Error(`Webix control sin setValue: ${id}`);
        }

        control.setValue(val);
      },
      [viewId, value] as [string, WebixValue]
    );
  }

  private async setOptionalWebixValue(
    frame: Frame,
    viewId: string,
    value: WebixValue
  ): Promise<void> {
    try {
      await this.setWebixValue(frame, viewId, value);
    } catch {
      // Campo opcional / oculto: no bloquear el flujo.
    }
  }

  private async setWebixComboByText(
    frame: Frame,
    viewId: string,
    text: string
  ): Promise<void> {
    await frame.evaluate(
      ([id, searchText]: [string, string]) => {
        const w = (window as any).webix;

        if (!w || typeof w.$$ !== 'function') {
          throw new Error('webix API no está disponible en el iframe.');
        }

        const control = w.$$(id);
        if (!control) {
          throw new Error(`Webix control no encontrado: ${id}`);
        }

        const normalize = (value: unknown) => String(value ?? '').toUpperCase();
        const target = normalize(searchText);

        const list = control.getList?.();

        if (list && typeof list.find === 'function') {
          const match = list.find((item: any) => {
            const value = normalize(item?.value);
            const label = normalize(item?.label);
            return value.includes(target) || label.includes(target);
          });

          if (match?.id) {
            control.setValue(match.id);
            return;
          }
        }

        control.setValue(searchText);
      },
      [viewId, text] as [string, string]
    );
  }

  private async attachCanonicalPdfIfUploadControlExists(
    page: Page,
    frame: Frame,
    canonicalPdfPath: string
  ): Promise<void> {
    const candidates = [
      frame.locator('input[type="file"]').first(),
      page.locator('input[type="file"]').first()
    ];

    for (const candidate of candidates) {
      const count = await candidate.count();

      if (count > 0) {
        try {
          await candidate.setInputFiles(canonicalPdfPath, { timeout: 5000 });
          return;
        } catch (error) {
          throw this.createError(
            'FILE_UPLOAD_FAILED',
            `No fue posible adjuntar el PDF canónico: ${
              error instanceof Error ? error.message : String(error)
            }`,
            1,
            0,
            undefined,
            error
          );
        }
      }
    }

    // Si no existe input file visible, se asume que la pantalla legacy no requiere adjuntar archivo.
  }

  // ------------------------------------------------------------------
  // Submit, diálogos nativos, confirmación y folio
  // ------------------------------------------------------------------

  private async submitForm(frame: Frame, timeoutMs: number): Promise<void> {
    const saveButton = frame.locator('button:has-text("Ingresar oficio")').first();

    try {
      await saveButton.waitFor({ state: 'visible', timeout: Math.min(timeoutMs, 5000) });
      await saveButton.click({ timeout: timeoutMs });
    } catch {
      await frame.evaluate(() => {
        const control = (window as any).webix?.$$('btnGuardar');

        if (!control) {
          throw new Error('Webix control no encontrado: btnGuardar');
        }

        if (typeof control.callEvent === 'function') {
          control.callEvent('onItemClick', []);
        } else if (typeof control.click === 'function') {
          control.click();
        } else {
          throw new Error('btnGuardar no expone mecanismo de click.');
        }
      });
    }
  }

  private registerDialogHandler(page: Page): DialogState {
    let resolveDialog: () => void = () => undefined;

    const dialogSeen = new Promise<void>((resolve) => {
      resolveDialog = resolve;
    });

    const state: DialogState = {
      folio: null,
      dialogSeen,
      resolveDialog,
      handler: async () => undefined
    };

    state.handler = async (dialog: Dialog) => {
      const message = dialog.message();
      const folio = this.parseFolio(message);

      if (folio) {
        state.folio = folio;
      }

      await dialog.accept().catch(() => undefined);
      state.resolveDialog();
    };

    page.on('dialog', state.handler);

    return state;
  }

  private async stabilizeAfterSubmit(
    page: Page,
    dialogs: DialogState,
    timeoutMs: number
  ): Promise<void> {
    const waitMs = Math.min(timeoutMs, 2500);

    await Promise.race([
      dialogs.dialogSeen,
      page.waitForLoadState('networkidle', { timeout: waitMs }).catch(() => undefined),
      this.delay(waitMs)
    ]);
  }

  private async extractConfirmationFolio(
    page: Page,
    dialogs: DialogState,
    timeoutMs: number
  ): Promise<string> {
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      if (dialogs.folio) {
        return dialogs.folio;
      }

      const folio = await this.readFolioFromPageAndFrames(page);
      if (folio) {
        return folio;
      }

      await this.delay(250);
    }

    if (dialogs.folio) {
      return dialogs.folio;
    }

    throw this.createError(
      'CONFIRMATION_FOLIO_NOT_FOUND',
      'No fue posible extraer el folio institucional de confirmación.'
    );
  }

  private async readFolioFromPageAndFrames(page: Page): Promise<string | null> {
    const candidates: Array<Page | Frame> = [page, ...page.frames()];

    for (const candidate of candidates) {
      const text = await candidate
        .evaluate(() => document.body?.innerText ?? '')
        .catch(() => '');

      const folioFromText = this.parseFolio(text);
      if (folioFromText) {
        return folioFromText;
      }

      const folioFromUrl = this.parseFolio(candidate.url());
      if (folioFromUrl) {
        return folioFromUrl;
      }
    }

    return null;
  }

  private parseFolio(text: string | null | undefined): string | null {
    if (!text) return null;

    const normalized = text.toUpperCase().replace(/\s+/g, ' ');
    const match = normalized.match(FOLIO_REGEX);

    return match?.[0] ?? null;
  }

  // ------------------------------------------------------------------
  // Evidencia / almacenamiento de acuses
  // ------------------------------------------------------------------

  private async saveEvidence(
    page: Page,
    uuid: string,
    stage: '03_procesados' | '04_errores',
    prefix: 'acuse' | 'error'
  ): Promise<string> {
    const now = new Date();
    const year = String(now.getFullYear());
    const month = String(now.getMonth() + 1).padStart(2, '0');

    const directory = path.join(
      process.cwd(),
      this.config.storageRoot ?? 'storage',
      stage,
      year,
      month
    );

    await mkdir(directory, { recursive: true });

    const filePath = path.join(directory, `${prefix}_${uuid}.png`);

    await page
      .waitForLoadState('networkidle', { timeout: 2500 })
      .catch(() => undefined);

    await page.screenshot({ path: filePath, fullPage: true });

    return filePath;
  }

  // ------------------------------------------------------------------
  // Manejo de errores y utilidades
  // ------------------------------------------------------------------

  private createError(
    code: RpaErrorCode,
    message: string,
    attemptCount = 1,
    durationMs = 0,
    screenshotErrorPath?: string,
    cause?: unknown
  ): RpaExecutionError {
    return new RpaExecutionError({
      code,
      message,
      screenshotErrorPath,
      attemptCount,
      durationMs,
      cause
    });
  }

  private normalizeError(
    error: unknown,
    attemptCount: number,
    durationMs: number,
    screenshotErrorPath?: string
  ): RpaExecutionError {
    if (error instanceof RpaExecutionError) {
      return new RpaExecutionError({
        code: error.code,
        message: error.message,
        screenshotErrorPath: screenshotErrorPath ?? error.screenshotErrorPath,
        attemptCount,
        durationMs,
        cause: (error as { cause?: unknown }).cause
      });
    }

    const message = error instanceof Error ? error.message : String(error);
    const code = this.classifyError(error, message);
    const friendlyPrefix = PlaywrightRpaAdapter.FRIENDLY_ERROR_PREFIX[code];

    return new RpaExecutionError({
      code,
      // A diferencia de los `createError(...)` explícitos de este archivo (que ya
      // redactan su propio mensaje accionable), los errores clasificados aquí llegan
      // con el texto crudo del proveedor/Playwright (p. ej.
      // "page.goto: net::ERR_INVALID_AUTH_CREDENTIALS at ..."). Se antepone una
      // explicación en español sin descartar el detalle técnico — sigue disponible en
      // `mensajeError` para depurar, pero el capturista ve primero qué hacer.
      message: friendlyPrefix !== undefined ? `${friendlyPrefix} Detalle: ${message}` : message,
      screenshotErrorPath,
      attemptCount,
      durationMs,
      cause: error
    });
  }

  private classifyError(error: unknown, message: string): RpaErrorCode {
    const name = (error as { name?: string })?.name ?? '';

    if (name === 'TimeoutError' || /timeout/i.test(message)) {
      return 'WEBIX_FORM_TIMEOUT';
    }

    if (/401|auth|credentials/i.test(message)) {
      return 'INTRANET_AUTH_FAILED';
    }

    if (/session|login|expired/i.test(message)) {
      return 'SESSION_EXPIRED';
    }

    if (/net::ERR|ECONN|ENOTFOUND|EAI_AGAIN|offline/i.test(message)) {
      return 'INTRANET_UNREACHABLE_OR_OFFLINE';
    }

    if (/setInputFiles|file|upload/i.test(message)) {
      return 'FILE_UPLOAD_FAILED';
    }

    if (/folio/i.test(message)) {
      return 'CONFIRMATION_FOLIO_NOT_FOUND';
    }

    if (/webix|evaluation failed|frame|selector/i.test(message)) {
      return 'WEBIX_FORM_TIMEOUT';
    }

    return 'TARGET_CLOSED_OR_CRASHED';
  }

  private isTransientError(error: unknown): boolean {
    if (error instanceof RpaExecutionError) {
      switch (error.code) {
        case 'WEBIX_FORM_TIMEOUT':
        case 'INTRANET_UNREACHABLE_OR_OFFLINE':
        case 'TARGET_CLOSED_OR_CRASHED':
        case 'SESSION_EXPIRED':
          return true;
        default:
          return false;
      }
    }

    const message = error instanceof Error ? error.message : String(error);
    const name = (error as { name?: string })?.name ?? '';

    return (
      name === 'TimeoutError' ||
      /timeout|net::ERR|ECONN|target closed|frame|webix/i.test(message)
    );
  }

  private parseIsoDate(iso: string): Date {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);

    if (!match) {
      throw this.createError('WEBIX_FORM_TIMEOUT', `Fecha inválida: ${iso}`);
    }

    const date = new Date(
      Number(match[1]),
      Number(match[2]) - 1,
      Number(match[3])
    );

    if (Number.isNaN(date.getTime())) {
      throw this.createError('WEBIX_FORM_TIMEOUT', `Fecha inválida: ${iso}`);
    }

    return date;
  }

  private formatDate(date: Date): string {
    const dd = String(date.getDate()).padStart(2, '0');
    const mm = String(date.getMonth() + 1).padStart(2, '0');
    const yyyy = String(date.getFullYear());

    return `${dd}/${mm}/${yyyy}`;
  }

  private formatTime(date: Date): string {
    const hh = String(date.getHours()).padStart(2, '0');
    const mi = String(date.getMinutes()).padStart(2, '0');

    return `${hh}:${mi}`;
  }

  private addDays(date: Date, days: number): Date {
    const copy = new Date(date.getTime());
    copy.setDate(copy.getDate() + days);
    return copy;
  }

  private cleanText(value: string): string {
    return value
      .toUpperCase()
      .replace(/\s+/g, ' ')
      .trim();
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}