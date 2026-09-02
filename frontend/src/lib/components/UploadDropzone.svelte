<script lang="ts">
  // ============================================================
  // UploadDropzone.svelte — Oficialia-Digital-DSA
  // Ingesta WEB_DRAG_DROP de oficios: arrastrar-y-soltar o seleccionar archivo.
  // Antes de este componente el frontend no tenía forma de subir un PDF: la única
  // ingesta soportada en la UI era abrir documentos ya existentes en la bandeja.
  // Svelte 5 (Runes) · Tailwind
  // ============================================================

  import type { DocumentApiClient } from '$lib/api/documentApiClient';
  import { DocumentApiError } from '$lib/api/documentApiClient';
  import type { IngestaOrigen } from '$lib/types';

  interface Props {
    api: DocumentApiClient;
    /** Notifica el id del documento aceptado; el padre decide cómo refrescar la bandeja. */
    onuploaded?: (documentId: string) => void;
    /** Compacto: para incrustar en la barra lateral en vez del estado vacío a pantalla completa. */
    compact?: boolean;
  }

  let { api, onuploaded, compact = false }: Props = $props();

  let origen = $state<IngestaOrigen>('WEB_DRAG_DROP');
  let dragDepth = $state(0); // contador en vez de bool: evita parpadeo con hijos anidados
  let status = $state<'idle' | 'uploading' | 'success' | 'error'>('idle');
  let message = $state<string | null>(null);
  let inputEl = $state<HTMLInputElement | null>(null);

  const isDragging = $derived(dragDepth > 0);

  function isPdf(file: File): boolean {
    return file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf');
  }

  async function handleFiles(files: FileList | null): Promise<void> {
    const file = files?.[0];
    if (!file) return;

    if (!isPdf(file)) {
      status = 'error';
      message = 'Solo se aceptan archivos PDF.';
      return;
    }
    if (file.size === 0) {
      status = 'error';
      message = 'El archivo está vacío.';
      return;
    }

    status = 'uploading';
    message = null;
    try {
      const { documentId } = await api.uploadDocument(file, origen);
      status = 'success';
      message = `"${file.name}" recibido. Preprocesamiento y extracción en curso.`;
      onuploaded?.(documentId);
    } catch (error) {
      status = 'error';
      message = error instanceof DocumentApiError ? error.message : 'No se pudo subir el oficio.';
    } finally {
      if (inputEl) inputEl.value = '';
    }
  }

  function onDrop(e: DragEvent): void {
    e.preventDefault();
    dragDepth = 0;
    void handleFiles(e.dataTransfer?.files ?? null);
  }
  function onDragOver(e: DragEvent): void {
    e.preventDefault();
  }
  function onDragEnter(e: DragEvent): void {
    e.preventDefault();
    dragDepth += 1;
  }
  function onDragLeave(e: DragEvent): void {
    e.preventDefault();
    dragDepth = Math.max(0, dragDepth - 1);
  }
</script>

<div class="flex flex-col gap-2">
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div
    role="button"
    tabindex="0"
    ondrop={onDrop}
    ondragover={onDragOver}
    ondragenter={onDragEnter}
    ondragleave={onDragLeave}
    onclick={() => inputEl?.click()}
    onkeydown={(e) => (e.key === 'Enter' || e.key === ' ') && inputEl?.click()}
    class="group relative flex cursor-pointer flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed text-center transition-colors
      {compact ? 'px-3 py-4' : 'px-8 py-14'}
      {isDragging
      ? 'border-brand-400 bg-brand-50/60'
      : status === 'error'
        ? 'border-rose-300 bg-rose-50/40 hover:border-rose-400'
        : 'border-slate-300 bg-white hover:border-brand-300 hover:bg-brand-50/30'}"
  >
    <input
      bind:this={inputEl}
      type="file"
      accept="application/pdf,.pdf"
      class="sr-only"
      onchange={(e) => handleFiles((e.currentTarget as HTMLInputElement).files)}
    />

    {#if status === 'uploading'}
      <div class="h-8 w-8 animate-spin rounded-full border-2 border-slate-300 border-t-brand-600"></div>
      <p class="text-sm font-medium text-slate-600">Subiendo oficio…</p>
    {:else}
      <svg
        class="{compact ? 'h-6 w-6' : 'h-9 w-9'} text-slate-400 transition-colors group-hover:text-brand-500"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="1.5"
        aria-hidden="true"
      >
        <path stroke-linecap="round" stroke-linejoin="round" d="M12 16.5V4.5m0 0 4 4m-4-4-4 4" />
        <path stroke-linecap="round" stroke-linejoin="round" d="M4.5 15v3a2.5 2.5 0 0 0 2.5 2.5h10a2.5 2.5 0 0 0 2.5-2.5v-3" />
      </svg>
      <p class="text-sm font-medium text-slate-700">
        {compact ? 'Subir oficio (PDF)' : 'Arrastra un oficio en PDF, o haz clic para elegirlo'}
      </p>
      {#if !compact}
        <p class="text-xs text-slate-400">Se procesa automáticamente: preproceso → extracción IA → revisión</p>
      {/if}
    {/if}
  </div>

  <div class="flex items-center justify-between gap-2 px-0.5">
    <div class="flex items-center gap-1 rounded-md bg-slate-100 p-0.5 text-[11px] font-medium">
      <button
        type="button"
        onclick={() => (origen = 'WEB_DRAG_DROP')}
        class="rounded px-2 py-1 transition {origen === 'WEB_DRAG_DROP' ? 'bg-white text-slate-800 shadow-soft' : 'text-slate-500 hover:text-slate-700'}"
      >
        Manual
      </button>
      <button
        type="button"
        onclick={() => (origen = 'SCANNER_ADF')}
        class="rounded px-2 py-1 transition {origen === 'SCANNER_ADF' ? 'bg-white text-slate-800 shadow-soft' : 'text-slate-500 hover:text-slate-700'}"
      >
        Escáner ADF
      </button>
    </div>
  </div>

  {#if message}
    <p
      class="animate-slide-up rounded-md px-2.5 py-1.5 text-xs {status === 'error'
        ? 'bg-rose-50 text-rose-700'
        : 'bg-emerald-50 text-emerald-700'}"
    >
      {message}
    </p>
  {/if}
</div>
