import { Button } from "@heroui/react";

export function Header({
  online,
  ingestPercent,
  onOpenCorpus,
}: {
  online: boolean;
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
        className="ml-auto min-w-0 px-2 text-lg text-foreground"
        onPress={onOpenCorpus}
      >
        {"⛁︎"}
        {ingestPercent !== null && <span className="ml-1 text-xs">{ingestPercent}%</span>}
      </Button>
    </header>
  );
}
