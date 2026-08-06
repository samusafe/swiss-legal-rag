import { Composer } from "./components/Composer";
import { Header } from "./components/Header";
import { MessageList } from "./components/MessageList";
import { SourcesPanel } from "./components/SourcesPanel";
import { useChat } from "./hooks/useChat";
import { useHealth } from "./hooks/useHealth";

export default function App() {
  const online = useHealth();
  const { messages, sources, lang, setLang, streaming, banner, send } = useChat();

  return (
    <div className="flex h-screen flex-col bg-background text-foreground">
      <Header online={online} lang={lang} onLangChange={setLang} />
      {banner !== null && (
        <div role="alert" className="bg-danger-50 px-4 py-2 text-sm text-danger">
          {banner}
        </div>
      )}
      <main className="grid min-h-0 flex-1 grid-cols-[1fr_20rem]">
        <section className="flex min-h-0 flex-col">
          <MessageList messages={messages} />
          <Composer
            disabled={streaming || !online}
            offline={!online}
            onSend={(question) => void send(question)}
          />
        </section>
        <SourcesPanel sources={sources} />
      </main>
    </div>
  );
}
