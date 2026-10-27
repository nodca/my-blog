import mdx from "@astrojs/mdx";
import sitemap from "@astrojs/sitemap";
import tailwind from "@astrojs/tailwind";
import playformCompress from "@playform/compress";
import terser from "@rollup/plugin-terser";
import expressiveCode from "astro-expressive-code";
import icon from "astro-icon";
import { defineConfig } from "astro/config";
import rehypeExternalLinks from "rehype-external-links";
import rehypeKatex from "rehype-katex";
import remarkMath from "remark-math";

import { CODE_THEME, USER_SITE } from "./src/config.ts";

import updateConfig from "./src/integration/updateConfig.ts";

import { remarkReadingTime } from "./src/plugins/remark-reading-time";

// https://astro.build/config
export default defineConfig({
  site: USER_SITE,
  output: "static",
  style: {
    scss: {
      includePaths: ["./src/styles"],
    },
  },
  integrations: [updateConfig(), expressiveCode({
    // Light + dark code themes follow the site's data-theme-type switch.
    // CODE_THEME (frosti.config.yaml) is kept as the dark theme.
    themes: ["github-light", CODE_THEME],
    useDarkModeMediaQuery: false,
    themeCssSelector: (theme) =>
      `[data-theme-type="${theme.type === "dark" ? "dark" : "light"}"]`,
    styleOverrides: {
      borderRadius: "0",
      borderWidth: "0",
      codeFontFamily: '"JetBrains Mono", "Sarasa Mono SC", ui-monospace, monospace',
      uiFontFamily: '"Archivo Variable", "PingFang SC", "Microsoft YaHei", sans-serif',
      codeFontSize: "0.875rem",
      codeLineHeight: "1.7",
      codeBackground: ({ theme }) => (theme.type === "dark" ? "#1F1C18" : "#DCD3BF"),
      frames: {
        shadowColor: "transparent",
        editorTabBarBackground: ({ theme }) => (theme.type === "dark" ? "#2A2621" : "#CFC5AE"),
        editorActiveTabBackground: ({ theme }) => (theme.type === "dark" ? "#1F1C18" : "#DCD3BF"),
        editorActiveTabIndicatorTopColor: "transparent",
        editorActiveTabIndicatorBottomColor: "transparent",
        terminalTitlebarBackground: ({ theme }) => (theme.type === "dark" ? "#2A2621" : "#CFC5AE"),
        terminalBackground: ({ theme }) => (theme.type === "dark" ? "#1F1C18" : "#DCD3BF"),
        terminalTitlebarDotsOpacity: "0",
        frameBoxShadowCssValue: "none",
      },
    },
  }), mdx(), icon(), terser({
    compress: true,
    mangle: true,
  }), sitemap(), tailwind({
    configFile: "./tailwind.config.mjs",
  }), playformCompress()],
  markdown: {
    remarkPlugins: [remarkMath, remarkReadingTime],
    rehypePlugins: [rehypeKatex, [
      rehypeExternalLinks,
      {
        content: { type: "text", value: "↗" },
      },
    ]],
  },
  vite: {
    css: {
      preprocessorOptions: {
        scss: {
          api: "modern-compiler",
        },
      },
    },
  },
});
