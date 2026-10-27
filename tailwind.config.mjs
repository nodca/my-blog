/** @type {import('tailwindcss').Config} */
import { addDynamicIconSelectors } from "@iconify/tailwind";
import typography from "@tailwindcss/typography";
import daisyUI from "daisyui";

export default {
  content: ["./src/**/*.{astro,html,js,jsx,md,mdx,svelte,ts,tsx,vue}"],
  theme: {
    extend: {
      fontFamily: {
        sans: [
          '"Archivo Variable"',
          '"PingFang SC"',
          '"Microsoft YaHei"',
          '"Noto Sans SC"',
          "ui-sans-serif",
          "system-ui",
          "sans-serif",
        ],
        // Display stack: headlines only. Noto Sans SC 700 is bundled so the
        // Chinese headline weight is consistent across platforms.
        display: [
          '"Archivo Variable"',
          '"Noto Sans SC"',
          '"PingFang SC"',
          '"Microsoft YaHei"',
          "sans-serif",
        ],
        serif: [
          '"Archivo Variable"',
          '"Noto Sans SC"',
          '"PingFang SC"',
          '"Microsoft YaHei"',
          "sans-serif",
        ],
        mono: [
          '"JetBrains Mono"',
          '"Sarasa Mono SC"',
          "ui-monospace",
          "monospace",
        ],
      },
      colors: {
        // Constructivist poster palette (see hero-drafts/design-plan.md)
        "print-red": "#D8341E",
        ink: "#000000",
        newsprint: "#EDE6D6",
        "paper-shade": "#DCD3BF",
        "faded-ink": "#5A5650",
        // legacy alias kept so older components keep compiling
        pepper: "#D8341E",
      },
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
        "editorial-light": {
          primary: "#000000",
          "primary-content": "#EDE6D6",
          secondary: "#5A5650",
          "secondary-content": "#EDE6D6",
          accent: "#D8341E",
          "accent-content": "#EDE6D6",
          neutral: "#000000",
          "neutral-content": "#EDE6D6",
          "base-100": "#EDE6D6",
          "base-200": "#DCD3BF",
          "base-300": "#CFC5AE",
          "base-content": "#000000",
          info: "#5A5650",
          success: "#3F6B4E",
          warning: "#D8341E",
          error: "#D8341E",
          "--rounded-box": "0",
          "--rounded-btn": "0",
          "--rounded-badge": "0",
        },
        "editorial-dark": {
          primary: "#EDE6D6",
          "primary-content": "#141210",
          secondary: "#A8A196",
          "secondary-content": "#141210",
          accent: "#E8502F",
          "accent-content": "#141210",
          neutral: "#EDE6D6",
          "neutral-content": "#141210",
          "base-100": "#141210",
          "base-200": "#1F1C18",
          "base-300": "#2A2621",
          "base-content": "#EDE6D6",
          info: "#A8A196",
          success: "#7FA98A",
          warning: "#E8502F",
          error: "#E8502F",
          "--rounded-box": "0",
          "--rounded-btn": "0",
          "--rounded-badge": "0",
        },
      },
    ],
    darkTheme: "editorial-dark",
    logs: false,
  },
};
