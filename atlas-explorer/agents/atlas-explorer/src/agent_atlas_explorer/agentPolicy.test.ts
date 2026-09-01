import { describe, expect, it } from "vitest";

import {
  MUTATIVE_MCP_INTERRUPT_ON,
  selectAtlasTools,
} from "./agentPolicy.js";

describe("Atlas tool policy", () => {
  it("requires human approval for every persistent MongoDB and Atlas mutation", () => {
    expect(MUTATIVE_MCP_INTERRUPT_ON).toEqual({
      mongodb__drop_database: true,
      mongodb__drop_collection: true,
      mongodb__drop_index: true,
      mongodb__insert_many: true,
      mongodb__create_index: true,
      mongodb__update_one: true,
      mongodb__delete_many: true,
      mongodb__update_many: true,
      mongodb__rename_collection: true,
      mongodb__create_collection: true,
      mongodb__atlas_create_free_cluster: true,
      mongodb__atlas_create_cluster: true,
      mongodb__atlas_load_sample_dataset: true,
      mongodb__atlas_create_access_list: true,
      mongodb__atlas_create_db_user: true,
      mongodb__atlas_create_project: true,
      mongodb__atlas_upgrade_cluster: true,
      mongodb__atlas_pause_resume_cluster: true,
      mongodb__atlas_streams_build: true,
      mongodb__atlas_streams_manage: true,
      mongodb__atlas_streams_teardown: true,
    });
  });

  it("hides Atlas-local tools that cannot run through Managed MCP", () => {
    const tools = [
      { name: "mongodb__find" },
      { name: "mongodb__atlas_local_connect" },
      { name: "shell_execute" },
      { name: "custom_read_only_tool" },
    ];

    expect(selectAtlasTools(tools)).toEqual([
      { name: "mongodb__find" },
      { name: "custom_read_only_tool" },
    ]);
  });
});
