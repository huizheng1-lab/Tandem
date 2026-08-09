/**
 * @deprecated Bespoke installation was removed. Agents install through the
 * ordinary shell tool so permission and self-modification protections apply.
 */
export function installMissingTool(): never {
  throw new Error("Bespoke tool installation was removed; run the install command through the shell tool.");
}
