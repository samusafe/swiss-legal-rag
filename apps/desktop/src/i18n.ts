import { useSyncExternalStore } from "react";
import { prefs } from "./lib/prefs";
import type { SearchLang } from "./lib/api";

export type Lang = "en" | "de" | "fr" | "it" | "pt";

const LANGS: readonly Lang[] = ["en", "de", "fr", "it", "pt"];

function isLang(value: unknown): value is Lang {
  return typeof value === "string" && (LANGS as readonly string[]).includes(value);
}

/**
 * UI copy, keyed by feature area. `en` is the required fallback; `de`/`fr`/`it`/`pt`
 * (European Portuguese) are complete for every key today, but the type stays
 * `Partial` so a future key can ship English-first without breaking the build.
 */
const dict = {
  "app.title": {
    en: "Swiss Legal RAG",
    de: "Swiss Legal RAG",
    fr: "Swiss Legal RAG",
    it: "Swiss Legal RAG",
    pt: "Swiss Legal RAG",
  },
  "health.online": { en: "Online", de: "Online", fr: "En ligne", it: "Online", pt: "Online" },
  "health.offline": { en: "Offline", de: "Offline", fr: "Hors ligne", it: "Offline", pt: "Offline" },
  "search.placeholder": {
    en: "Search articles…",
    de: "Artikel suchen…",
    fr: "Rechercher des articles…",
    it: "Cerca articoli…",
    pt: "Pesquisar artigos…",
  },
  "search.hint": {
    en: "Type to search articles by SR number, article, or keyword.",
    de: "Tippen Sie, um Artikel nach SR-Nummer, Artikel oder Stichwort zu suchen.",
    fr: "Tapez pour rechercher des articles par numéro RS, article ou mot-clé.",
    it: "Digita per cercare articoli per numero RS, articolo o parola chiave.",
    pt: "Digite para pesquisar artigos por número SR, artigo ou palavra-chave.",
  },
  "search.searching": {
    en: "Searching articles… this can take up to a minute on this device.",
    de: "Artikel werden durchsucht… dies kann auf diesem Gerät bis zu einer Minute dauern.",
    fr: "Recherche d'articles en cours… cela peut prendre jusqu'à une minute sur cet appareil.",
    it: "Ricerca articoli in corso… su questo dispositivo può richiedere fino a un minuto.",
    pt: "A pesquisar artigos… pode demorar até um minuto neste dispositivo.",
  },
  "search.empty": {
    en: "No results found.",
    de: "Keine Ergebnisse gefunden.",
    fr: "Aucun résultat trouvé.",
    it: "Nessun risultato trovato.",
    pt: "Nenhum resultado encontrado.",
  },
  "search.error": {
    en: "Search failed. Please try again.",
    de: "Suche fehlgeschlagen. Bitte versuchen Sie es erneut.",
    fr: "Échec de la recherche. Veuillez réessayer.",
    it: "Ricerca non riuscita. Riprova.",
    pt: "A pesquisa falhou. Tente novamente.",
  },
  "search.openPalette": {
    en: "Open article search",
    de: "Artikelsuche öffnen",
    fr: "Ouvrir la recherche d'articles",
    it: "Apri la ricerca articoli",
    pt: "Abrir pesquisa de artigos",
  },
  "search.shortcut": {
    en: "Ctrl+K",
    de: "Ctrl+K",
    fr: "Ctrl+K",
    it: "Ctrl+K",
    pt: "Ctrl+K",
  },
  "convo.section": {
    en: "Conversations",
    de: "Unterhaltungen",
    fr: "Conversations",
    it: "Conversazioni",
    pt: "Conversas",
  },
  "convo.new": {
    en: "New conversation",
    de: "Neue Unterhaltung",
    fr: "Nouvelle conversation",
    it: "Nuova conversazione",
    pt: "Nova conversa",
  },
  "convo.rename": {
    en: "Rename",
    de: "Umbenennen",
    fr: "Renommer",
    it: "Rinomina",
    pt: "Mudar nome",
  },
  "convo.delete": { en: "Delete", de: "Löschen", fr: "Supprimer", it: "Elimina", pt: "Apagar" },
  "convo.deleteConfirm": {
    en: "Delete this conversation? This cannot be undone.",
    de: "Diese Unterhaltung löschen? Dies kann nicht rückgängig gemacht werden.",
    fr: "Supprimer cette conversation ? Cette action est irréversible.",
    it: "Eliminare questa conversazione? L'operazione non può essere annullata.",
    pt: "Apagar esta conversa? Esta ação não pode ser anulada.",
  },
  "convo.untitled": {
    en: "Untitled conversation",
    de: "Unbenannte Unterhaltung",
    fr: "Conversation sans titre",
    it: "Conversazione senza titolo",
    pt: "Conversa sem título",
  },
  "composer.placeholder": {
    en: "Ask a question about Swiss federal law…",
    de: "Stellen Sie eine Frage zum Schweizer Bundesrecht…",
    fr: "Posez une question sur le droit fédéral suisse…",
    it: "Fai una domanda sul diritto federale svizzero…",
    pt: "Faça uma pergunta sobre o direito federal suíço…",
  },
  "composer.stop": { en: "Stop", de: "Stopp", fr: "Arrêter", it: "Interrompi", pt: "Parar" },
  "composer.offline": {
    en: "The retrieval service is offline.",
    de: "Der Retrieval-Dienst ist offline.",
    fr: "Le service de recherche est hors ligne.",
    it: "Il servizio di ricerca è offline.",
    pt: "O serviço de pesquisa está offline.",
  },
  "sources.title": { en: "Sources", de: "Quellen", fr: "Sources", it: "Fonti", pt: "Fontes" },
  "sources.latest": {
    en: "Latest answer",
    de: "Letzte Antwort",
    fr: "Dernière réponse",
    it: "Ultima risposta",
    pt: "Última resposta",
  },
  "sources.answerN": {
    en: "Answer {n}",
    de: "Antwort {n}",
    fr: "Réponse {n}",
    it: "Risposta {n}",
    pt: "Resposta {n}",
  },
  "sources.cited": { en: "Cited", de: "Zitiert", fr: "Citée", it: "Citata", pt: "Citada" },
  "sources.collapse": {
    en: "Collapse sources",
    de: "Quellen einklappen",
    fr: "Réduire les sources",
    it: "Comprimi le fonti",
    pt: "Recolher fontes",
  },
  "sources.expand": {
    en: "Expand sources",
    de: "Quellen ausklappen",
    fr: "Développer les sources",
    it: "Espandi le fonti",
    pt: "Expandir fontes",
  },
  "preview.fedlex": {
    en: "View on Fedlex",
    de: "Auf Fedlex ansehen",
    fr: "Voir sur Fedlex",
    it: "Visualizza su Fedlex",
    pt: "Ver no Fedlex",
  },
  "preview.loading": {
    en: "Loading preview…",
    de: "Vorschau wird geladen…",
    fr: "Chargement de l'aperçu…",
    it: "Caricamento anteprima…",
    pt: "A carregar pré-visualização…",
  },
  "settings.title": {
    en: "Settings",
    de: "Einstellungen",
    fr: "Paramètres",
    it: "Impostazioni",
    pt: "Definições",
  },
  "settings.general": { en: "General", de: "Allgemein", fr: "Général", it: "Generale", pt: "Geral" },
  "settings.corpus": { en: "Corpus", de: "Korpus", fr: "Corpus", it: "Corpus", pt: "Corpus" },
  "settings.export": { en: "Export", de: "Export", fr: "Exporter", it: "Esporta", pt: "Exportar" },
  "settings.language": { en: "Language", de: "Sprache", fr: "Langue", it: "Lingua", pt: "Idioma" },
  "settings.notifications": {
    en: "Notifications",
    de: "Benachrichtigungen",
    fr: "Notifications",
    it: "Notifiche",
    pt: "Notificações",
  },
  "settings.notifyHint": {
    en: "Show a notification when an answer finishes generating.",
    de: "Benachrichtigung anzeigen, sobald eine Antwort fertig generiert ist.",
    fr: "Afficher une notification lorsqu'une réponse est terminée.",
    it: "Mostra una notifica al termine della generazione di una risposta.",
    pt: "Mostrar uma notificação quando uma resposta terminar de ser gerada.",
  },
  "corpus.status": {
    en: "Corpus status",
    de: "Korpusstatus",
    fr: "État du corpus",
    it: "Stato del corpus",
    pt: "Estado do corpus",
  },
  "corpus.run": {
    en: "Run ingestion",
    de: "Ingestion starten",
    fr: "Lancer l'ingestion",
    it: "Avvia ingestione",
    pt: "Executar ingestão",
  },
  "corpus.running": {
    en: "Running…",
    de: "Läuft…",
    fr: "En cours…",
    it: "In corso…",
    pt: "A decorrer…",
  },
  "corpus.empty": {
    en: "The corpus is empty.",
    de: "Der Korpus ist leer.",
    fr: "Le corpus est vide.",
    it: "Il corpus è vuoto.",
    pt: "O corpus está vazio.",
  },
  "corpus.chatUsable": {
    en: "Chat stays usable — results may be incomplete while embedding.",
    de: "Der Chat bleibt nutzbar — Ergebnisse können während des Embeddings unvollständig sein.",
    fr: "Le chat reste utilisable — les résultats peuvent être incomplets pendant l'embedding.",
    it: "La chat resta utilizzabile — i risultati possono essere incompleti durante l'embedding.",
    pt: "O chat continua utilizável — os resultados podem estar incompletos durante o embedding.",
  },
  "corpus.stop": {
    en: "Stop",
    de: "Stoppen",
    fr: "Arrêter",
    it: "Interrompi",
    pt: "Parar",
  },
  "corpus.stopConfirm": {
    en: "Stop the running ingestion? Progress so far is kept, but the current phase is aborted.",
    de: "Laufende Ingestion stoppen? Der bisherige Fortschritt bleibt erhalten, aber die aktuelle Phase wird abgebrochen.",
    fr: "Arrêter l'ingestion en cours ? La progression déjà réalisée est conservée, mais la phase actuelle est interrompue.",
    it: "Interrompere l'ingestione in corso? I progressi finora sono mantenuti, ma la fase corrente viene interrotta.",
    pt: "Parar a ingestão em curso? O progresso até agora é mantido, mas a fase atual é interrompida.",
  },
  "export.json": {
    en: "Export as JSON",
    de: "Als JSON exportieren",
    fr: "Exporter en JSON",
    it: "Esporta come JSON",
    pt: "Exportar como JSON",
  },
  "export.markdown": {
    en: "Export as Markdown",
    de: "Als Markdown exportieren",
    fr: "Exporter en Markdown",
    it: "Esporta come Markdown",
    pt: "Exportar como Markdown",
  },
  "export.done": { en: "Exported", de: "Exportiert", fr: "Exporté", it: "Esportato", pt: "Exportado" },
  "banner.corpusEmpty": {
    en: "The corpus is empty. Run ingestion to start asking questions.",
    de: "Der Korpus ist leer. Starten Sie die Ingestion, um Fragen zu stellen.",
    fr: "Le corpus est vide. Lancez l'ingestion pour commencer à poser des questions.",
    it: "Il corpus è vuoto. Avvia l'ingestione per iniziare a porre domande.",
    pt: "O corpus está vazio. Execute a ingestão para começar a fazer perguntas.",
  },
  "theme.label": { en: "Theme", de: "Design", fr: "Thème", it: "Tema", pt: "Tema" },
  "theme.system": {
    en: "System",
    de: "System",
    fr: "Système",
    it: "Sistema",
    pt: "Sistema",
  },
  "theme.light": { en: "Light", de: "Hell", fr: "Clair", it: "Chiaro", pt: "Claro" },
  "theme.dark": { en: "Dark", de: "Dunkel", fr: "Sombre", it: "Scuro", pt: "Escuro" },
  "article.loading": {
    en: "Loading article…",
    de: "Artikel wird geladen…",
    fr: "Chargement de l'article…",
    it: "Caricamento dell'articolo…",
    pt: "A carregar o artigo…",
  },
  "article.error": {
    en: "Could not load the article. Please try again.",
    de: "Der Artikel konnte nicht geladen werden. Bitte erneut versuchen.",
    fr: "Impossible de charger l'article. Veuillez réessayer.",
    it: "Impossibile caricare l'articolo. Riprova.",
    pt: "Não foi possível carregar o artigo. Tente novamente.",
  },
  "article.notInLang": {
    en: "This article is not available in this language.",
    de: "Dieser Artikel ist in dieser Sprache nicht verfügbar.",
    fr: "Cet article n'est pas disponible dans cette langue.",
    it: "Questo articolo non è disponibile in questa lingua.",
    pt: "Este artigo não está disponível nesta língua.",
  },
  "article.fedlex": {
    en: "Open in Fedlex",
    de: "In Fedlex öffnen",
    fr: "Ouvrir dans Fedlex",
    it: "Apri in Fedlex",
    pt: "Abrir no Fedlex",
  },
  "article.version": {
    en: "Version of {date}",
    de: "Fassung vom {date}",
    fr: "Version du {date}",
    it: "Versione del {date}",
    pt: "Versão de {date}",
  },
  "article.prev": {
    en: "Previous article",
    de: "Vorheriger Artikel",
    fr: "Article précédent",
    it: "Articolo precedente",
    pt: "Artigo anterior",
  },
  "article.next": {
    en: "Next article",
    de: "Nächster Artikel",
    fr: "Article suivant",
    it: "Articolo successivo",
    pt: "Artigo seguinte",
  },
} satisfies Record<string, { en: string } & Partial<Record<Exclude<Lang, "en">, string>>>;

export type UiKey = keyof typeof dict;

function readInitialLang(): Lang {
  const stored = prefs.get<string>("lang", "en");
  return isLang(stored) ? stored : "en";
}

let currentLang: Lang = readInitialLang();
const subscribers = new Set<() => void>();

/**
 * Reads a UI string in the current language, falling back to English.
 * `params` fills `{name}` placeholders (e.g. `sources.answerN`'s `"Answer {n}"`).
 */
export function t(key: UiKey, params?: Record<string, string | number>): string {
  const raw = dict[key][currentLang] ?? dict[key].en;
  if (params === undefined) return raw;
  return raw.replace(/\{(\w+)\}/g, (match, name: string) =>
    Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : match,
  );
}

/** Sets the current UI language and persists it (`slr.lang`). */
export function setLang(lang: Lang): void {
  currentLang = lang;
  prefs.set("lang", lang);
  subscribers.forEach((callback) => callback());
}

function subscribe(callback: () => void): () => void {
  subscribers.add(callback);
  return () => subscribers.delete(callback);
}

function getSnapshot(): Lang {
  return currentLang;
}

/** Subscribes the calling component to the current UI language. */
export function useLang(): { lang: Lang; setLang: (lang: Lang) => void } {
  const lang = useSyncExternalStore(subscribe, getSnapshot);
  return { lang, setLang };
}

// The retrieval corpus is DE/FR/IT only; "en" and "pt" are display-languages,
// not corpus languages, so they need concrete fallbacks here (pt -> fr as the
// closest Romance corpus language).
export function toSearchLang(lang: Lang): SearchLang {
  if (lang === "en") return "de";
  if (lang === "pt") return "fr";
  return lang;
}
