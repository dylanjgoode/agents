/**
 * Magenta sanitizes MCP hyphens to underscores and prefixes the server name.
 *
 * This explicit allowlist is a shipping bridge until Magenta preserves MCP
 * tool annotations on `app.getTools()`. See
 * docs/bug-reports/magenta-drops-mcp-tool-annotations.md.
 *
 * Names follow Atlas Managed MCP `read`, `metadata`, and `connect` tools.
 * `aggregate`, `aggregate-db`, and `export` stay here because MongoDB labels
 * them read-only; `$out`/`$merge` is blocked by a read-only Atlas credential.
 */
export const READ_ONLY_MCP_TOOLS: ReadonlySet<string> = new Set([
  "mongodb__aggregate",
  "mongodb__aggregate_db",
  "mongodb__atlas_connect_cluster",
  "mongodb__atlas_get_performance_advisor",
  "mongodb__atlas_get_regions",
  "mongodb__atlas_inspect_access_list",
  "mongodb__atlas_inspect_cluster",
  "mongodb__atlas_list_alerts",
  "mongodb__atlas_list_clusters",
  "mongodb__atlas_list_db_users",
  "mongodb__atlas_list_orgs",
  "mongodb__atlas_list_projects",
  "mongodb__atlas_streams_discover",
  "mongodb__collection_indexes",
  "mongodb__collection_schema",
  "mongodb__collection_storage_size",
  "mongodb__connect",
  "mongodb__count",
  "mongodb__db_stats",
  "mongodb__explain",
  "mongodb__export",
  "mongodb__find",
  "mongodb__list_collections",
  "mongodb__list_databases",
  "mongodb__list_knowledge_sources",
  "mongodb__mongodb_logs",
  "mongodb__remote_atlas_connect",
  "mongodb__search_knowledge",
  "mongodb__switch_connection",
]);

export function writeOperationsAllowed(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const value = env.ALLOW_WRITE_OPERATIONS;
  return value !== undefined && value.trim() !== "";
}

export function isShellExecuteTool(name: string): boolean {
  const separator = name.lastIndexOf("__");
  const bareName = separator >= 0 ? name.slice(separator + 2) : name;
  return bareName === "shell_execute";
}

export function selectAtlasTools<T extends { name: string }>(
  tools: readonly T[],
  allowWriteOperations: boolean = writeOperationsAllowed(),
): T[] {
  return tools.filter((tool) => {
    if (isShellExecuteTool(tool.name)) return false;
    if (READ_ONLY_MCP_TOOLS.has(tool.name)) return true;
    return allowWriteOperations;
  });
}

export function mutativeInterruptOn<T extends { name: string }>(
  tools: readonly T[],
): Record<string, true> {
  const interruptOn: Record<string, true> = {};
  for (const tool of tools) {
    if (READ_ONLY_MCP_TOOLS.has(tool.name) || isShellExecuteTool(tool.name)) {
      continue;
    }
    interruptOn[tool.name] = true;
  }
  return interruptOn;
}
