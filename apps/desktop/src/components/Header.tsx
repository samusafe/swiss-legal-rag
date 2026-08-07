import { Button, Tab, Tabs } from "@heroui/react";
import type { Lang } from "../lib/api";

export function Header({
  online,
  lang,
  onLangChange,
  ingestPercent,
  onOpenCorpus,
}: {
  online: boolean;
  lang: Lang;
  onLangChange: (lang: Lang) => void;
  ingestPercent: number | null;
  onOpenCorpus: () => void;
}) {
  return (
    <header className="flex flex-wrap items-center gap-3 border-b border-divider px-4 py-3">
      <h1 className="text-lg font-semibold">Swiss Legal RAG</h1>
      <span
        data-testid="backend-status"
        title={online ? "retrieval API online" : "retrieval API offline"}
        className={`h-2.5 w-2.5 rounded-full ${online ? "bg-success" : "bg-danger"}`}
      />
      <Button
        size="sm"
        variant="light"
        aria-label={ingestPercent !== null ? `Corpus, ${ingestPercent}% embedded` : "Corpus"}
        className="min-w-0 px-2 text-lg text-foreground"
        onPress={onOpenCorpus}
      >
        {"⛁︎"}
        {ingestPercent !== null && <span className="ml-1 text-xs">{ingestPercent}%</span>}
      </Button>
      <div className="ml-auto flex items-center gap-2">
        <span className="hidden text-xs text-foreground-400 sm:inline">Answer language</span>
        <Tabs
          size="sm"
          aria-label="Answer language"
          selectedKey={lang}
          onSelectionChange={(key) => onLangChange(String(key) as Lang)}
        >
          <Tab key="de" title={<span title="Deutsch">DE</span>} />
          <Tab key="fr" title={<span title="Français">FR</span>} />
          <Tab key="it" title={<span title="Italiano">IT</span>} />
        </Tabs>
      </div>
    </header>
  );
}
