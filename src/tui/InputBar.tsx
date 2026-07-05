import React from "react";
import { Box, Text } from "ink";
import TextInput from "ink-text-input";

export function InputBar({ value, onChange, onSubmit }: { value: string; onChange: (value: string) => void; onSubmit: (value: string) => void }) {
  return (
    <Box borderStyle="single" paddingX={1}>
      <Text color="cyan">{value.startsWith("/") ? "/" : ">"} </Text>
      <TextInput value={value.startsWith("/") ? value.slice(1) : value} onChange={(next) => onChange(value.startsWith("/") ? `/${next}` : next)} onSubmit={() => onSubmit(value)} />
    </Box>
  );
}
