import { Kysely, sql } from "kysely";

export async function up(db: Kysely<any>): Promise<void> {
  // A challenge that lapsed with no resolution is recorded as 'expired', the
  // outcome EscrowGate now writes on the challenge record and announces with
  // ChallengeExpired. Until now such a row was closed with a time and no
  // resolution, which the check only allowed because null passes it.
  await sql`alter table challenge drop constraint if exists challenge_resolution_check`.execute(db);
  await sql`alter table challenge add constraint challenge_resolution_check check (resolution in ('upheld','rejected','expired'))`.execute(db);

  // Rows closed that way before this migration get the outcome too. A
  // challenged submission only ends expired_unverified when its challenge
  // expired, so the submission's status identifies them.
  await sql`
    update challenge
    set resolution = 'expired'
    from submission
    where submission.id = challenge.submission_id
      and submission.status = 'expired_unverified'
      and challenge.resolution is null
      and challenge.resolved_at is not null
  `.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`update challenge set resolution = null where resolution = 'expired'`.execute(db);
  await sql`alter table challenge drop constraint if exists challenge_resolution_check`.execute(db);
  await sql`alter table challenge add constraint challenge_resolution_check check (resolution in ('upheld','rejected'))`.execute(db);
}
