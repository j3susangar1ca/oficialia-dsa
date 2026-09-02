<script lang="ts">
  // ============================================================
  // HitlReviewView.svelte — Oficialia-Digital-DSA
  // Validación Human-in-the-Loop (HITL): Split-Screen — visor PDF.js (izq) +
  // formulario reactivo (der). Consume `DocumentHitlState` directamente (en vez de
  // mantener su propio `$state` de formulario/validación duplicado): un solo borrador
  // (`hitl.document.draft`), una sola validación (`hitl.formValidation`, Zod) y una sola
  // puerta de salida (`hitl.submitConfirmation`) compartidas con el resto de la app.
  // Svelte 5 (Runes) · TypeScript · Tailwind CSS · pdfjs-dist
  // ============================================================

  import { onMount, onDestroy } from 'svelte';
  import * as pdfjsLib from 'pdfjs-dist';
  import PdfWorker from 'pdfjs-dist/build/pdf.worker.min.mjs?url';

  import type { DocumentHitlState } from '$lib/state/documentState.svelte';
  import type { DocumentApiClient } from '$lib/api/documentApiClient';
  import type { DocumentoRelacionado, ModeloEstado } from '$lib/types';
  import type { MetadatosOficioDraft } from '$lib/schemas/metadatosOficio.schema';
  import { estadoMeta, formatRelativeTime } from '$lib/estadoMeta';

  pdfjsLib.GlobalWorkerOptions.workerSrc = PdfWorker;

  interface Props {
    hitl: DocumentHitlState;
    api: DocumentApiClient;
    userId: string;
    oncancel?: () => void;
  }

  let { hitl, api, userId, oncancel }: Props = $props();

  // Atajos tipados: el documento y borrador siempre existen mientras este componente
  // está montado (App.svelte solo lo renderiza cuando ambos son no-nulos).
  const documento = $derived(hitl.document.record!);
  const draft = $derived(hitl.document.draft as MetadatosOficioDraft);
  const meta = $derived(estadoMeta(documento.estado));

  // `uiStatus.locked` solo cubre APROBADO_HITL/EN_RPA (pipeline de salida en curso).
  // Solo PENDIENTE_REVISION/EN_REVISION admiten editar Y confirmar; ERROR_RPA está en
  // `EDITABLE_STATES` (es "consultable", ver su comentario en types.ts) pero
  // `canSubmit` lo excluye a propósito — ahí solo cabe reintentar el RPA, no reconfirmar
  // metadatos — y COMPLETADO/ERROR_* de preproceso o extracción son puramente de
  // lectura. Sin este `formDisabled`, esos campos quedaban editables en pantalla aunque
  // cualquier cambio se descartara en silencio (el botón de confirmar ya estaba
  // deshabilitado, pero no lo estaba el input).
  const formDisabled = $derived(
    hitl.uiStatus.locked || (documento.estado !== 'PENDIENTE_REVISION' && documento.estado !== 'EN_REVISION')
  );

  // ============================================================
  // 1) CAMPOS TOCADOS + ERRORES (validación vive en `hitl.formValidation`)
  // ============================================================

  let tocadas = $state<Record<string, boolean>>({});

  const errorsByField = $derived.by((): Record<string, string> => {
    const map: Record<string, string> = {};
    for (const issue of hitl.formValidation.issues) {
      if (!(issue.path in map)) map[issue.path] = issue.message;
    }
    return map;
  });

  function tocar(campo: string): void {
    tocadas = { ...tocadas, [campo]: true };
  }
  function errVisible(campo: string): string | null {
    return tocadas[campo] ? (errorsByField[campo] ?? null) : null;
  }

  function set<K extends keyof MetadatosOficioDraft>(field: K, value: MetadatosOficioDraft[K]): void {
    hitl.updateDraftField(field, value);
  }

  // Normalización visual en vivo (mayúsculas / sanitización), igual a las reglas del
  // contrato Zod del backend — puramente cosmético mientras se escribe; la validación
  // real y la normalización autoritativa las aplica el servidor al confirmar.
  $effect(() => {
    const d = hitl.document.draft;
    if (!d || formDisabled) return;
    const upper = (v: string) => v.toUpperCase();

    if (d.dependenciaArea && d.dependenciaArea !== upper(d.dependenciaArea)) set('dependenciaArea', upper(d.dependenciaArea));
    if (d.remitenteNombre && d.remitenteNombre !== upper(d.remitenteNombre)) set('remitenteNombre', upper(d.remitenteNombre));
    if (d.remitenteCargo && d.remitenteCargo !== upper(d.remitenteCargo)) set('remitenteCargo', upper(d.remitenteCargo));
    if (d.destinatarioNombre && d.destinatarioNombre !== upper(d.destinatarioNombre))
      set('destinatarioNombre', upper(d.destinatarioNombre));
    if (d.destinatarioCargo && d.destinatarioCargo !== upper(d.destinatarioCargo))
      set('destinatarioCargo', upper(d.destinatarioCargo));

    const folioLimpio = (d.numeroOficio ?? '').replace(/[\/\\:*?"<>|]/g, '-');
    if (d.numeroOficio !== folioLimpio) set('numeroOficio', folioLimpio);
  });

  function onPlazoInput(e: Event): void {
    const input = e.target as HTMLInputElement;
    const raw = input.value.trim();
    if (raw === '') {
      set('plazoDias', null);
      return;
    }
    const n = Number(raw);
    if (Number.isFinite(n) && n >= 0) set('plazoDias', Math.floor(n));
  }

  // ============================================================
  // 2) VISOR PDF.js (Canvas) — página/zoom/rotación viven en `hitl.viewSettings`
  // ============================================================

  let canvasEl = $state<HTMLCanvasElement | null>(null);
  let renderTask: pdfjsLib.RenderTask | null = null;
  let pdfDoc: pdfjsLib.PDFDocumentProxy | null = null;

  let ajusteAncho = $state(true);
  let cargandoPdf = $state(true);
  let pdfError = $state<string | null>(null);
  let panelAncho = $state(0);
  let panelIzqEl = $state<HTMLElement | null>(null);

  const ESCALA_MIN = 0.25;
  const ESCALA_MAX = 4.0;

  async function cargarPdf(src: string): Promise<void> {
    cargandoPdf = true;
    pdfError = null;
    ajusteAncho = true;
    try {
      pdfDoc?.destroy().catch(() => {});
      const tarea = pdfjsLib.getDocument({ url: src });
      pdfDoc = await tarea.promise;
      hitl.viewSettings.totalPages = pdfDoc.numPages;
      hitl.setPage(1);
      await renderizarPagina();
    } catch (err) {
      pdfError = err instanceof Error ? err.message : String(err);
      pdfDoc = null;
    } finally {
      cargandoPdf = false;
    }
  }

  // Recarga el PDF cuando cambia el documento abierto.
  $effect(() => {
    const url = hitl.document.pdfUrl;
    if (url) void cargarPdf(url);
  });

  // Re-renderiza cuando cambian página, zoom, rotación o ajuste al ancho.
  $effect(() => {
    void hitl.viewSettings.currentPage;
    void hitl.viewSettings.zoom;
    void hitl.viewSettings.rotation;
    void ajusteAncho;
    void panelAncho;
    if (pdfDoc && canvasEl) void renderizarPagina();
  });

  async function renderizarPagina(): Promise<void> {
    if (!pdfDoc || !canvasEl) return;
    const page = await pdfDoc.getPage(hitl.viewSettings.currentPage);

    let escalaFinal = hitl.viewSettings.zoom;
    if (ajusteAncho && panelAncho > 0) {
      const viewportBase = page.getViewport({ scale: 1, rotation: hitl.viewSettings.rotation });
      escalaFinal = Math.min(Math.max(panelAncho / viewportBase.width, ESCALA_MIN), ESCALA_MAX);
    }

    const viewport = page.getViewport({ scale: escalaFinal, rotation: hitl.viewSettings.rotation });
    const ctx = canvasEl.getContext('2d');
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    canvasEl.width = Math.floor(viewport.width * dpr);
    canvasEl.height = Math.floor(viewport.height * dpr);
    canvasEl.style.width = `${Math.floor(viewport.width)}px`;
    canvasEl.style.height = `${Math.floor(viewport.height)}px`;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    if (renderTask) {
      try {
        renderTask.cancel();
      } catch {
        /* ignore */
      }
    }
    renderTask = page.render({ canvasContext: ctx, viewport });
    try {
      await renderTask.promise;
    } catch (err) {
      if (!(err instanceof Error && err.name === 'RenderingCancelledException')) {
        console.error('Render PDF falló:', err);
      }
    } finally {
      renderTask = null;
    }
  }

  function zoomIn(): void {
    ajusteAncho = false;
    hitl.zoomIn();
  }
  function zoomOut(): void {
    ajusteAncho = false;
    hitl.zoomOut();
  }
  function rotar(): void {
    hitl.rotate();
  }
  function ajustarAncho(): void {
    ajusteAncho = true;
  }
  function paginaAnterior(): void {
    hitl.setPage(hitl.viewSettings.currentPage - 1);
  }
  function paginaSiguiente(): void {
    hitl.setPage(hitl.viewSettings.currentPage + 1);
  }

  let resizeObserver: ResizeObserver | null = null;
  $effect(() => {
    if (!panelIzqEl) return;
    resizeObserver = new ResizeObserver((entries) => {
      for (const entry of entries) panelAncho = entry.contentRect.width;
    });
    resizeObserver.observe(panelIzqEl);
    return () => {
      resizeObserver?.disconnect();
      resizeObserver = null;
    };
  });

  onDestroy(() => {
    if (renderTask) {
      try {
        renderTask.cancel();
      } catch {
        /* ignore */
      }
    }
    pdfDoc?.destroy().catch(() => {});
  });

  function onKey(e: KeyboardEvent): void {
    if (hitl.uiStatus.submitting) return;
    switch (e.key) {
      case 'ArrowLeft':
        paginaAnterior();
        break;
      case 'ArrowRight':
        paginaSiguiente();
        break;
      case '+':
      case '=':
        zoomIn();
        break;
      case '-':
        zoomOut();
        break;
      case 'r':
      case 'R':
        rotar();
        break;
      case 'f':
      case 'F':
        ajustarAncho();
        break;
    }
  }

  // ============================================================
  // 3) CONFIRMACIÓN / REINTENTO
  // ============================================================

  const CAMPOS_REQUERIDOS = ['numeroOficio', 'fechaEmision', 'dependenciaArea', 'remitenteNombre', 'destinatarioNombre', 'asunto'];

  async function confirmar(): Promise<void> {
    tocadas = Object.fromEntries(CAMPOS_REQUERIDOS.map((c) => [c, true]));
    if (!hitl.canSubmit) return;
    await hitl.submitConfirmation(userId);
  }

  // ============================================================
  // 4) OFICIOS RELACIONADOS (Puerto 7 — búsqueda semántica local, degradación honesta)
  // ============================================================

  let relacionados = $state<DocumentoRelacionado[]>([]);
  let relacionadosEstado = $state<ModeloEstado | 'CARGANDO_UI' | null>(null);
  let relacionadosAbierto = $state(false);

  async function cargarRelacionados(): Promise<void> {
    relacionadosEstado = 'CARGANDO_UI';
    try {
      const res = await api.getRelatedDocuments(documento.id, { limite: 5 });
      relacionados = res.documentos;
      relacionadosEstado = res.modeloEstado;
    } catch {
      relacionados = [];
      relacionadosEstado = 'ERROR_INFERENCIA';
    }
  }

  $effect(() => {
    // Recarga al cambiar de documento.
    void documento.id;
    relacionados = [];
    relacionadosEstado = null;
    relacionadosAbierto = false;
  });

  function toggleRelacionados(): void {
    relacionadosAbierto = !relacionadosAbierto;
    if (relacionadosAbierto && relacionadosEstado === null) void cargarRelacionados();
  }

  onMount(() => {
    // ancho inicial del panel, antes de que dispare el primer resize
  });
</script>

<div
  class="flex h-full w-full flex-col overflow-hidden bg-white lg:flex-row"
  role="application"
  aria-label="Revisión Human-in-the-Loop de oficio"
  onkeydown={onKey}
  tabindex="-1"
>
  <!-- ============================================================ -->
  <!-- PANEL IZQUIERDO — VISOR PDF.js                                -->
  <!-- ============================================================ -->
  <section
    bind:this={panelIzqEl}
    class="relative flex h-1/2 flex-col border-b border-slate-200 bg-slate-100 lg:h-full lg:w-1/2 lg:border-b-0 lg:border-r"
    aria-label="Visor de documento PDF"
  >
    <div class="flex items-center gap-1 border-b border-slate-200 bg-white px-3 py-2">
      <button type="button" class="visor-btn" title="Página anterior (←)" onclick={paginaAnterior} disabled={hitl.viewSettings.currentPage <= 1 || cargandoPdf}>
        <svg class="h-4 w-4" viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M12.79 5.23a.75.75 0 0 1 0 1.06L9.06 10l3.73 3.71a.75.75 0 1 1-1.06 1.06l-4.25-4.25a.75.75 0 0 1 0-1.06l4.25-4.25a.75.75 0 0 1 1.06 0Z" clip-rule="evenodd" /></svg>
      </button>
      <span class="min-w-[4.5rem] text-center text-xs tabular-nums text-slate-500">
        {hitl.viewSettings.currentPage} / {hitl.viewSettings.totalPages || '—'}
      </span>
      <button type="button" class="visor-btn" title="Página siguiente (→)" onclick={paginaSiguiente} disabled={hitl.viewSettings.currentPage >= hitl.viewSettings.totalPages || cargandoPdf}>
        <svg class="h-4 w-4" viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M7.21 14.77a.75.75 0 0 1 0-1.06L10.94 10 7.21 6.29a.75.75 0 1 1 1.06-1.06l4.25 4.25a.75.75 0 0 1 0 1.06l-4.25 4.25a.75.75 0 0 1-1.06 0Z" clip-rule="evenodd" /></svg>
      </button>

      <span class="mx-1 h-5 w-px bg-slate-200"></span>

      <button type="button" class="visor-btn" title="Alejar (-)" onclick={zoomOut} disabled={cargandoPdf}>
        <svg class="h-4 w-4" viewBox="0 0 20 20" fill="currentColor"><path d="M4.25 9.25a.75.75 0 0 0 0 1.5h11.5a.75.75 0 0 0 0-1.5H4.25Z" /></svg>
      </button>
      <button type="button" class="visor-btn" title="Acercar (+)" onclick={zoomIn} disabled={cargandoPdf}>
        <svg class="h-4 w-4" viewBox="0 0 20 20" fill="currentColor"><path d="M10 4.25a.75.75 0 0 1 .75.75v4.25H15a.75.75 0 0 1 0 1.5h-4.25V15a.75.75 0 0 1-1.5 0v-4.25H5a.75.75 0 0 1 0-1.5h4.25V5a.75.75 0 0 1 .75-.75Z" /></svg>
      </button>
      <button type="button" class="visor-btn" title="Rotar 90° (R)" onclick={rotar} disabled={cargandoPdf}>
        <svg class="h-4 w-4" viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M4.755 10.059a5.25 5.25 0 0 1 8.897-2.588L15.312 9.11a.75.75 0 0 0 1.28-.53V4a.75.75 0 0 0-1.5 0v1.638l-1.293-1.292a6.75 6.75 0 1 0 1.933 5.925.75.75 0 0 0-1.485-.21 5.25 5.25 0 1 1-9.492.998Z" clip-rule="evenodd" /></svg>
      </button>
      <button
        type="button"
        class="visor-btn {ajusteAncho ? 'bg-brand-50 text-brand-600 ring-1 ring-inset ring-brand-300' : ''}"
        title="Ajustar al ancho (F)"
        onclick={ajustarAncho}
        disabled={cargandoPdf}
      >
        <svg class="h-4 w-4" viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M3.25 4A1.75 1.75 0 0 0 1.5 5.75v8.5c0 .966.784 1.75 1.75 1.75h13.5A1.75 1.75 0 0 0 18.5 14.25v-8.5A1.75 1.75 0 0 0 16.75 4H3.25ZM3 5.75A.25.25 0 0 1 3.25 5.5h13.5a.25.25 0 0 1 .25.25v8.5a.25.25 0 0 1-.25.25H3.25a.25.25 0 0 1-.25-.25v-8.5Z" clip-rule="evenodd" /></svg>
      </button>

      <span class="ml-auto hidden text-[11px] text-slate-400 sm:block">{Math.round(hitl.viewSettings.zoom * 100)}%</span>
    </div>

    <div class="relative flex flex-1 items-start justify-center overflow-auto p-4">
      {#if cargandoPdf}
        <div class="flex h-full w-full items-center justify-center">
          <div class="flex flex-col items-center gap-3 text-slate-400">
            <div class="h-7 w-7 animate-spin rounded-full border-2 border-slate-300 border-t-brand-500"></div>
            <p class="text-xs">Cargando documento…</p>
          </div>
        </div>
      {:else if pdfError}
        <div class="flex h-full w-full items-center justify-center">
          <div class="max-w-sm rounded-lg border border-rose-200 bg-rose-50 p-4 text-center text-rose-700">
            <p class="text-sm font-semibold">No se pudo abrir el PDF</p>
            <p class="mt-1 break-words text-xs text-rose-600/80">{pdfError}</p>
          </div>
        </div>
      {:else}
        <canvas bind:this={canvasEl} class="rounded-sm bg-white shadow-panel ring-1 ring-slate-900/5"></canvas>
      {/if}
    </div>
  </section>

  <!-- ============================================================ -->
  <!-- PANEL DERECHO — CONTEXTO + FORMULARIO REACTIVO                -->
  <!-- ============================================================ -->
  <section class="flex h-1/2 flex-col overflow-hidden lg:h-full lg:w-1/2" aria-label="Formulario de validación de metadatos">
    <!-- Barra de contexto del documento -->
    <header class="border-b border-slate-200 bg-white px-5 py-3">
      <div class="flex items-start justify-between gap-3">
        <div class="min-w-0">
          <p class="truncate text-sm font-semibold text-slate-800" title={documento.nombreArchivoOriginal}>
            {documento.nombreArchivoOriginal}
          </p>
          <p class="mt-0.5 text-xs text-slate-400">Ingresado {formatRelativeTime(documento.fechaIngesta)}</p>
        </div>
        <div class="flex shrink-0 items-center gap-2">
          <span class="inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium {meta.badgeClass}">
            <span class="h-1.5 w-1.5 rounded-full {meta.dotClass}"></span>
            {meta.label}
          </span>
          {#if oncancel}
            <button type="button" class="rounded-md p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-600" title="Cerrar" onclick={oncancel}>
              <svg class="h-4 w-4" viewBox="0 0 20 20" fill="currentColor"><path d="m6.28 5.22 8.5 8.5a.75.75 0 1 1-1.06 1.06l-8.5-8.5a.75.75 0 0 1 1.06-1.06Z" /><path d="m14.78 6.28-8.5 8.5a.75.75 0 0 1-1.06-1.06l8.5-8.5a.75.75 0 1 1 1.06 1.06Z" /></svg>
            </button>
          {/if}
        </div>
      </div>

      <!-- Progreso del pipeline -->
      <div class="mt-3 h-1 w-full overflow-hidden rounded-full bg-slate-100">
        <div
          class="h-full rounded-full transition-all duration-500 {hitl.pipelineHasFailed ? 'bg-rose-500' : documento.estado === 'COMPLETADO' ? 'bg-emerald-500' : 'bg-brand-500'}"
          style="width: {hitl.pipelineProgress}%"
        ></div>
      </div>
    </header>

    <div class="flex-1 overflow-y-auto">
      {#if hitl.uiStatus.error}
        <div class="mx-5 mt-4 rounded-lg border border-rose-200 bg-rose-50 px-3.5 py-2.5 text-sm text-rose-700">
          {hitl.uiStatus.error}
        </div>
      {/if}

      <!-- Resultado del RPA / Sheets, cuando aplica -->
      {#if documento.rpa || documento.estado === 'ERROR_RPA' || documento.estado === 'EN_RPA'}
        <div class="mx-5 mt-4 rounded-lg border border-slate-200 bg-slate-50 px-3.5 py-3 text-xs text-slate-600">
          <p class="font-semibold text-slate-700">Registro en Intranet (op_cucs.fwx)</p>
          {#if documento.rpa?.folioAcuseInstitucional}
            <p class="mt-1">
              Folio de acuse: <span class="font-mono font-medium text-slate-800">{documento.rpa.folioAcuseInstitucional}</span>
            </p>
          {:else if documento.estado === 'EN_RPA'}
            <p class="mt-1 flex items-center gap-1.5 text-brand-600">
              <span class="h-3 w-3 animate-spin rounded-full border-2 border-brand-200 border-t-brand-600"></span>
              Registrando…
            </p>
          {:else if documento.rpa?.mensajeError}
            <p class="mt-1 text-rose-600">{documento.rpa.mensajeError}</p>
          {/if}
          <p class="mt-1 text-slate-400">
            Google Sheets: {documento.sheetsSync.sincronizado ? 'sincronizado' : 'pendiente de sincronizar'}
          </p>
        </div>
      {/if}

      {#if hitl.canRetryRpa}
        <div class="mx-5 mt-3">
          <button
            type="button"
            onclick={() => hitl.retryRpa()}
            disabled={hitl.uiStatus.submitting}
            class="w-full rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm font-medium text-amber-800 transition hover:bg-amber-100 disabled:cursor-not-allowed disabled:opacity-60"
          >
            ↻ Reintentar registro en Intranet
          </button>
        </div>
      {/if}

      {#if hitl.canRetryExtraction}
        <div class="mx-5 mt-3">
          <button
            type="button"
            onclick={() => hitl.retryExtraction()}
            disabled={hitl.uiStatus.submitting}
            class="w-full rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm font-medium text-amber-800 transition hover:bg-amber-100 disabled:cursor-not-allowed disabled:opacity-60"
          >
            ↻ Reintentar extracción de metadatos
          </button>
          <p class="mt-1.5 text-center text-[11px] text-slate-400">
            Vuelve a enviar el documento al motor de IA (Gemini) — útil tras un timeout o una caída temporal del proveedor.
          </p>
        </div>
      {/if}

      <form
        class="flex flex-col gap-5 p-5"
        onsubmit={(e) => {
          e.preventDefault();
          void confirmar();
        }}
      >
        <fieldset class="rounded-lg border border-slate-200 bg-white p-3" disabled={formDisabled}>
          <legend class="px-1 text-xs font-semibold uppercase tracking-wide text-slate-500">Procedencia</legend>
          <div class="flex gap-4">
            {#each [{ v: 'HCG', l: 'HCG (Interno)' }, { v: 'Ajena', l: 'Ajena (Externo)' }] as opt}
              <label class="flex cursor-pointer items-center gap-2 text-sm text-slate-700">
                <input
                  type="radio"
                  name="procedencia"
                  checked={draft.procedencia === opt.v}
                  onchange={() => set('procedencia', opt.v as MetadatosOficioDraft['procedencia'])}
                  class="h-4 w-4 accent-brand-600"
                />
                {opt.l}
              </label>
            {/each}
          </div>
        </fieldset>

        <div class="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div>
            <label for="f-numero" class="form-label">Número de Oficio / Folio</label>
            <input
              id="f-numero"
              type="text"
              value={draft.numeroOficio ?? ''}
              oninput={(e) => set('numeroOficio', (e.currentTarget as HTMLInputElement).value)}
              onblur={() => tocar('numeroOficio')}
              disabled={formDisabled}
              class="form-input {errVisible('numeroOficio') ? 'input-error' : ''}"
              placeholder="DSA-2026-089-OF o S/N"
            />
            {#if errVisible('numeroOficio')}<p class="form-error">{errVisible('numeroOficio')}</p>{/if}
          </div>

          <div>
            <label for="f-fecha" class="form-label">Fecha de Emisión</label>
            <input
              id="f-fecha"
              type="date"
              value={draft.fechaEmision ?? ''}
              oninput={(e) => set('fechaEmision', (e.currentTarget as HTMLInputElement).value)}
              onblur={() => tocar('fechaEmision')}
              disabled={formDisabled}
              class="form-input {errVisible('fechaEmision') ? 'input-error' : ''}"
            />
            {#if errVisible('fechaEmision')}<p class="form-error">{errVisible('fechaEmision')}</p>{/if}
          </div>

          <div class="sm:col-span-2">
            <label for="f-dependencia" class="form-label">Dependencia / Área emisora</label>
            <input
              id="f-dependencia"
              type="text"
              value={draft.dependenciaArea ?? ''}
              oninput={(e) => set('dependenciaArea', (e.currentTarget as HTMLInputElement).value)}
              onblur={() => tocar('dependenciaArea')}
              disabled={formDisabled}
              class="form-input uppercase {errVisible('dependenciaArea') ? 'input-error' : ''}"
              placeholder="DIRECCIÓN GENERAL HCG"
            />
            {#if errVisible('dependenciaArea')}<p class="form-error">{errVisible('dependenciaArea')}</p>{/if}
          </div>

          <div>
            <label for="f-rem-nombre" class="form-label">Remitente (Firmante)</label>
            <input
              id="f-rem-nombre"
              type="text"
              value={draft.remitenteNombre ?? ''}
              oninput={(e) => set('remitenteNombre', (e.currentTarget as HTMLInputElement).value)}
              onblur={() => tocar('remitenteNombre')}
              disabled={formDisabled}
              class="form-input uppercase {errVisible('remitenteNombre') ? 'input-error' : ''}"
            />
            {#if errVisible('remitenteNombre')}<p class="form-error">{errVisible('remitenteNombre')}</p>{/if}
          </div>

          <div>
            <label for="f-rem-cargo" class="form-label">Cargo del Remitente</label>
            <input
              id="f-rem-cargo"
              type="text"
              value={draft.remitenteCargo ?? ''}
              oninput={(e) => set('remitenteCargo', (e.currentTarget as HTMLInputElement).value)}
              disabled={formDisabled}
              class="form-input uppercase"
              placeholder="NO ESPECIFICADO"
            />
          </div>

          <div>
            <label for="f-des-nombre" class="form-label">Destinatario</label>
            <input
              id="f-des-nombre"
              type="text"
              value={draft.destinatarioNombre ?? ''}
              oninput={(e) => set('destinatarioNombre', (e.currentTarget as HTMLInputElement).value)}
              onblur={() => tocar('destinatarioNombre')}
              disabled={formDisabled}
              class="form-input uppercase {errVisible('destinatarioNombre') ? 'input-error' : ''}"
            />
            {#if errVisible('destinatarioNombre')}<p class="form-error">{errVisible('destinatarioNombre')}</p>{/if}
          </div>

          <div>
            <label for="f-des-cargo" class="form-label">Cargo del Destinatario</label>
            <input
              id="f-des-cargo"
              type="text"
              value={draft.destinatarioCargo ?? ''}
              oninput={(e) => set('destinatarioCargo', (e.currentTarget as HTMLInputElement).value)}
              disabled={formDisabled}
              class="form-input uppercase"
              placeholder="NO ESPECIFICADO"
            />
          </div>

          <div>
            <label for="f-plazo" class="form-label">Plazo de respuesta (días)</label>
            <input
              id="f-plazo"
              type="number"
              min="0"
              step="1"
              value={draft.plazoDias ?? ''}
              oninput={onPlazoInput}
              disabled={formDisabled}
              class="form-input"
              placeholder="Vacío si no aplica"
            />
          </div>

          <div class="flex items-end">
            <label class="flex w-full cursor-pointer items-center gap-3 rounded-lg border border-slate-200 bg-white px-3 py-2.5 text-sm">
              <input
                type="checkbox"
                checked={draft.contieneDatosSensibles ?? false}
                onchange={(e) => set('contieneDatosSensibles', (e.currentTarget as HTMLInputElement).checked)}
                disabled={formDisabled}
                class="h-4 w-4 accent-rose-600"
              />
              <span class="font-medium text-slate-700">Contiene datos sensibles (LGPDPPSO)</span>
            </label>
          </div>

          <div class="sm:col-span-2">
            <label for="f-asunto" class="form-label">Asunto / Síntesis</label>
            <textarea
              id="f-asunto"
              value={draft.asunto ?? ''}
              oninput={(e) => set('asunto', (e.currentTarget as HTMLTextAreaElement).value)}
              onblur={() => tocar('asunto')}
              disabled={formDisabled}
              rows="4"
              class="form-input resize-y {errVisible('asunto') ? 'input-error' : ''}"
              placeholder="Síntesis del oficio (1 a 3 oraciones)."
            ></textarea>
            {#if errVisible('asunto')}<p class="form-error">{errVisible('asunto')}</p>{/if}
          </div>
        </div>

        <!-- Oficios relacionados (Puerto 7 — similitud semántica local) -->
        <div class="rounded-lg border border-slate-200 bg-white">
          <button type="button" onclick={toggleRelacionados} class="flex w-full items-center justify-between px-3.5 py-2.5 text-left text-xs font-semibold uppercase tracking-wide text-slate-500">
            Oficios relacionados
            <svg class="h-4 w-4 transition-transform {relacionadosAbierto ? 'rotate-180' : ''}" viewBox="0 0 20 20" fill="currentColor">
              <path fill-rule="evenodd" d="M5.23 7.21a.75.75 0 0 1 1.06.02L10 11.168l3.71-3.938a.75.75 0 1 1 1.08 1.04l-4.25 4.5a.75.75 0 0 1-1.08 0l-4.25-4.5a.75.75 0 0 1 .02-1.06Z" clip-rule="evenodd" />
            </svg>
          </button>
          {#if relacionadosAbierto}
            <div class="border-t border-slate-100 px-3.5 py-3 text-sm">
              {#if relacionadosEstado === 'CARGANDO_UI' || relacionadosEstado === 'CARGANDO'}
                <p class="text-xs text-slate-400">Buscando oficios similares…</p>
              {:else if relacionadosEstado === 'NO_INICIALIZADO'}
                <p class="text-xs text-slate-400">Motor de búsqueda semántica aún no inicializado.</p>
              {:else if relacionadosEstado === 'ERROR_INFERENCIA'}
                <p class="text-xs text-slate-400">No se pudieron calcular similitudes por ahora.</p>
              {:else if relacionados.length === 0}
                <p class="text-xs text-slate-400">Sin oficios relacionados por similitud.</p>
              {:else}
                <ul class="flex flex-col gap-2">
                  {#each relacionados as rel (rel.documentoId)}
                    <li class="flex items-center justify-between gap-2 rounded-md bg-slate-50 px-2.5 py-1.5">
                      <div class="min-w-0">
                        <p class="truncate text-xs font-medium text-slate-700">{rel.numeroOficio ?? rel.nombreArchivoCanonico ?? rel.documentoId}</p>
                        <p class="truncate text-[11px] text-slate-400">{rel.asunto ?? '—'}</p>
                      </div>
                      <span class="shrink-0 rounded-full bg-white px-2 py-0.5 text-[11px] font-medium text-slate-500 ring-1 ring-slate-200">
                        {Math.round(rel.similitudScore * 100)}%
                      </span>
                    </li>
                  {/each}
                </ul>
              {/if}
            </div>
          {/if}
        </div>
      </form>
    </div>

    <!-- Barra de acción, fija al fondo del panel -->
    <div class="border-t border-slate-200 bg-white/95 px-5 py-4 backdrop-blur">
      <button
        type="button"
        onclick={confirmar}
        disabled={!hitl.canSubmit}
        class="flex w-full items-center justify-center gap-2 rounded-lg bg-brand-600 px-4 py-3 text-sm font-semibold text-white shadow-soft transition hover:bg-brand-700 disabled:cursor-not-allowed disabled:bg-slate-300"
      >
        {#if hitl.uiStatus.submitting}
          <svg class="h-4 w-4 animate-spin" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
            <path class="opacity-90" fill="currentColor" d="M4 12a8 8 0 0 1 8-8v4a4 4 0 0 0-4 4H4z"></path>
          </svg>
          <span>Registrando…</span>
        {:else}
          <span>Confirmar y registrar en Intranet</span>
        {/if}
      </button>
      <p class="mt-2 text-center text-[11px] text-slate-400">
        Se moverá a <code class="rounded bg-slate-100 px-1 py-0.5">storage/03_procesados/</code> y se inyectará vía RPA en <code class="rounded bg-slate-100 px-1 py-0.5">op_cucs.fwx</code>.
      </p>
    </div>
  </section>
</div>

<style>
  .visor-btn {
    @apply inline-flex h-8 w-8 items-center justify-center rounded-md text-slate-500 transition hover:bg-slate-100 hover:text-slate-700 disabled:cursor-not-allowed disabled:opacity-30;
  }
  .form-label {
    @apply mb-1 block text-xs font-medium text-slate-500;
  }
  .form-input {
    @apply w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 shadow-sm transition focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500 disabled:cursor-not-allowed disabled:bg-slate-50 disabled:text-slate-400;
  }
  .input-error {
    @apply border-rose-400 focus:border-rose-500 focus:ring-rose-500;
  }
  .form-error {
    @apply mt-1 text-xs text-rose-600;
  }
</style>
