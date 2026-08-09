import { Button, Chip } from "@heroui/react";
import type { Citation } from "../lib/api";
import { ArticlePreview } from "./ArticlePreview";

export function CitationChip({ citation }: { citation: Citation }) {
  if (!citation.resolved || citation.eli === null) {
    return (
      <Chip
        size="sm"
        variant="flat"
        className="mx-0.5 rounded-sm bg-foreground align-baseline text-background"
      >
        {citation.raw}
      </Chip>
    );
  }
  return (
    <ArticlePreview
      srNumber={citation.sr}
      article={citation.article}
      trigger={
        <Button
          size="sm"
          variant="flat"
          className="mx-0.5 h-6 min-w-0 rounded-sm bg-foreground px-2 align-baseline text-background"
          onClick={(event) => event.stopPropagation()}
        >
          {citation.raw}
        </Button>
      }
    />
  );
}
