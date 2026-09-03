/**
 * SISTEMA OFICIALIA-DIGITAL-DSA — Frontend Svelte 5
 * Estado Reactivo del Split-Screen HITL (Runes)
 * Versión: 1.0.0-MVP
 *
 * Única fuente de verdad del panel de validación humana: mantiene el documento tal como
 * lo persiste el backend (`document.record`), el borrador editable del capturista
 * (`document.draft`), el estado de la UI (`uiStatus`) y los ajustes del visor PDF.js
 * (`viewSettings`). Se sincroniza en tiempo real vía WebSocket y expone
 * `submitConfirmation()` como única puerta de salida hacia `POST /:id/confirm`.
 *
 * Uso (dentro de un componente .svelte, NUNCA a nivel de módulo — ver "Por qué una
 * clase" más abajo):
 *
 *   <script lang="ts">
 *     import { createDocumentHitlState } from '$lib/state/documentState.svelte';
 *     import { DocumentApiClient } from '$lib/api/documentApiClient';
 *
 *     const api = new DocumentApiClient({ baseUrl: 'http://localhost:3000' });
 *     const hitl = createDocumentHitlState(api);
 *
 *     $effect(() => { if (data.documentId) hitl.loadDocument(data.documentId); });
 *   </script>
 *
 *   <button disabled={!hitl.canSubmit} onclick={() => hitl.submitConfirmation(userId)}>
 *     Confirmar y Registrar
 *   </button>
 *
 * Por qué una clase (y no un objeto `$state` suelto a nivel de módulo): `$effect` solo
 * puede registrarse dentro de un "effect root" activo — el árbol de un componente
 * montado. Un singleton de módulo (`export const hitl = new DocumentHitlState()`)
 * se instanciaría en tiempo de import, FUERA de ese árbol, y el `$effect` del
 * constructor lanzaría `effect_orphan`. `createDocumentHitlState()` debe llamarse desde
 * el `<script>` de un componente (root del Split-Screen o un layout), donde SÍ hay un
 * effect root válido; para compartir la misma instancia entre el visor PDF y el
 * formulario sin prop-drilling, pásala por `setContext`/`getContext` de Svelte.
 */

import { getContext, setContext } from 'svelte';

import type { DocumentApiClient } from '../api/documentApiClient';
import { DocumentApiError } from '../api/documentApiClient';
import { MetadatosOficioSchema, type MetadatosOficioDraft } from '../schemas/metadatosOficio.schema';
import { DocumentSocket, type DocumentSocketStatus } from '../ws/documentSocket';
import type { DocumentServerEvent } from '../ws/events';
import { EDITABLE_STATES, LOCKED_STATES, type DocumentoRegistro } from '../types';

const CONTEXT_KEY = Symbol('oficialia:documentHitlState');

/** Ventana dura de debounce tras un intento de envío, en ms — ver §"Estrategia de UI Locking". */
const SUBMIT_DEBOUNCE_MS = 1_500;

/**
 * Borrador vacío usado como último recurso en `applyRecord` cuando un documento no
 * tiene ni `metadatosValidados` ni `metadatosExtraidos` — el único caso real es
 * ERROR_PREPROCESO (el worker de PyMuPDF falló antes de que Gemini extrajera nada). Sin
 * este fallback, `document.draft` se quedaba en `null` y `App.svelte` nunca montaba
 * `HitlReviewView` (que asume `draft` no-nulo en todo el componente — ver su docstring),
 * dejando el documento inalcanzable desde la bandeja de "Errores" pese a aparecer
 * listado ahí. Los campos quedan vacíos y deshabilitados (`formDisabled` ya excluye
 * cualquier estado que no sea PENDIENTE_REVISION/EN_REVISION); lo único accionable es el
 * botón "Reintentar preprocesamiento" (`hitl.canRetryPreprocess`).
 */
const EMPTY_DRAFT: MetadatosOficioDraft = {
  numeroOficio: '',
  fechaEmision: '',
  procedencia: 'HCG',
  dependenciaArea: '',
  remitenteNombre: '',
  remitenteCargo: '',
  destinatarioNombre: '',
  destinatarioCargo: '',
  asunto: '',
  plazoDias: null,
  contieneDatosSensibles: false,
};

export interface DocumentIssue {
  path: string;
  message: string;
}

interface DocumentSlice {
  id: string | null;
  record: DocumentoRegistro | null;
  /** Borrador editable del formulario HITL; `null` hasta que se carga un documento. */
  draft: MetadatosOficioDraft | null;
  pdfUrl: string | null;
}

interface UiStatusSlice {
  loading: boolean;
  /** true mientras el pipeline de salida (RPA/Sheets) corre en el servidor tras confirmar. */
  locked: boolean;
  submitting: boolean;
  error: string | null;
  wsStatus: DocumentSocketStatus;
}

interface ViewSettingsSlice {
  zoom: number;
  rotation: 0 | 90 | 180 | 270;
  currentPage: number;
  totalPages: number;
}

const ZOOM_MIN = 0.5;
const ZOOM_MAX = 3;
const ZOOM_STEP = 0.1;

export class DocumentHitlState {
  // ==========================================================================
  // $state — Estado Global
  // ==========================================================================

  document = $state<DocumentSlice>({ id: null, record: null, draft: null, pdfUrl: null });

  uiStatus = $state<UiStatusSlice>({
    loading: false,
    locked: false,
    submitting: false,
    error: null,
    wsStatus: 'idle',
  });

  viewSettings = $state<ViewSettingsSlice>({ zoom: 1, rotation: 0, currentPage: 1, totalPages: 1 });

  // ==========================================================================
  // $derived — Lógica Derivada
  // ==========================================================================

  /** Validación Zod del borrador en cada tecla — sin ida y vuelta de red. */
  formValidation = $derived.by((): { valid: boolean; issues: DocumentIssue[] } => {
    if (!this.document.draft) return { valid: false, issues: [] };
    const parsed = MetadatosOficioSchema.safeParse(this.document.draft);
    if (parsed.success) return { valid: true, issues: [] };
    return {
      valid: false,
      issues: parsed.error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message })),
    };
  });

  /** Único gate de habilitación del botón "Confirmar y Registrar en Intranet". */
  canSubmit = $derived(
    this.formValidation.valid &&
      !this.uiStatus.locked &&
      !this.uiStatus.submitting &&
      this.document.record !== null &&
      EDITABLE_STATES.has(this.document.record.estado) &&
      this.document.record.estado !== 'ERROR_RPA' // ERROR_RPA reintenta, no reconfirma metadatos
  );

  canRetryRpa = $derived(this.document.record?.estado === 'ERROR_RPA' && !this.uiStatus.submitting);

  /** ERROR_EXTRACCION (p. ej. timeout de Gemini): reintenta render + IA, no requiere metadatos. */
  canRetryExtraction = $derived(this.document.record?.estado === 'ERROR_EXTRACCION' && !this.uiStatus.submitting);

  /** ERROR_PREPROCESO (PDF corrupto/con contraseña): reintenta PyMuPDF/Pillow, no requiere metadatos. */
  canRetryPreprocess = $derived(this.document.record?.estado === 'ERROR_PREPROCESO' && !this.uiStatus.submitting);

  /** Progreso visual (0–100) del pipeline, derivado del estado del WebSocket. */
  pipelineProgress = $derived.by((): number => {
    const estado = this.document.record?.estado;
    const STEPS: Record<string, number> = {
      PENDIENTE_PREPROCESO: 5,
      EN_PREPROCESO: 15,
      PENDIENTE_EXTRACCION: 25,
      EN_EXTRACCION: 45,
      PENDIENTE_REVISION: 60,
      EN_REVISION: 65,
      APROBADO_HITL: 75,
      EN_RPA: 90,
      COMPLETADO: 100,
      ERROR_PREPROCESO: 100,
      ERROR_EXTRACCION: 100,
      ERROR_RPA: 100,
    };
    return estado ? (STEPS[estado] ?? 0) : 0;
  });

  pipelineHasFailed = $derived(
    this.document.record !== null &&
      ['ERROR_PREPROCESO', 'ERROR_EXTRACCION', 'ERROR_RPA'].includes(this.document.record.estado)
  );

  canZoomIn = $derived(this.viewSettings.zoom < ZOOM_MAX);
  canZoomOut = $derived(this.viewSettings.zoom > ZOOM_MIN);

  // ==========================================================================
  // Internos
  // ==========================================================================

  private socket: DocumentSocket | null = null;
  private submitLockUntil = 0;

  constructor(
    private readonly api: DocumentApiClient,
    private readonly options: { onServerEvent?: (event: DocumentServerEvent) => void } = {}
  ) {
    // ------------------------------------------------------------------
    // $effect — Sincronización con el WebSocket
    // ------------------------------------------------------------------
    // Se conecta al montar el componente que instanció este store y se desconecta al
    // destruirlo (la función de retorno de $effect es su cleanup). No depende de
    // `document.id`: el mismo socket permanece abierto entre documentos abiertos en la
    // bandeja — los eventos se filtran por id dentro de `handleServerEvent`.
    //
    // `options.onServerEvent` recibe TODOS los eventos (sin filtrar por documento
    // abierto) antes de `handleServerEvent` — permite que la vista de bandeja
    // (lista de documentos) se refresque en vivo sin abrir un segundo WebSocket.
    $effect(() => {
      this.socket = new DocumentSocket({
        url: this.api.wsUrl,
        onEvent: (event) => {
          this.options.onServerEvent?.(event);
          this.handleServerEvent(event);
        },
        onStatusChange: (status) => {
          this.uiStatus.wsStatus = status;
        },
      });
      this.socket.connect();

      return () => {
        this.socket?.disconnect();
        this.socket = null;
      };
    });
  }

  // ==========================================================================
  // Acciones
  // ==========================================================================

  /** Carga un documento por id, hidrata el borrador y resetea el visor. */
  async loadDocument(documentId: string): Promise<void> {
    this.uiStatus.loading = true;
    this.uiStatus.error = null;
    try {
      const record = await this.api.getDocument(documentId);
      this.applyRecord(record);
      this.document.pdfUrl = this.api.fileUrl(documentId);
      this.viewSettings = { zoom: 1, rotation: 0, currentPage: 1, totalPages: record.preproceso?.pageCount ?? 1 };
    } catch (error) {
      this.uiStatus.error = error instanceof DocumentApiError ? error.message : 'No se pudo cargar el documento.';
    } finally {
      this.uiStatus.loading = false;
    }
  }

  /** Actualiza un campo del borrador HITL; no-op si la UI está bloqueada. */
  updateDraftField<K extends keyof MetadatosOficioDraft>(field: K, value: MetadatosOficioDraft[K]): void {
    if (this.uiStatus.locked || !this.document.draft) return;
    this.document.draft = { ...this.document.draft, [field]: value };
  }

  setZoom(zoom: number): void {
    this.viewSettings.zoom = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, zoom));
  }
  zoomIn(): void {
    this.setZoom(this.viewSettings.zoom + ZOOM_STEP);
  }
  zoomOut(): void {
    this.setZoom(this.viewSettings.zoom - ZOOM_STEP);
  }
  rotate(): void {
    this.viewSettings.rotation = ((this.viewSettings.rotation + 90) % 360) as ViewSettingsSlice['rotation'];
  }
  setPage(page: number): void {
    this.viewSettings.currentPage = Math.min(Math.max(1, page), this.viewSettings.totalPages);
  }

  /**
   * Dispara `POST /:id/confirm`. Única puerta de salida del formulario HITL.
   * Ver "Estrategia de UI Locking" en la respuesta adjunta para el razonamiento completo.
   */
  async submitConfirmation(userId: string): Promise<void> {
    const now = Date.now();

    // Guarda 1 — debounce temporal: ignora clics repetidos dentro de la ventana dura,
    // incluso si `uiStatus.submitting` aún no se propagó al DOM (doble-tap en móvil/touch).
    if (now < this.submitLockUntil) return;
    // Guarda 2 — reentrancia: una petición ya en vuelo.
    if (this.uiStatus.submitting) return;
    // Guarda 3 — invariantes de negocio (formulario inválido, ya bloqueado, fuera de estado editable).
    if (!this.canSubmit || !this.document.record || !this.document.draft) return;

    this.submitLockUntil = now + SUBMIT_DEBOUNCE_MS;
    this.uiStatus.submitting = true;
    this.uiStatus.locked = true; // bloquea edición del formulario de inmediato (optimista)
    this.uiStatus.error = null;

    try {
      const updated = await this.api.confirmDocument(this.document.record.id, {
        metadata: this.document.draft,
        userId,
        expectedVersion: this.document.record.version,
      });
      this.applyRecord(updated); // ya viene en EN_RPA — uiStatus.locked permanece true
    } catch (error) {
      this.uiStatus.error = this.describeError(error);
      // 409 CONCURRENCY_VERSION_CONFLICT: otro capturista ya validó — no reintentar a ciegas.
      if (error instanceof DocumentApiError && error.status === 409) {
        void this.loadDocument(this.document.record.id); // re-sincroniza con el servidor
      } else {
        this.uiStatus.locked = false; // fallo de red/servidor: permite reintentar
      }
    } finally {
      this.uiStatus.submitting = false;
    }
  }

  /** Dispara `POST /:id/retry-rpa` con la misma protección de doble-tap. */
  async retryRpa(): Promise<void> {
    const now = Date.now();
    if (now < this.submitLockUntil || this.uiStatus.submitting) return;
    if (!this.canRetryRpa || !this.document.record) return;

    this.submitLockUntil = now + SUBMIT_DEBOUNCE_MS;
    this.uiStatus.submitting = true;
    this.uiStatus.locked = true;
    this.uiStatus.error = null;

    try {
      const updated = await this.api.retryRpa(this.document.record.id, this.document.record.version);
      this.applyRecord(updated);
    } catch (error) {
      this.uiStatus.error = this.describeError(error);
      this.uiStatus.locked = false;
    } finally {
      this.uiStatus.submitting = false;
    }
  }

  /**
   * Dispara `POST /:id/retry-extraction` con la misma protección de doble-tap — única
   * vía de recuperación para ERROR_EXTRACCION (p. ej. INFERENCE_TIMEOUT de Gemini) sin
   * volver a subir el PDF a mano.
   */
  async retryExtraction(): Promise<void> {
    const now = Date.now();
    if (now < this.submitLockUntil || this.uiStatus.submitting) return;
    if (!this.canRetryExtraction || !this.document.record) return;

    this.submitLockUntil = now + SUBMIT_DEBOUNCE_MS;
    this.uiStatus.submitting = true;
    this.uiStatus.locked = true;
    this.uiStatus.error = null;

    try {
      const updated = await this.api.retryExtraction(this.document.record.id, this.document.record.version);
      this.applyRecord(updated);
    } catch (error) {
      this.uiStatus.error = this.describeError(error);
      this.uiStatus.locked = false;
    } finally {
      this.uiStatus.submitting = false;
    }
  }

  /**
   * Dispara `POST /:id/retry-preprocess` con la misma protección de doble-tap — única
   * vía de recuperación para ERROR_PREPROCESO (PDF corrupto o con contraseña) sin volver
   * a subir el archivo desde cero. Puede seguir fallando (422 PDF_PREPROCESS_FAILED) si
   * el PDF original sigue siendo ilegible; el documento se queda en ERROR_PREPROCESO
   * para reintentar de nuevo tras corregirlo fuera de banda.
   */
  async retryPreprocess(): Promise<void> {
    const now = Date.now();
    if (now < this.submitLockUntil || this.uiStatus.submitting) return;
    if (!this.canRetryPreprocess || !this.document.record) return;

    this.submitLockUntil = now + SUBMIT_DEBOUNCE_MS;
    this.uiStatus.submitting = true;
    this.uiStatus.locked = true;
    this.uiStatus.error = null;

    try {
      const updated = await this.api.retryPreprocess(this.document.record.id, this.document.record.version);
      this.applyRecord(updated);
    } catch (error) {
      this.uiStatus.error = this.describeError(error);
      this.uiStatus.locked = false;
    } finally {
      this.uiStatus.submitting = false;
    }
  }

  // ==========================================================================
  // Internos
  // ==========================================================================

  private applyRecord(record: DocumentoRegistro): void {
    this.document.id = record.id;
    this.document.record = record;
    this.uiStatus.locked = LOCKED_STATES.has(record.estado);

    // El borrador solo se re-hidrata desde el servidor cuando aún no existe (primera
    // carga) o cuando el documento no está en edición activa — evita pisar lo que el
    // capturista está escribiendo si llega un evento de WebSocket a mitad de edición.
    if (!this.document.draft || record.estado === 'EN_RPA' || record.estado === 'COMPLETADO') {
      this.document.draft = (record.metadatosValidados ??
        record.metadatosExtraidos ??
        this.document.draft ??
        EMPTY_DRAFT) as MetadatosOficioDraft;
    }
  }

  private handleServerEvent(event: DocumentServerEvent): void {
    if (event.type === 'HEARTBEAT') return;
    if (!this.document.id || event.documentId !== this.document.id) return; // filtra por doc abierto

    switch (event.type) {
      case 'DOCUMENT_STATE_CHANGED':
      case 'NEW_DOCUMENT_PENDING':
        if (event.document) this.applyRecord(event.document);
        break;
      case 'PIPELINE_ERROR':
        // Mapeo de PIPELINE_ERROR → estado de UI: desbloquea el formulario (si aplica)
        // y expone el mensaje para que el capturista decida reintentar o escalar.
        this.uiStatus.error = `[${event.code}] ${event.message}`;
        if (this.document.record && LOCKED_STATES.has(this.document.record.estado)) {
          this.uiStatus.locked = this.document.record.estado === 'EN_RPA'; // ERROR_RPA se maneja abajo por DOCUMENT_STATE_CHANGED
        }
        break;
      case 'RPA_COMPLETED':
        this.uiStatus.locked = false;
        break;
    }
  }

  private describeError(error: unknown): string {
    if (error instanceof DocumentApiError) return error.message;
    if (error instanceof Error) return error.message;
    return 'Ocurrió un error inesperado al comunicarse con el servidor.';
  }
}

/** Instancia y registra el store en el árbol de componentes actual (ver docstring superior). */
export function createDocumentHitlState(
  api: DocumentApiClient,
  options?: { onServerEvent?: (event: DocumentServerEvent) => void }
): DocumentHitlState {
  const state = new DocumentHitlState(api, options);
  setContext(CONTEXT_KEY, state);
  return state;
}

/** Recupera la instancia más cercana registrada por `createDocumentHitlState`. */
export function getDocumentHitlState(): DocumentHitlState {
  const state = getContext<DocumentHitlState | undefined>(CONTEXT_KEY);
  if (!state) {
    throw new Error('getDocumentHitlState() llamado fuera del árbol de createDocumentHitlState().');
  }
  return state;
}
