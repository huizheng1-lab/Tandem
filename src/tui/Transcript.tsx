import React from "react";
import { Box, Text } from "ink";

export type TranscriptRole = "USER" | "LEADER" | "WORKER" | "SYSTEM";
export interface TranscriptMessage {
  role: TranscriptRole;
  text: string;
}

const colors: Record<TranscriptRole, string> = {
  USER: "white",
  LEADER: "cyan",
  WORKER: "green",
  SYSTEM: "gray"
};

export function Transcript({ messages }: { messages: TranscriptMessage[] }) {
  return (
    <Box flexDirection="column" flexGrow={1}>
      {messages.slice(-30).map((message, index) => (
        <Box key={`${index}-${message.role}`} marginBottom={0}>
          <Text color={colors[message.role]} bold>
            {message.role.padEnd(7)}
          </Text>
          <Text> {message.text}</Text>
        </Box>
      ))}
    </Box>
  );
}
