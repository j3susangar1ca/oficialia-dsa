import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';

// SISTEMA OFICIALIA-DIGITAL-DSA — Frontend Svelte 5
// Config de Vite: LAN hospitalaria / VPN (prd.md §2 — nunca exposición pública).
export default defineConfig({
  plugins: [svelte()],
  resolve: {
    alias: {
      $lib: '/src/lib',
    },
  },
  server: {
    host: '0.0.0.0',
    port: 5173,
  },
});
