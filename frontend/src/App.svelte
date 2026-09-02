<script lang="ts">
  // ============================================================
  // App.svelte — Oficialia-Digital-DSA
  // Composition root del frontend: bandeja de documentos (con filtros por estado y
  // subida de oficios en PDF) + Split-Screen HITL (HitlReviewView).
  // Versión: 1.0.0-MVP
  //
  // Toda la lógica de carga/confirmación/reintento vive en `DocumentHitlState`
  // (documentState.svelte.ts) — este componente solo orquesta la bandeja (lista +
  // filtros + refresco en vivo por WebSocket) y delega el detalle a HitlReviewView.
  // ============================================================

  import { onMount } from 'svelte';
  import { DocumentApiClient, DocumentApiError } from '$lib/api/documentApiClient';
  import { createDocumentHitlState } from '$lib/state/documentState.svelte';
  import type { DocumentoRegistro } from '$lib/types';
  import HitlReviewView from '$lib/components/HitlReviewView.svelte';
  import UploadDropzone from '$lib/components/UploadDropzone.svelte';
  import { estadoMeta, formatRelativeTime, BANDEJA_GRUPOS } from '$lib/estadoMeta';

  const API_BASE_URL = import.meta.env.VITE_API_BASE_URL ?? 'http://localhost:3000';

  const api = new DocumentApiClient({ baseUrl: API_BASE_URL });
  // Debe instanciarse en el <script> raíz de un componente montado (effect root) — ver
  // el docstring de createDocumentHitlState en documentState.svelte.ts. El segundo
  // argumento refresca la bandeja en vivo ante CUALQUIER evento del pipeline (no solo
  // los del documento abierto), sin abrir un segundo WebSocket.
  const hitl = createDocumentHitlState(api, {
    onServerEvent: (event) => {
      if (event.type === 'NEW_DOCUMENT_PENDING' || event.type === 'DOCUMENT_STATE_CHANGED') {
        void refreshBandeja();
      }
    },
  });

  let userId = $state('CAPTURISTA-DEV');
  let grupoActivo = $state(BANDEJA_GRUPOS[0]!.id);
  let docs = $state<DocumentoRegistro[]>([]);
  let loadingList = $state(false);
  let listError = $state<string | null>(null);

  function wsStatusMeta(status: string): { label: string; dotClass: string } {
    switch (status) {
      case 'connecting':
        return { label: 'Conectando…', dotClass: 'bg-amber-400 animate-pulse' };
      case 'open':
        return { label: 'En vivo', dotClass: 'bg-emerald-500' };
      case 'reconnecting':
        return { label: 'Reconectando…', dotClass: 'bg-amber-400 animate-pulse' };
      case 'closed':
        return { label: 'Desconectado', dotClass: 'bg-rose-400' };
      default:
        return { label: 'Sin conectar', dotClass: 'bg-slate-300' };
    }
  }

  async function refreshBandeja(): Promise<void> {
    const grupo = BANDEJA_GRUPOS.find((g) => g.id === grupoActivo) ?? BANDEJA_GRUPOS[0]!;
    loadingList = true;
    listError = null;
    try {
      docs = await api.listDocuments(
        grupo.estados?.length === 1 ? { estado: grupo.estados[0] } : { estados: grupo.estados, limit: 100 }
      );
    } catch (error) {
      listError = error instanceof DocumentApiError ? error.message : 'No se pudo cargar la bandeja de documentos.';
    } finally {
      loadingList = false;
    }
  }

  function selectGrupo(id: string): void {
    grupoActivo = id;
    void refreshBandeja();
  }

  function selectDocument(id: string): void {
    void hitl.loadDocument(id);
  }

  function closeDocument(): void {
    hitl.document.id = null;
    hitl.document.record = null;
    hitl.document.draft = null;
    hitl.document.pdfUrl = null;
    hitl.uiStatus.error = null;
  }

  function onUploaded(): void {
    // El documento recién subido entra en PENDIENTE_PREPROCESO — se ve de inmediato en
    // "En proceso"; los eventos de WebSocket refrescan la bandeja según avanza.
    selectGrupo('en-proceso');
  }

  onMount(() => {
    void refreshBandeja();
  });
</script>

<div class="flex h-screen flex-col bg-slate-50 text-slate-900">
  <!-- ============================================================ -->
  <!-- BARRA SUPERIOR                                                -->
  <!-- ============================================================ -->
  <header class="flex h-14 shrink-0 items-center justify-between border-b border-slate-200 bg-white px-4">
    <div class="flex items-center gap-2.5">
      <span class="inline-flex h-8 w-8 items-center justify-center rounded-lg bg-brand-600 text-sm font-bold text-white">
        DSA
      </span>
      <div class="leading-tight">
        <h1 class="text-sm font-semibold text-slate-800">Oficialía Digital</h1>
        <p class="flex items-center gap-1.5 text-[11px] text-slate-400">
          <span class="h-1.5 w-1.5 rounded-full {wsStatusMeta(hitl.uiStatus.wsStatus).dotClass}"></span>
          {wsStatusMeta(hitl.uiStatus.wsStatus).label}
        </p>
      </div>
    </div>

    <label class="flex items-center gap-2 text-xs text-slate-500">
      Capturista
      <input
        class="rounded-md border border-slate-300 bg-white px-2.5 py-1.5 text-xs text-slate-700 focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500"
        bind:value={userId}
      />
    </label>
  </header>

  <div class="flex flex-1 overflow-hidden">
    <!-- ============================================================ -->
    <!-- BARRA LATERAL — Subida + Bandeja                              -->
    <!-- ============================================================ -->
    <aside class="flex w-80 shrink-0 flex-col overflow-hidden border-r border-slate-200 bg-white">
      <div class="border-b border-slate-100 p-3">
        <UploadDropzone {api} compact onuploaded={onUploaded} />
      </div>

      <nav class="flex gap-1 overflow-x-auto border-b border-slate-100 px-3 py-2">
        {#each BANDEJA_GRUPOS as grupo (grupo.id)}
          <button
            type="button"
            onclick={() => selectGrupo(grupo.id)}
            class="shrink-0 rounded-full px-3 py-1 text-xs font-medium transition {grupoActivo === grupo.id
              ? 'bg-brand-600 text-white'
              : 'bg-slate-100 text-slate-500 hover:bg-slate-200'}"
          >
            {grupo.label}
          </button>
        {/each}
      </nav>

      <div class="flex items-center justify-between px-3 py-2">
        <h2 class="text-[11px] font-semibold uppercase tracking-wide text-slate-400">
          {docs.length} documento{docs.length === 1 ? '' : 's'}
        </h2>
        <button type="button" class="text-[11px] font-medium text-brand-600 hover:text-brand-700" onclick={() => void refreshBandeja()}>
          Actualizar
        </button>
      </div>

      <div class="flex-1 overflow-y-auto">
        {#if loadingList}
          <div class="flex flex-col gap-2 p-3">
            {#each Array(4) as _}
              <div class="h-14 animate-pulse rounded-lg bg-slate-100"></div>
            {/each}
          </div>
        {:else if listError}
          <p class="px-3 py-4 text-xs text-rose-600">{listError}</p>
        {:else if docs.length === 0}
          <div class="flex flex-col items-center gap-1 px-3 py-10 text-center">
            <p class="text-xs text-slate-400">Sin documentos en esta vista.</p>
          </div>
        {:else}
          <ul class="flex flex-col gap-0.5 p-1.5">
            {#each docs as doc (doc.id)}
              {@const meta = estadoMeta(doc.estado)}
              <li>
                <button
                  type="button"
                  onclick={() => selectDocument(doc.id)}
                  class="flex w-full flex-col gap-1 rounded-lg px-2.5 py-2 text-left transition {hitl.document.id === doc.id
                    ? 'bg-brand-50 ring-1 ring-inset ring-brand-200'
                    : 'hover:bg-slate-50'}"
                >
                  <div class="flex items-center justify-between gap-2">
                    <span class="truncate text-xs font-medium text-slate-700" title={doc.nombreArchivoOriginal}>
                      {doc.nombreArchivoOriginal}
                    </span>
                    <span class="shrink-0 text-[10px] text-slate-400">{formatRelativeTime(doc.fechaIngesta)}</span>
                  </div>
                  <div class="flex items-center gap-1.5">
                    <span class="h-1.5 w-1.5 rounded-full {meta.dotClass}"></span>
                    <span class="text-[11px] text-slate-500">{meta.label}</span>
                    {#if doc.metadatosExtraidos?.numeroOficio}
                      <span class="truncate text-[11px] text-slate-300">· {doc.metadatosExtraidos.numeroOficio}</span>
                    {/if}
                  </div>
                </button>
              </li>
            {/each}
          </ul>
        {/if}
      </div>
    </aside>

    <!-- ============================================================ -->
    <!-- CONTENIDO PRINCIPAL                                           -->
    <!-- ============================================================ -->
    <main class="flex-1 overflow-hidden">
      {#if hitl.uiStatus.loading}
        <div class="flex h-full items-center justify-center text-sm text-slate-400">
          <div class="flex flex-col items-center gap-3">
            <div class="h-7 w-7 animate-spin rounded-full border-2 border-slate-200 border-t-brand-500"></div>
            Cargando documento…
          </div>
        </div>
      {:else if hitl.document.record && hitl.document.draft && hitl.document.pdfUrl}
        <HitlReviewView {hitl} {api} {userId} oncancel={closeDocument} />
      {:else}
        <div class="flex h-full items-center justify-center p-10">
          <div class="flex w-full max-w-md flex-col items-center gap-4 text-center">
            <span class="inline-flex h-12 w-12 items-center justify-center rounded-2xl bg-brand-50 text-brand-500">
              <svg class="h-6 w-6" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
                <path stroke-linecap="round" stroke-linejoin="round" d="M9 12h6m-6 4h6m-8 5h10a2 2 0 0 0 2-2V7.828a2 2 0 0 0-.586-1.414l-3.828-3.828A2 2 0 0 0 13.172 2H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2Z" />
              </svg>
            </span>
            <div>
              <p class="text-sm font-semibold text-slate-700">Seleccione un oficio de la bandeja</p>
              <p class="mt-1 text-xs text-slate-400">
                O arrastre un PDF para iniciar el pipeline: preproceso → extracción con IA → revisión humana.
              </p>
            </div>
            <div class="w-full">
              <UploadDropzone {api} onuploaded={onUploaded} />
            </div>
          </div>
        </div>
      {/if}
    </main>
  </div>
</div>
