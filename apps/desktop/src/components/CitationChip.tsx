import { Button, Chip } from "@heroui/react";
import type { Citation } from "../lib/api";

export function CitationChip({
  citation,
  onOpen,
}: {
  citation: Citation;
  onOpen?: (citation: Citation) => void;
}) {
  if (!citation.resolved || citation.eli === null) {
    return (
      <Chip
        size="sm"
        variant="flat"
        className="mx-0.5 rounded-sm bg-foreground align-baseline text-background"
      >
        {citation.label}
      </Chip>
    );
  }
  return (
    <Button
      size="sm"
      variant="flat"
      className="mx-0.5 h-6 min-w-0 rounded-sm bg-foreground px-2 align-baseline text-background"
      onClick={(event) => {
        event.stopPropagation(); // the bubble itself is clickable (answer selection)
        onOpen?.(citation);
      }}
    >
      {citation.label}
    </Button>
  );
}
