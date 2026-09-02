<script lang="ts">
  // ============================================================
  // App.svelte — Oficialia-Digital-DSA
  // Composition root del frontend: bandeja de PENDIENTE_REVISION +
  // Split-Screen HITL (HitlReviewView).
  // Versión: 1.0.0-MVP
  //
  // Wiring deliberadamente mínimo: `DocumentHitlState` (documentState.svelte.ts) ya
  // resuelve WebSocket + progreso de pipeline + `formValidation`/`canSubmit`, pero
  // `HitlReviewView` gestiona su propio `$state` de formulario y solo expone
  // `onconfirm(validados)` — no escribe en `hitl.document.draft`. Por eso aquí se llama
  // a `DocumentApiClient.confirmDocument()` directamente en `handleConfirm` en vez de
  // `hitl.submitConfirmation()`. Unificar ambos (que HitlReviewView escriba vía
  // `hitl.updateDraftField` y use `hitl.canSubmit`/`hitl.submitConfirmation`) es trabajo
  // de integración pendiente, no resuelto en esta entrega.
  // ============================================================

  import { onMount } from 'svelte';
  import { DocumentApiClient, DocumentApiError } from '$lib/api/documentApiClient';
  import { createDocumentHitlState } from '$lib/state/documentState.svelte';
  import type { DocumentoRegistro, MetadatosOficio } from '$lib/types';
  import HitlReviewView from '$lib/components/HitlReviewView.svelte';

  const API_BASE_URL = import.meta.env.VITE_API_BASE_URL ?? 'http://localhost:3000';

  const api = new DocumentApiClient({ baseUrl: API_BASE_URL });
  // Debe instanciarse en el <script> raíz de un componente montado (effect root) — ver
  // el docstring de createDocumentHitlState en documentState.svelte.ts.
  const hitl = createDocumentHitlState(api);

  let userId = $state('CAPTURISTA-DEV');
  let pendingDocs = $state<DocumentoRegistro[]>([]);
  let loadingList = $state(false);
  let listError = $state<string | null>(null);
  let confirmError = $state<string | null>(null);

  async function refreshPending(): Promise<void> {
    loadingList = true;
    listError = null;
    try {
      pendingDocs = await api.listPending();
    } catch (error) {
      listError = error instanceof DocumentApiError ? error.message : 'No se pudo cargar la bandeja de pendientes.';
    } finally {
      loadingList = false;
    }
  }

  function selectDocument(id: string): void {
    confirmError = null;
    void hitl.loadDocument(id);
  }

  function closeDocument(): void {
    hitl.document.id = null;
    hitl.document.record = null;
    hitl.document.pdfUrl = null;
  }

  async function handleConfirm(validados: MetadatosOficio): Promise<void> {
    const record = hitl.document.record;
    if (!record) return;

    confirmError = null;
    try {
      await api.confirmDocument(record.id, {
        metadata: validados,
        userId,
        expectedVersion: record.version,
      });
      closeDocument();
      await refreshPending();
    } catch (error) {
      confirmError = error instanceof DocumentApiError ? error.message : 'No se pudo confirmar el documento.';
      // 409 CONCURRENCY_VERSION_CONFLICT u otro conflicto: re-sincroniza con el servidor
      // en vez de dejar al capturista reenviando datos obsoletos.
      await hitl.loadDocument(record.id);
    }
  }

  onMount(() => {
    void refreshPending();
  });
</script>

<div class="flex h-screen flex-col bg-slate-100 text-slate-900">
  <header class="flex items-center justify-between border-b border-slate-300 bg-white px-4 py-2">
    <div>
      <h1 class="text-sm font-semibold uppercase tracking-wide text-slate-700">
        Oficialía Digital DSA — Validación HITL
      </h1>
      <p class="text-xs text-slate-500">
        WebSocket: <span class="font-medium">{hitl.uiStatus.wsStatus}</span>
      </p>
    </div>
    <label class="flex items-center gap-2 text-xs text-slate-600">
      Capturista
      <input
        class="rounded border border-slate-300 px-2 py-1 text-xs"
        bind:value={userId}
      />
    </label>
  </header>

  <div class="flex flex-1 overflow-hidden">
    <aside class="w-72 shrink-0 overflow-y-auto border-r border-slate-300 bg-white">
      <div class="flex items-center justify-between px-3 py-2">
        <h2 class="text-xs font-semibold uppercase text-slate-500">Bandeja PENDIENTE_REVISION</h2>
        <button
          class="text-xs text-blue-600 hover:underline"
          onclick={() => void refreshPending()}
        >
          Actualizar
        </button>
      </div>

      {#if loadingList}
        <p class="px-3 py-2 text-xs text-slate-400">Cargando…</p>
      {:else if listError}
        <p class="px-3 py-2 text-xs text-red-600">{listError}</p>
      {:else if pendingDocs.length === 0}
        <p class="px-3 py-2 text-xs text-slate-400">Sin oficios pendientes de revisión.</p>
      {:else}
        <ul>
          {#each pendingDocs as doc (doc.id)}
            <li>
              <button
                class="block w-full truncate px-3 py-2 text-left text-xs hover:bg-slate-50 {hitl.document.id === doc.id ? 'bg-blue-50 font-medium text-blue-700' : 'text-slate-700'}"
                onclick={() => selectDocument(doc.id)}
                title={doc.nombreArchivoOriginal}
              >
                {doc.nombreArchivoOriginal}
              </button>
            </li>
          {/each}
        </ul>
      {/if}
    </aside>

    <main class="flex-1 overflow-hidden">
      {#if hitl.uiStatus.loading}
        <div class="flex h-full items-center justify-center text-sm text-slate-400">
          Cargando documento…
        </div>
      {:else if hitl.uiStatus.error}
        <div class="flex h-full items-center justify-center text-sm text-red-600">
          {hitl.uiStatus.error}
        </div>
      {:else if hitl.document.record && hitl.document.pdfUrl}
        {#if confirmError}
          <p class="bg-red-50 px-3 py-1 text-xs text-red-700">{confirmError}</p>
        {/if}
        <HitlReviewView
          documento={hitl.document.record}
          src={hitl.document.pdfUrl}
          onconfirm={handleConfirm}
          oncancel={closeDocument}
        />
      {:else}
        <div class="flex h-full items-center justify-center text-sm text-slate-400">
          Seleccione un oficio de la bandeja para iniciar la revisión.
        </div>
      {/if}
    </main>
  </div>
</div>
