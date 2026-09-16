import { describe, expect, it } from "vitest";

import {
  READ_ONLY_MCP_TOOLS,
  isShellExecuteTool,
  mutativeInterruptOn,
  selectAtlasTools,
  writeOperationsAllowed,
} from "./agentPolicy.js";

const discoveredCatalog = [
  { name: "mongodb__find" },
  { name: "mongodb__aggregate" },
  { name: "mongodb__aggregate_db" },
  { name: "mongodb__export" },
  { name: "mongodb__drop_collection" },
  { name: "mongodb__insert_many" },
  { name: "mongodb__atlas_create_cluster" },
  { name: "mongodb__future_mutating_operation" },
  { name: "mongodb__atlas_local_connect_deployment" },
  { name: "shell_execute" },
  { name: "custom_unclassified_tool" },
] as const;

describe("writeOperationsAllowed", () => {
  it("treats unset and empty values as disabled", () => {
    expect(writeOperationsAllowed({})).toBe(false);
    expect(writeOperationsAllowed({ ALLOW_WRITE_OPERATIONS: "" })).toBe(false);
    expect(writeOperationsAllowed({ ALLOW_WRITE_OPERATIONS: "   " })).toBe(
      false,
    );
  });

  it("treats any non-empty value as enabled", () => {
    expect(writeOperationsAllowed({ ALLOW_WRITE_OPERATIONS: "1" })).toBe(true);
    expect(writeOperationsAllowed({ ALLOW_WRITE_OPERATIONS: "false" })).toBe(
      true,
    );
  });
});

describe("Atlas tool policy", () => {
  it("allowlists current Managed MCP read, metadata, and connect tools", () => {
    expect([...READ_ONLY_MCP_TOOLS].sort()).toEqual([
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
  });

  it("independently excludes shell execution tools", () => {
    expect(isShellExecuteTool("shell_execute")).toBe(true);
    expect(isShellExecuteTool("backend__shell_execute")).toBe(true);
    expect(isShellExecuteTool("mongodb__find")).toBe(false);
  });

  it("hides write and unknown tools when writes are disabled", () => {
    expect(selectAtlasTools(discoveredCatalog, false)).toEqual([
      { name: "mongodb__find" },
      { name: "mongodb__aggregate" },
      { name: "mongodb__aggregate_db" },
      { name: "mongodb__export" },
    ]);
  });

  it("exposes non-read MCP tools for HITL when writes are enabled", () => {
    const selected = selectAtlasTools(discoveredCatalog, true);

    expect(selected).toEqual([
      { name: "mongodb__find" },
      { name: "mongodb__aggregate" },
      { name: "mongodb__aggregate_db" },
      { name: "mongodb__export" },
      { name: "mongodb__drop_collection" },
      { name: "mongodb__insert_many" },
      { name: "mongodb__atlas_create_cluster" },
      { name: "mongodb__future_mutating_operation" },
      { name: "mongodb__atlas_local_connect_deployment" },
      { name: "custom_unclassified_tool" },
    ]);
    expect(mutativeInterruptOn(selected)).toEqual({
      mongodb__drop_collection: true,
      mongodb__insert_many: true,
      mongodb__atlas_create_cluster: true,
      mongodb__future_mutating_operation: true,
      mongodb__atlas_local_connect_deployment: true,
      custom_unclassified_tool: true,
    });
  });
});
