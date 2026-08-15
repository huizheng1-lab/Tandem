import React from "react";
import { Box, Text } from "ink";

export type TranscriptRole = "USER" | "LEADER" | "WORKER" | "SYSTEM";
export type TaskOutcomeStatus = "successful" | "failed" | "hung";
export interface TranscriptMessage {
  role: TranscriptRole;
  text: string;
  thinking?: boolean;
  interactive?: boolean;
  artifactDetails?: string;
  artifactExpanded?: boolean;
}

const colors: Record<TranscriptRole, string> = {
  USER: "white",
  LEADER: "cyan",
  WORKER: "green",
  SYSTEM: "gray"
};

export function visibleTranscriptMessages(messages: TranscriptMessage[]): TranscriptMessage[] {
  return messages.filter((message) => message.role !== "SYSTEM" || message.interactive || message.artifactDetails);
}

export function Transcript({ messages, taskStatus }: { messages: TranscriptMessage[]; taskStatus: TaskOutcomeStatus }) {
  return (
    <Box flexDirection="column" flexGrow={1}>
      <Text color={taskStatus === "successful" ? "green" : taskStatus === "failed" ? "red" : "yellow"}>Task status: {taskStatus}</Text>
      {visibleTranscriptMessages(messages).slice(-30).map((message, index) => (
        <Box key={`${index}-${message.role}`} marginBottom={0} flexDirection="column">
          <Box>
            <Text color={colors[message.role]} bold>
              {message.role.padEnd(7)}
            </Text>
            <Text> {message.text}</Text>
          </Box>
          {message.artifactDetails && message.artifactExpanded ? (
            <Box paddingLeft={8}>
              <Text color="gray">{message.artifactDetails}</Text>
            </Box>
          ) : null}
        </Box>
      ))}
    </Box>
  );
}
