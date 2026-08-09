import { heroui } from "@heroui/react";

// Chancery identity: white/near-black surfaces, Swiss red as the only accent.
//
// success/warning/danger are pinned explicitly in both themes instead of
// being left to `extend`'s inheritance from HeroUI's base light/dark themes.
// Spec §1: "every color explicit per theme — never rely on inherited color"
// (the regression class this guards against: sources panel text was once
// invisible in light mode because a color was only ever inherited). The
// values below are HeroUI's own base green/yellow/red scales — copied in
// verbatim, not redesigned — so making them explicit here is a zero-diff
// change today and a guarantee against a future implicit-inheritance bug.
export default heroui({
  themes: {
    "chancery-light": {
      extend: "light",
      colors: {
        background: "#fafafa",
        foreground: "#1a1a1a",
        content1: "#ffffff",
        content2: "#f4f4f2",
        divider: "#e2e2e2",
        primary: { DEFAULT: "#d52b1e", foreground: "#ffffff" },
        focus: "#d52b1e",
        success: {
          50: "#e8faf0",
          100: "#d1f4e0",
          200: "#a2e9c1",
          300: "#74dfa2",
          400: "#45d483",
          500: "#17c964",
          600: "#12a150",
          700: "#0e793c",
          800: "#095028",
          900: "#052814",
          DEFAULT: "#17c964",
          foreground: "#000000",
        },
        warning: {
          50: "#fefce8",
          100: "#fdedd3",
          200: "#fbdba7",
          300: "#f9c97c",
          400: "#f7b750",
          500: "#f5a524",
          600: "#c4841d",
          700: "#936316",
          800: "#62420e",
          900: "#312107",
          DEFAULT: "#f5a524",
          foreground: "#000000",
        },
        danger: {
          50: "#fee7ef",
          100: "#fdd0df",
          200: "#faa0bf",
          300: "#f871a0",
          400: "#f54180",
          500: "#f31260",
          600: "#c20e4d",
          700: "#920b3a",
          800: "#610726",
          900: "#310413",
          DEFAULT: "#f31260",
          foreground: "#ffffff",
        },
      },
    },
    "chancery-dark": {
      extend: "dark",
      colors: {
        background: "#141414",
        foreground: "#e8e8e8",
        content1: "#1e1e1e",
        content2: "#191919",
        divider: "#2c2c2c",
        primary: { DEFAULT: "#ff4438", foreground: "#141414" },
        focus: "#ff4438",
        success: {
          50: "#052814",
          100: "#095028",
          200: "#0e793c",
          300: "#12a150",
          400: "#17c964",
          500: "#45d483",
          600: "#74dfa2",
          700: "#a2e9c1",
          800: "#d1f4e0",
          900: "#e8faf0",
          DEFAULT: "#17c964",
          foreground: "#000000",
        },
        warning: {
          50: "#312107",
          100: "#62420e",
          200: "#936316",
          300: "#c4841d",
          400: "#f5a524",
          500: "#f7b750",
          600: "#f9c97c",
          700: "#fbdba7",
          800: "#fdedd3",
          900: "#fefce8",
          DEFAULT: "#f5a524",
          foreground: "#000000",
        },
        danger: {
          50: "#310413",
          100: "#610726",
          200: "#920b3a",
          300: "#c20e4d",
          400: "#f31260",
          500: "#f54180",
          600: "#f871a0",
          700: "#faa0bf",
          800: "#fdd0df",
          900: "#fee7ef",
          DEFAULT: "#f31260",
          foreground: "#ffffff",
        },
      },
    },
  },
});
