import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { setLang, t, useLang } from "./i18n";
import { prefs } from "./lib/prefs";

describe("i18n", () => {
  beforeEach(() => {
    localStorage.clear();
    // Module state is a singleton (see i18n.ts) — reset it between tests
    // so assertions never depend on execution order.
    setLang("en");
  });

  it("t() returns English by default", () => {
    expect(t("search.placeholder")).toBe("Search…");
  });

  it("t() returns German after setLang('de')", () => {
    const { result } = renderHook(() => useLang());

    act(() => {
      result.current.setLang("de");
    });

    expect(t("search.placeholder")).toBe("Suchen…");
  });

  it("t() returns European Portuguese after setLang('pt')", () => {
    const { result } = renderHook(() => useLang());

    act(() => {
      result.current.setLang("pt");
    });

    expect(t("search.placeholder")).toBe("Pesquisar…");
  });

  it("useLang re-renders subscribers when language changes", () => {
    const { result } = renderHook(() => useLang());

    expect(result.current.lang).toBe("en");

    act(() => {
      result.current.setLang("fr");
    });

    expect(result.current.lang).toBe("fr");
    expect(t("search.placeholder")).toBe("Rechercher…");
  });

  it("setLang persists the choice under slr.lang via prefs", () => {
    const { result } = renderHook(() => useLang());

    act(() => {
      result.current.setLang("it");
    });

    expect(localStorage.getItem("slr.lang")).toBe(JSON.stringify("it"));
    expect(prefs.get("lang", "en")).toBe("it");
  });

  it("falls back to English on load when localStorage holds an unknown language code", async () => {
    localStorage.setItem("slr.lang", JSON.stringify("xx"));
    vi.resetModules();
    const fresh = await import("./i18n");

    const { result } = renderHook(() => fresh.useLang());

    expect(result.current.lang).toBe("en");
    expect(fresh.t("search.placeholder")).toBe("Search…");
  });

  it("prefs round-trips JSON values", () => {
    prefs.set("test.value", { a: 1, b: "two" });
    expect(prefs.get("test.value", null)).toEqual({ a: 1, b: "two" });
    expect(prefs.get("test.missing", "fallback")).toBe("fallback");
  });

  // No blanket "every key resolves in every language" test exists in this
  // file (dict values stay `Partial` by design, see i18n.ts's module doc) —
  // so the theme toggle's keys get their own explicit coverage instead.
  describe("theme.* keys", () => {
    const expected = {
      en: { label: "Theme", system: "System", light: "Light", dark: "Dark" },
      de: { label: "Design", system: "System", light: "Hell", dark: "Dunkel" },
      fr: { label: "Thème", system: "Système", light: "Clair", dark: "Sombre" },
      it: { label: "Tema", system: "Sistema", light: "Chiaro", dark: "Scuro" },
      pt: { label: "Tema", system: "Sistema", light: "Claro", dark: "Escuro" },
    } as const;
    const langs = ["en", "de", "fr", "it", "pt"] as const;

    it.each(langs)("resolves every theme.* key in %s", (lang) => {
      const { result } = renderHook(() => useLang());
      act(() => {
        result.current.setLang(lang);
      });

      expect(t("theme.label")).toBe(expected[lang].label);
      expect(t("theme.system")).toBe(expected[lang].system);
      expect(t("theme.light")).toBe(expected[lang].light);
      expect(t("theme.dark")).toBe(expected[lang].dark);
    });
  });
});
