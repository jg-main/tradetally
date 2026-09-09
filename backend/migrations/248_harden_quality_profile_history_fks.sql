-- History-safe deletion semantics for Quality Profile tables.
--
-- Quality profile versions and trade-quality evaluations are immutable
-- historical snapshots (docs/QUALITY_PROFILES_REQUIREMENT.md sections 4 and
-- 6). Deleting a Quality Profile must never cascade through its versions into
-- historical evaluations, so this migration makes both links RESTRICT:
-- profiles that still have versions (or versions that still have evaluations)
-- cannot be deleted accidentally. The supported lifecycle for retiring a
-- profile is archiving via is_active, not physical deletion.
--
-- Account deletion remains functional: User.deleteUser explicitly removes the
-- quality tables in dependency order (evaluations, then profile versions,
-- then profiles) before deleting the user row.

-- quality_profile_versions.profile_id -> quality_profiles(id) ON DELETE RESTRICT
DO $quality_history_fk$
BEGIN
    IF EXISTS (
        SELECT 1
        FROM pg_constraint c
        JOIN pg_class t ON t.oid = c.conrelid
        JOIN pg_namespace n ON n.oid = t.relnamespace
        WHERE c.conname = 'quality_profile_versions_profile_id_fkey'
          AND t.relname = 'quality_profile_versions'
          AND n.nspname = current_schema()
          AND c.confdeltype = 'c'
    ) THEN
        ALTER TABLE quality_profile_versions
            DROP CONSTRAINT quality_profile_versions_profile_id_fkey;
    END IF;

    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint c
        JOIN pg_class t ON t.oid = c.conrelid
        JOIN pg_namespace n ON n.oid = t.relnamespace
        WHERE c.conname = 'quality_profile_versions_profile_id_fkey'
          AND t.relname = 'quality_profile_versions'
          AND n.nspname = current_schema()
    ) THEN
        ALTER TABLE quality_profile_versions
            ADD CONSTRAINT quality_profile_versions_profile_id_fkey
            FOREIGN KEY (profile_id)
            REFERENCES quality_profiles(id)
            ON DELETE RESTRICT;
    END IF;
END
$quality_history_fk$;

-- trade_quality_evaluations.profile_version_id -> quality_profile_versions(id)
-- ON DELETE RESTRICT
DO $quality_history_fk$
BEGIN
    IF EXISTS (
        SELECT 1
        FROM pg_constraint c
        JOIN pg_class t ON t.oid = c.conrelid
        JOIN pg_namespace n ON n.oid = t.relnamespace
        WHERE c.conname = 'trade_quality_evaluations_profile_version_id_fkey'
          AND t.relname = 'trade_quality_evaluations'
          AND n.nspname = current_schema()
          AND c.confdeltype = 'c'
    ) THEN
        ALTER TABLE trade_quality_evaluations
            DROP CONSTRAINT trade_quality_evaluations_profile_version_id_fkey;
    END IF;

    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint c
        JOIN pg_class t ON t.oid = c.conrelid
        JOIN pg_namespace n ON n.oid = t.relnamespace
        WHERE c.conname = 'trade_quality_evaluations_profile_version_id_fkey'
          AND t.relname = 'trade_quality_evaluations'
          AND n.nspname = current_schema()
    ) THEN
        ALTER TABLE trade_quality_evaluations
            ADD CONSTRAINT trade_quality_evaluations_profile_version_id_fkey
            FOREIGN KEY (profile_version_id)
            REFERENCES quality_profile_versions(id)
            ON DELETE RESTRICT;
    END IF;
END
$quality_history_fk$;

COMMENT ON CONSTRAINT quality_profile_versions_profile_id_fkey
    ON quality_profile_versions
    IS 'Profiles with versions cannot be deleted; archive with is_active instead. Deleting a user account explicitly removes quality rows first.';
COMMENT ON CONSTRAINT trade_quality_evaluations_profile_version_id_fkey
    ON trade_quality_evaluations
    IS 'Versions with historical evaluations cannot be deleted; completed evaluations are immutable snapshots.';
