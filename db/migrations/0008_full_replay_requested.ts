import { Kysely, sql } from "kysely";

export async function up(db: Kysely<any>): Promise<void> {
  await db.schema.alterTable("submission").addColumn("full_replay_requested_at", "timestamptz").execute();

  // Backfill: set the column for retrieval submissions that already have a
  // spot_check row with result = 'mismatch' or a challenge row, so in-flight
  // escalations keep their quorum.
  await sql`
    update submission
    set full_replay_requested_at = coalesce(
      (select min(sc.sampled_at) from spot_check sc where sc.submission_id = submission.id and sc.result = 'mismatch'),
      (select min(c.opened_at) from challenge c where c.submission_id = submission.id),
      now()
    )
    where task_type = 'retrieval'
      and (
        exists (select 1 from spot_check sc where sc.submission_id = submission.id and sc.result = 'mismatch')
        or exists (select 1 from challenge c where c.submission_id = submission.id)
      )
  `.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.alterTable("submission").dropColumn("full_replay_requested_at").execute();
}
