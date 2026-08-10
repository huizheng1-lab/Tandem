import { z } from "zod";

export const DerivedArtifactEntrySchema = z.object({
  status: z.enum(["measured", "interpolated", "absent"]),
  // Every projected entry must disclose how closely it is supported by the
  // measurement.  A measured entry normally has distance 0; requiring the
  // field prevents a producer from omitting the evidence declaration while
  // still allowing interpolation at any explicitly reported distance.
  distanceFromNearestMeasuredBoundary: z.number().finite().min(0)
});

export const DerivedArtifactProvenanceSchema = z
  .object({
    artifactId: z.string().min(1),
    sourceDuration: z.number().finite().positive(),
    measuredDuration: z.number().finite().min(0),
    measuredFraction: z.number().finite().min(0).max(1),
    measuredSpanEnd: z.number().finite().min(0),
    artifactSpanEnd: z.number().finite().min(0),
    entries: z.array(DerivedArtifactEntrySchema),
    shortfall: z.string().trim().min(1).optional()
  })
  .superRefine((value, ctx) => {
    if (value.measuredDuration > value.sourceDuration) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["measuredDuration"], message: "cannot exceed sourceDuration" });
    }
    if (Math.abs(value.measuredFraction - value.measuredDuration / value.sourceDuration) > 0.001) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["measuredFraction"], message: "must equal measuredDuration/sourceDuration" });
    }
    if (value.measuredSpanEnd > value.sourceDuration || value.artifactSpanEnd > value.sourceDuration) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["*"], message: "span ends cannot exceed sourceDuration" });
    }
    if ((value.measuredDuration < value.sourceDuration || value.artifactSpanEnd > value.measuredSpanEnd) && !value.shortfall) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["shortfall"], message: "must declare uncovered or interpolated source extent" });
    }
    for (const [index, entry] of value.entries.entries()) {
      if (entry.status === "measured" && entry.distanceFromNearestMeasuredBoundary > 0.001) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["entries", index, "distanceFromNearestMeasuredBoundary"], message: "measured entries must be on a measured boundary" });
      }
    }
  });

export type DerivedArtifactProvenance = z.infer<typeof DerivedArtifactProvenanceSchema>;

export const ProvenanceAssertionSchema = z.object({
  artifactId: z.string().min(1),
  minMeasuredCoverageFraction: z.number().finite().min(0).max(1).optional(),
  maxInterpolatedEntryFraction: z.number().finite().min(0).max(1).optional(),
  maxArtifactExtensionSeconds: z.number().finite().min(0).optional()
});
export type ProvenanceAssertion = z.infer<typeof ProvenanceAssertionSchema>;

export function validateDerivedArtifactProvenance(
  provenance: DerivedArtifactProvenance,
  assertion?: ProvenanceAssertion
): string[] {
  const errors: string[] = [];
  const extension = Math.max(0, provenance.artifactSpanEnd - provenance.measuredSpanEnd);
  const interpolatedFraction = provenance.entries.length === 0
    ? 0
    : provenance.entries.filter((entry) => entry.status === "interpolated").length / provenance.entries.length;
  if (assertion?.minMeasuredCoverageFraction !== undefined && provenance.measuredFraction < assertion.minMeasuredCoverageFraction) {
    errors.push(`derived artifact "${provenance.artifactId}" measured coverage ${(provenance.measuredFraction * 100).toFixed(1)}% is below ${(assertion.minMeasuredCoverageFraction * 100).toFixed(1)}%`);
  }
  if (assertion?.maxInterpolatedEntryFraction !== undefined && interpolatedFraction > assertion.maxInterpolatedEntryFraction) {
    errors.push(`derived artifact "${provenance.artifactId}" interpolation ${(interpolatedFraction * 100).toFixed(1)}% exceeds ${(assertion.maxInterpolatedEntryFraction * 100).toFixed(1)}%`);
  }
  if (assertion?.maxArtifactExtensionSeconds !== undefined && extension > assertion.maxArtifactExtensionSeconds) {
    errors.push(`derived artifact "${provenance.artifactId}" extends ${extension.toFixed(3)}s beyond measured evidence`);
  }
  return errors;
}

export function provenanceShortfall(provenance: DerivedArtifactProvenance): string {
  const uncovered = Math.max(0, provenance.sourceDuration - provenance.measuredDuration);
  const computed = `measured evidence covers ${(provenance.measuredFraction * 100).toFixed(1)}% of the ${provenance.sourceDuration.toFixed(3)}s source; ${uncovered.toFixed(3)}s remains absent or interpolated`;
  if (!provenance.shortfall || provenance.shortfall === computed) return computed;
  return `${provenance.shortfall} (computed: ${computed})`;
}
