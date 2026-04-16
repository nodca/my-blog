/** @type {import('tailwindcss').Config} */
import { addDynamicIconSelectors } from "@iconify/tailwind";
import typography from "@tailwindcss/typography";
import daisyUI from "daisyui";

export default {
  content: ["./src/**/*.{astro,html,js,jsx,md,mdx,svelte,ts,tsx,vue}"],
  theme: {
    extend: {
      fontFamily: {
        sans: ['"Inter"', "ui-sans-serif", "system-ui", "sans-serif"],
        serif: ['"Playfair Display"', "ui-serif", "Georgia", "serif"],
      },
      colors: {
        almond: "#FDF0D5",
        harbor: "#003049",
        pepper: "#D62828",
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
          primary: "#003049",
          "primary-content": "#FDF0D5",
          secondary: "#1F4256",
          "secondary-content": "#FDF0D5",
          accent: "#D62828",
          "accent-content": "#FFF4EF",
          neutral: "#003049",
          "neutral-content": "#FDF0D5",
          "base-100": "#FDF0D5",
          "base-200": "#F7E5C3",
          "base-300": "#EFD9B1",
          "base-content": "#003049",
          info: "#1F4256",
          success: "#2A9D8F",
          warning: "#D62828",
          error: "#D62828",
        },
        "editorial-dark": {
          primary: "#FDF0D5",
          "primary-content": "#003049",
          secondary: "#DCCFB6",
          "secondary-content": "#0F2533",
          accent: "#D62828",
          "accent-content": "#FFF4EF",
          neutral: "#FDF0D5",
          "neutral-content": "#0F2533",
          "base-100": "#0F2533",
          "base-200": "#173648",
          "base-300": "#20485C",
          "base-content": "#FDF0D5",
          info: "#DCCFB6",
          success: "#5BB7A7",
          warning: "#D62828",
          error: "#D62828",
        },
      },
    ],
    darkTheme: "editorial-dark",
    logs: false,
  },
};
