import React from "react";
import { Box, Text } from "ink";
import { BuildPlan, ReviewVerdict } from "../orchestrator/artifacts.js";

export function PlanView({ plan, verdict }: { plan?: BuildPlan; verdict?: ReviewVerdict }) {
  if (!plan && !verdict) return null;
  return (
    <Box borderStyle="single" paddingX={1} flexDirection="column">
      {plan ? (
        <>
          <Text color="cyan" bold>{plan.title}</Text>
          <Text>{plan.tasks.length} tasks | {plan.acceptanceCriteria.length} criteria | {plan.verification.length} checks</Text>
        </>
      ) : null}
      {verdict ? <Text color={verdict.verdict === "approve" ? "green" : "yellow"}>review: {verdict.verdict}</Text> : null}
    </Box>
  );
}
