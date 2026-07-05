import React from "react";
import { Box, Text } from "ink";

export function Approval({ action, target }: { action?: string; target?: string }) {
  if (!action) return null;
  return (
    <Box borderStyle="round" paddingX={1}>
      <Text color="yellow">Approve {action}: {target}? y/n</Text>
    </Box>
  );
}
