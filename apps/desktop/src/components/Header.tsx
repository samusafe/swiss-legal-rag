import { Tab, Tabs } from "@heroui/react";
import type { Lang } from "../lib/api";

export function Header({
  online,
  lang,
  onLangChange,
}: {
  online: boolean;
  lang: Lang;
  onLangChange: (lang: Lang) => void;
}) {
  return (
    <header className="flex items-center gap-3 border-b border-divider px-4 py-3">
      <h1 className="text-lg font-semibold">Swiss Legal RAG</h1>
      <span
        data-testid="backend-status"
        title={online ? "retrieval API online" : "retrieval API offline"}
        className={`h-2.5 w-2.5 rounded-full ${online ? "bg-success" : "bg-danger"}`}
      />
      <div className="ml-auto">
        <Tabs
          size="sm"
          aria-label="Answer language"
          selectedKey={lang}
          onSelectionChange={(key) => onLangChange(String(key) as Lang)}
        >
          <Tab key="de" title="DE" />
          <Tab key="fr" title="FR" />
          <Tab key="it" title="IT" />
        </Tabs>
      </div>
    </header>
  );
}
