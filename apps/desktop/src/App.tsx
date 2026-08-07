import { useState } from "react";
import { Composer } from "./components/Composer";
import { CorpusModal } from "./components/CorpusModal";
import { Header } from "./components/Header";
import { MessageList } from "./components/MessageList";
import { SourcesPanel } from "./components/SourcesPanel";
import { useChat } from "./hooks/useChat";
import { useHealth } from "./hooks/useHealth";
import { useIngest } from "./hooks/useIngest";

export default function App() {
  const online = useHealth();
  const { messages, sources, thinking, streaming, banner, send, stop } = useChat();
  const ingest = useIngest();
  const [corpusOpen, setCorpusOpen] = useState(false);

  const ingestPercent =
    ingest.progress !== null && ingest.progress.total > 0
      ? Math.round((100 * ingest.progress.done) / ingest.progress.total)
      : null;
  const corpusEmpty = ingest.status !== null && ingest.status.chunksEmbedded === 0;
  const last = messages.at(-1);
  const latestCitations = last !== undefined && last.role === "assistant" ? last.citations : [];

  const [selectedIndex, setSelectedIndex] = useState<number | null>(null);
  const selected = selectedIndex !== null ? messages[selectedIndex] : undefined;
  const panelSources = selected !== undefined ? (selected.sources ?? []) : sources;
  const panelCitations = selected !== undefined ? selected.citations : latestCitations;
  const answerOrdinal =
    selectedIndex !== null
      ? messages.slice(0, selectedIndex + 1).filter((m) => m.role === "assistant").length
      : 0;
  const subtitle = selectedIndex !== null ? `answer ${answerOrdinal}` : "latest answer";

  return (
    <div className="flex h-screen flex-col bg-background text-foreground">
      <Header
        online={online}
        ingestPercent={ingestPercent}
        onOpenCorpus={() => setCorpusOpen(true)}
      />
      {banner !== null && (
        <div role="alert" className="bg-danger-50 px-4 py-2 text-sm text-danger">
          {banner}
        </div>
      )}
      {corpusEmpty && !ingest.running && (
        <div className="bg-warning-50 px-4 py-2 text-sm text-warning-700">
          Corpus not embedded — open the Corpus panel.
        </div>
      )}
      <main className="grid min-h-0 flex-1 grid-cols-1 grid-rows-[1fr_auto] lg:grid-cols-[1fr_20rem] lg:grid-rows-1">
        <section className="flex min-h-0 flex-col">
          <MessageList
            messages={messages}
            streaming={streaming}
            searching={sources.length === 0}
            thinking={thinking}
            selectedIndex={selectedIndex}
            onSelect={(i) => setSelectedIndex((prev) => (prev === i ? null : i))}
          />
          <Composer
            disabled={streaming || !online}
            offline={!online}
            streaming={streaming}
            onSend={(question) => {
              setSelectedIndex(null);
              void send(question);
            }}
            onStop={stop}
          />
        </section>
        <SourcesPanel
          sources={panelSources}
          streaming={streaming && selectedIndex === null}
          citations={panelCitations}
          subtitle={subtitle}
        />
      </main>
      <CorpusModal
        isOpen={corpusOpen}
        onClose={() => setCorpusOpen(false)}
        status={ingest.status}
        progress={ingest.progress}
        running={ingest.running}
        error={ingest.error}
        onStart={() => void ingest.start()}
      />
    </div>
  );
}
