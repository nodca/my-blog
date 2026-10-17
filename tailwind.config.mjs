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
          '"Inter"',
          '"Helvetica Neue"',
          "Helvetica",
          "Arial",
          '"PingFang SC"',
          '"Hiragino Sans GB"',
          '"Noto Sans SC"',
          '"Source Han Sans SC"',
          '"Microsoft YaHei"',
          "sans-serif",
        ],
        serif: [
          '"Inter"',
          '"Helvetica Neue"',
          "Arial",
          '"PingFang SC"',
          '"Noto Sans SC"',
          '"Microsoft YaHei"',
          "sans-serif",
        ],
      },
      colors: {
        almond: "#FFFFFF",
        harbor: "#111111",
        pepper: "#E30613",
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
        // Swiss / International Typographic Style — light
        "editorial-light": {
          primary: "#111111",
          "primary-content": "#FFFFFF",
          secondary: "#111111",
          "secondary-content": "#FFFFFF",
          accent: "#E30613",
          "accent-content": "#FFFFFF",
          neutral: "#111111",
          "neutral-content": "#FFFFFF",
          "base-100": "#FFFFFF",
          "base-200": "#F4F4F2",
          "base-300": "#E6E6E3",
          "base-content": "#111111",
          info: "#111111",
          success: "#111111",
          warning: "#E30613",
          error: "#E30613",
          "--rounded-box": "0",
          "--rounded-btn": "0",
          "--rounded-badge": "0",
          "--tab-radius": "0",
          "--animation-btn": "0",
          "--btn-focus-scale": "1",
        },
        // Swiss — dark (inverse)
        "editorial-dark": {
          primary: "#F5F5F5",
          "primary-content": "#0A0A0A",
          secondary: "#F5F5F5",
          "secondary-content": "#0A0A0A",
          accent: "#E30613",
          "accent-content": "#FFFFFF",
          neutral: "#F5F5F5",
          "neutral-content": "#0A0A0A",
          "base-100": "#0A0A0A",
          "base-200": "#161616",
          "base-300": "#242424",
          "base-content": "#F5F5F5",
          info: "#F5F5F5",
          success: "#F5F5F5",
          warning: "#E30613",
          error: "#E30613",
          "--rounded-box": "0",
          "--rounded-btn": "0",
          "--rounded-badge": "0",
          "--tab-radius": "0",
          "--animation-btn": "0",
          "--btn-focus-scale": "1",
        },
      },
    ],
    darkTheme: "editorial-dark",
    logs: false,
  },
};
