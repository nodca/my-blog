/** @type {import('tailwindcss').Config} */
import { addDynamicIconSelectors } from "@iconify/tailwind";
import typography from "@tailwindcss/typography";
import daisyUI from "daisyui";
import { SITE_THEME } from "./src/config";

export default {
  content: ["./src/**/*.{astro,html,js,jsx,md,mdx,svelte,ts,tsx,vue}"],
  theme: {
    extend: {
      fontFamily: {
        sans: ['"Inter"', 'ui-sans-serif', 'system-ui', 'sans-serif'],
        serif: ['"Playfair Display"', 'ui-serif', 'Georgia', 'serif'],
      },
      colors: {
        /* Define the true blood red for explicit tailwind utility use */
        blood: '#e50000',
      }
    },
  },
  safelist: [
    "alert",
    "alert-info",
    "alert-success",
    "alert-warning",
    "alert-error",
  ],
  plugins: [daisyUI, typography, addDynamicIconSelectors()],
  daisyui: {
    themes: [
      {
        light: {
          "primary": "#e50000", /* Blood Red */
          "primary-content": "#ffffff",
          "secondary": "#000000",
          "accent": "#e50000",
          "neutral": "#000000",
          "base-100": "#f7f7f4", /* Paper White */
          "base-content": "#000000", /* Absolute Black text */
          "info": "#000000",
          "success": "#000000",
          "warning": "#e50000",
          "error": "#e50000",
        },
        dark: {
          "primary": "#e50000", /* Blood Red */
          "primary-content": "#ffffff",
          "secondary": "#ffffff",
          "accent": "#e50000",
          "neutral": "#ffffff",
          "base-100": "#050505", /* Absolute Black */
          "base-content": "#f7f7f4", /* Paper White text */
          "info": "#ffffff",
          "success": "#ffffff",
          "warning": "#e50000",
          "error": "#e50000",
        }
      }
    ],
    darkTheme: "dark", 
    logs: false, 
  },
};
