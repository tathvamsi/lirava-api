/**
 * The assistant used to be called a "dot" (and, for a while, an "agent") in the database. This renames the
 * stored columns, table, index and message role to "vakil". It runs before any table is created, only does
 * anything when the old names are found, and is safe to run any number of times.
 */
export async function migrateVakilNaming(sql) {
    const tableExists = async (table) => (await sql `SELECT 1 FROM information_schema.tables WHERE table_schema = current_schema() AND table_name = ${table}`).length > 0;
    const columnExists = async (table, column) => (await sql `SELECT 1 FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = ${table} AND column_name = ${column}`).length > 0;
    if (await tableExists("app_agents")) {
        if (!(await tableExists("app_vakils"))) {
            await sql.unsafe("ALTER TABLE app_agents RENAME TO app_vakils");
        }
        else if (await columnExists("app_vakils", "id")) {
            // Both exist: an older server that was still running re-created the old table. Keep any rows that only
            // it holds (copying never overwrites), then remove it.
            await sql.unsafe(`INSERT INTO app_vakils (id, user_id, name, purpose, instructions, look, status, local_access, model, created_at)
        SELECT id, user_id, name, purpose, instructions, look, status, local_access, model, created_at FROM app_agents WHERE user_id <> ''
        ON CONFLICT (id) DO NOTHING`);
            await sql.unsafe("DROP TABLE app_agents");
        }
    }
    await sql.unsafe("ALTER INDEX IF EXISTS app_agents_user_idx RENAME TO app_vakils_user_idx");
    for (const table of ["chat_conversations", "chat_messages", "app_artifacts", "app_files"]) {
        if ((await tableExists(table)) && (await columnExists(table, "dot_id")) && !(await columnExists(table, "vakil_id"))) {
            await sql.unsafe(`ALTER TABLE ${table} RENAME COLUMN dot_id TO vakil_id`);
        }
    }
    await sql.unsafe("ALTER INDEX IF EXISTS chat_conversations_user_dot_idx RENAME TO chat_conversations_user_vakil_idx");
    if (await tableExists("chat_messages")) {
        await sql `UPDATE chat_messages SET role = 'vakil' WHERE role = 'dot'`;
    }
}
