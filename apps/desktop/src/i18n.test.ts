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
    expect(t("search.placeholder")).toBe("Search articles…");
  });

  it("t() returns German after setLang('de')", () => {
    const { result } = renderHook(() => useLang());

    act(() => {
      result.current.setLang("de");
    });

    expect(t("search.placeholder")).toBe("Artikel suchen…");
  });

  it("t() returns European Portuguese after setLang('pt')", () => {
    const { result } = renderHook(() => useLang());

    act(() => {
      result.current.setLang("pt");
    });

    expect(t("search.placeholder")).toBe("Pesquisar artigos…");
  });

  it("useLang re-renders subscribers when language changes", () => {
    const { result } = renderHook(() => useLang());

    expect(result.current.lang).toBe("en");

    act(() => {
      result.current.setLang("fr");
    });

    expect(result.current.lang).toBe("fr");
    expect(t("search.placeholder")).toBe("Rechercher des articles…");
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
    expect(fresh.t("search.placeholder")).toBe("Search articles…");
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

  describe("settings.jurisdiction* keys", () => {
    const expected = {
      en: {
        jurisdiction: "Jurisdiction",
        none: "None — federal law only",
        federalOnly: "federal only",
        hint: "Answers include this canton's law where available.",
      },
      de: {
        jurisdiction: "Zuständigkeit",
        none: "Keine — nur Bundesrecht",
        federalOnly: "nur Bundesrecht",
        hint: "Antworten berücksichtigen kantonales Recht, sofern verfügbar.",
      },
      fr: {
        jurisdiction: "Juridiction",
        none: "Aucune — droit fédéral uniquement",
        federalOnly: "fédéral uniquement",
        hint: "Les réponses incluent le droit de ce canton lorsqu'il est disponible.",
      },
      it: {
        jurisdiction: "Giurisdizione",
        none: "Nessuna — solo diritto federale",
        federalOnly: "solo federale",
        hint: "Le risposte includono il diritto di questo cantone, se disponibile.",
      },
      pt: {
        jurisdiction: "Jurisdição",
        none: "Nenhuma — apenas direito federal",
        federalOnly: "apenas federal",
        hint: "As respostas incluem o direito deste cantão quando disponível.",
      },
    } as const;
    const langs = ["en", "de", "fr", "it", "pt"] as const;

    it.each(langs)("resolves every settings.jurisdiction* key in %s", (lang) => {
      const { result } = renderHook(() => useLang());
      act(() => {
        result.current.setLang(lang);
      });

      expect(t("settings.jurisdiction")).toBe(expected[lang].jurisdiction);
      expect(t("settings.jurisdictionNone")).toBe(expected[lang].none);
      expect(t("settings.jurisdictionFederalOnly")).toBe(expected[lang].federalOnly);
      expect(t("settings.jurisdictionHint")).toBe(expected[lang].hint);
    });
  });

  describe("chat.interrupted key", () => {
    const expected = {
      en: "Answer interrupted — send your question again.",
      de: "Antwort unterbrochen — stelle deine Frage erneut.",
      fr: "Réponse interrompue — renvoyez votre question.",
      it: "Risposta interrotta — invia di nuovo la domanda.",
      pt: "Resposta interrompida — envia a pergunta de novo.",
    } as const;
    const langs = ["en", "de", "fr", "it", "pt"] as const;

    it.each(langs)("resolves chat.interrupted in %s", (lang) => {
      const { result } = renderHook(() => useLang());
      act(() => {
        result.current.setLang(lang);
      });

      expect(t("chat.interrupted")).toBe(expected[lang]);
    });
  });
});
