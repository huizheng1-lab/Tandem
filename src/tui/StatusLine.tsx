import React from "react";
import { Box, Text } from "ink";

export function StatusLine({ leader, worker, phase, round, maxRounds, cost }: { leader: string; worker: string; phase: string; round: number; maxRounds: number; cost: number }) {
  return (
    <Box>
      <Text color="gray">
        leader: {leader} | worker: {worker} | phase: {phase} | round {round}/{maxRounds} | ${cost.toFixed(4)}
      </Text>
    </Box>
  );
}
