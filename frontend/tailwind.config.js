/** @type {import('tailwindcss').Config} */
// SISTEMA OFICIALIA-DIGITAL-DSA — Sistema de diseño (Tailwind)
//
// Paleta e escalas centralizadas para una UI elegante/minimalista consistente entre la
// bandeja, el visor y el formulario HITL. Se usa una pila de fuentes de sistema (sin CDN)
// a propósito: el despliegue vive en la LAN hospitalaria / VPN de prd.md §2, sin salida a
// internet garantizada — cargar una fuente externa (Google Fonts, etc.) rompería el
// render en producción.
export default {
  content: ['./index.html', './src/**/*.{svelte,ts,js}'],
  theme: {
    extend: {
      fontFamily: {
        sans: [
          'Inter',
          'ui-sans-serif',
          'system-ui',
          '-apple-system',
          'Segoe UI',
          'Roboto',
          'Helvetica Neue',
          'Arial',
          'sans-serif',
        ],
      },
      colors: {
        // Acento único de marca — usado con moderación (acciones primarias, foco, enlaces).
        brand: {
          50: '#eef2ff',
          100: '#e0e7ff',
          200: '#c7d2fe',
          300: '#a5b4fc',
          400: '#818cf8',
          500: '#6366f1',
          600: '#4f46e5',
          700: '#4338ca',
          800: '#3730a3',
          900: '#312e81',
        },
      },
      boxShadow: {
        soft: '0 1px 2px 0 rgb(15 23 42 / 0.04), 0 1px 3px 0 rgb(15 23 42 / 0.06)',
        panel: '0 1px 3px 0 rgb(15 23 42 / 0.06), 0 8px 24px -8px rgb(15 23 42 / 0.10)',
        floating: '0 12px 32px -8px rgb(15 23 42 / 0.22)',
      },
      keyframes: {
        'fade-in': { from: { opacity: 0 }, to: { opacity: 1 } },
        'slide-up': { from: { opacity: 0, transform: 'translateY(6px)' }, to: { opacity: 1, transform: 'translateY(0)' } },
      },
      animation: {
        'fade-in': 'fade-in 0.15s ease-out',
        'slide-up': 'slide-up 0.2s ease-out',
      },
    },
  },
  plugins: [],
};
