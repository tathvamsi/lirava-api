/** Accept both API names during migration without silently choosing conflicting IDs. */
export function resolveAgentId(agentId: unknown, dotId: unknown): string | null {
  if (agentId !== undefined && (typeof agentId !== "string" || !agentId.trim())) return null;
  if (dotId !== undefined && (typeof dotId !== "string" || !dotId.trim())) return null;
  if (typeof agentId === "string" && typeof dotId === "string" && agentId !== dotId) return null;
  return typeof agentId === "string" ? agentId : typeof dotId === "string" ? dotId : null;
}
