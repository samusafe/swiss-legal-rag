import { Button, Chip } from "@heroui/react";
import type { Citation } from "../lib/api";
import { openExternal } from "../lib/open";

export function CitationChip({ citation }: { citation: Citation }) {
  if (!citation.resolved || citation.eli === null) {
    return (
      <Chip size="sm" variant="flat" className="mx-0.5 align-baseline">
        {citation.raw}
      </Chip>
    );
  }
  const eli = citation.eli;
  return (
    <Button
      size="sm"
      variant="flat"
      color="primary"
      className="mx-0.5 h-6 min-w-0 px-2 align-baseline"
      onPress={() => openExternal(eli)}
      onClick={(event) => event.stopPropagation()}
    >
      {citation.raw}
    </Button>
  );
}
