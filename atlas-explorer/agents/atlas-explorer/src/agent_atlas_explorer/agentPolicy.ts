/** Magenta sanitizes MCP hyphens to underscores and prefixes the server name. */
export const MUTATIVE_MCP_INTERRUPT_ON: Readonly<Record<string, true>> = {
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
};

export function selectAtlasTools<T extends { name: string }>(
  tools: readonly T[],
): T[] {
  return tools.filter((tool) => {
    const separator = tool.name.lastIndexOf("__");
    const bareName =
      separator >= 0 ? tool.name.slice(separator + 2) : tool.name;
    return (
      !bareName.startsWith("atlas_local_") && bareName !== "shell_execute"
    );
  });
}
