import { HeroUIProvider } from "@heroui/react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, test, vi } from "vitest";
import type { Article } from "../lib/api";
import { t } from "../i18n";
import { ArticleDocModal } from "./ArticleDocModal";

vi.mock("../lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/api")>();
  return {
    ...actual,
    fetchArticle: vi.fn(),
  };
});
vi.mock("../lib/open", () => ({
  openExternal: vi.fn(),
}));
vi.mock("../lib/audit", () => ({
  logAudit: vi.fn(),
}));

import { ApiError, fetchArticle } from "../lib/api";
import { logAudit } from "../lib/audit";

const fetchArticleMock = vi.mocked(fetchArticle);
const logAuditMock = vi.mocked(logAudit);

const article: Article = {
  sr: "220",
  article: "335b",
  lang: "fr",
  heading: "Pendant le temps d'essai",
  actName: "Code des obligations",
  abbrev: "CO",
  eli: "https://www.fedlex.admin.ch/eli/cc/27/317_321_377/fr#art_335_b",
  versionDate: "2026-01-01",
  texts: ["First paragraph.", "Second paragraph."],
  availableLangs: ["de", "fr", "it"],
};

beforeEach(() => {
  fetchArticleMock.mockReset();
  logAuditMock.mockReset();
});

function renderModal(target: { refs: { sr: string; article: string; lang: "de" | "fr" | "it" }[]; index: number } | null) {
  return render(
    <HeroUIProvider>
      <ArticleDocModal target={target} onClose={() => {}} />
    </HeroUIProvider>,
  );
}

describe("ArticleDocModal", () => {
  test("renders full article with header, paragraphs and Fedlex button", async () => {
    fetchArticleMock.mockResolvedValue(article);
    renderModal({ refs: [{ sr: "220", article: "335b", lang: "fr" }], index: 0 });

    expect(await screen.findByText("First paragraph.")).toBeInTheDocument();
    expect(screen.getByText("Second paragraph.")).toBeInTheDocument();
    expect(screen.getByText(/Code des obligations/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Fedlex/i })).toBeInTheDocument();
  });

  test("arrow navigation moves between refs", async () => {
    fetchArticleMock.mockResolvedValue(article);
    renderModal({
      refs: [
        { sr: "220", article: "335b", lang: "fr" },
        { sr: "822.11", article: "9", lang: "fr" },
      ],
      index: 0,
    });

    await screen.findByText("First paragraph.");
    expect(screen.getByText("1 / 2")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: t("article.next") }));
    expect(fetchArticleMock).toHaveBeenLastCalledWith("822.11", "9", "fr", expect.anything());
  });

  test("ArrowRight navigates immediately on open, before any tab/click into the body", async () => {
    fetchArticleMock.mockResolvedValue(article);
    // Distinct (sr, article) pair from the other tests: the article cache is
    // module-level, so a reused key would return the cached success without
    // exercising fetchArticle (and thus without proving navigation fired).
    renderModal({
      refs: [
        { sr: "784.10", article: "3", lang: "fr" },
        { sr: "935.61", article: "7", lang: "fr" },
      ],
      index: 0,
    });

    await screen.findByText("First paragraph.");
    expect(screen.getByText("1 / 2")).toBeInTheDocument();

    // No click/tab into the modal body — press the key wherever HeroUI put
    // initial focus on open (the dialog container), exactly as a user would
    // right after opening from a chip/card/palette result.
    await userEvent.keyboard("{ArrowRight}");

    expect(await screen.findByText("2 / 2")).toBeInTheDocument();
    expect(fetchArticleMock).toHaveBeenLastCalledWith("935.61", "7", "fr", expect.anything());
  });

  test("switching the language tab logs article.langSwitch", async () => {
    fetchArticleMock.mockResolvedValue(article);
    const user = userEvent.setup();
    renderModal({ refs: [{ sr: "220", article: "335b", lang: "fr" }], index: 0 });

    await screen.findByText("First paragraph.");
    await user.click(screen.getByRole("tab", { name: "DE" }));

    expect(logAuditMock).toHaveBeenCalledWith("article.langSwitch", {
      sr: "220",
      article: "335b",
      from: "fr",
      to: "de",
    });
  });

  test("pressing the Fedlex button logs article.fedlex", async () => {
    fetchArticleMock.mockResolvedValue(article);
    const user = userEvent.setup();
    renderModal({ refs: [{ sr: "220", article: "335b", lang: "fr" }], index: 0 });

    await screen.findByText("First paragraph.");
    await user.click(screen.getByRole("button", { name: /Fedlex/i }));

    expect(logAuditMock).toHaveBeenCalledWith("article.fedlex", { sr: "220", article: "335b" });
  });

  test("404 shows not-in-language message", async () => {
    fetchArticleMock.mockRejectedValue(new ApiError("not available", 404));
    // Distinct (sr, article) pair from the other tests: the article cache is
    // module-level, so reusing 220/335b would return the cached success and
    // never exercise the 404 path.
    renderModal({ refs: [{ sr: "946.20", article: "1", lang: "fr" }], index: 0 });

    expect(await screen.findByRole("alert")).toHaveTextContent(t("article.notInLang"));
  });
});
