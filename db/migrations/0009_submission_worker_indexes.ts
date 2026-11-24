import { Kysely, sql } from "kysely";

export async function up(db: Kysely<any>): Promise<void> {
  await sql`
    create index submission_draft_tx_idx
      on submission (chain_tx_hash)
      where chain_submission_id is null;
  `.execute(db);

  await sql`
    create index submission_unsettled_idx
      on submission (status)
      where settled_at is null and chain_submission_id is not null;
  `.execute(db);

  await sql`
    create index submission_draft_updated_idx
      on submission (updated_at)
      where chain_submission_id is null;
  `.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropIndex("submission_draft_updated_idx").ifExists().execute();
  await db.schema.dropIndex("submission_unsettled_idx").ifExists().execute();
  await db.schema.dropIndex("submission_draft_tx_idx").ifExists().execute();
}
