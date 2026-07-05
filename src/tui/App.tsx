import React, { useMemo, useState } from "react";
import { Box, Text, useApp, useInput } from "ink";
import Spinner from "ink-spinner";
import { TandemConfig } from "../config/schema.js";
import { CostLedger } from "../session/cost.js";
import { dispatchCommand } from "../commands/index.js";
import { Transcript, TranscriptMessage } from "./Transcript.js";
import { InputBar } from "./InputBar.js";
import { StatusLine } from "./StatusLine.js";

export function App({ config: initialConfig, env, cwd, initialError }: { config: TandemConfig; env: NodeJS.ProcessEnv; cwd: string; initialError?: string }) {
  const [config, setConfig] = useState(initialConfig);
  const [messages, setMessages] = useState<TranscriptMessage[]>([
    { role: "SYSTEM", text: initialError ?? "Tandem ready. Run /help or ask for a build." }
  ]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const ledger = useMemo(() => new CostLedger(), []);
  const app = useApp();

  useInput((inputValue, key) => {
    if (key.escape) {
      setBusy(false);
      setMessages((current) => [...current, { role: "SYSTEM", text: "Interrupted current turn." }]);
    }
    if (key.ctrl && inputValue === "c") app.exit();
  });

  const submit = async (value: string) => {
    if (!value.trim()) return;
    setInput("");
    setMessages((current) => [...current, { role: "USER", text: value }]);
    setBusy(true);
    try {
      const commandResult = await dispatchCommand(value, { config, env, cwd, ledger, setConfig });
      if (commandResult !== undefined) {
        setMessages((current) => [...current, { role: "SYSTEM", text: commandResult }]);
      } else {
        setMessages((current) => [
          ...current,
          { role: "LEADER", text: "Planning/build orchestration is available through the core machine; wire provider keys and run a real model turn to execute it." }
        ]);
      }
    } catch (error) {
      setMessages((current) => [...current, { role: "SYSTEM", text: String(error) }]);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Box flexDirection="column">
      <Transcript messages={messages} />
      {busy ? <Text color="cyan"><Spinner type="dots" /> working</Text> : null}
      <StatusLine leader={config.leader} worker={config.worker} phase={busy ? "PLANNING" : "IDLE"} round={0} maxRounds={config.maxReviewRounds} cost={ledger.totalDollars()} />
      <InputBar value={input} onChange={setInput} onSubmit={submit} />
    </Box>
  );
}
