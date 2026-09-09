-- Quality Profiles foundation (Phase 1 of docs/QUALITY_PROFILES_REQUIREMENT.md).
--
-- Adds the versioned, per-user Quality Profile system:
--   quality_profiles            - profile definition row (spec 5.1)
--   quality_profile_versions    - immutable configuration snapshots (spec 5.2)
--   trade_quality_evaluations   - per-trade evaluations linked to one version (spec 5.3)
--
-- This migration is purely additive. It does not alter legacy
-- quality_grade / quality_score / quality_metrics columns or any existing
-- table, and it does not seed or backfill profiles for existing users
-- (existing users without setup-specific profiles continue to function).

-- ---------------------------------------------------------------------------
-- quality_profiles
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS quality_profiles (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name VARCHAR(120) NOT NULL CHECK (length(btrim(name)) > 0),
    description TEXT,
    playbook_id UUID REFERENCES playbooks(id) ON DELETE SET NULL,
    instrument_type VARCHAR(50),
    is_active BOOLEAN NOT NULL DEFAULT true,
    current_version_id UUID,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_quality_profiles_user_id ON quality_profiles(user_id);
CREATE INDEX IF NOT EXISTS idx_quality_profiles_user_active ON quality_profiles(user_id, is_active);
CREATE INDEX IF NOT EXISTS idx_quality_profiles_playbook_id ON quality_profiles(playbook_id);

-- ---------------------------------------------------------------------------
-- quality_profile_versions (immutable snapshots)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS quality_profile_versions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    profile_id UUID NOT NULL REFERENCES quality_profiles(id) ON DELETE CASCADE,
    version_number INTEGER NOT NULL CHECK (version_number > 0),
    schema_version INTEGER NOT NULL DEFAULT 1 CHECK (schema_version > 0),
    configuration JSONB NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT quality_profile_versions_profile_version_key
        UNIQUE (profile_id, version_number)
);

CREATE INDEX IF NOT EXISTS idx_quality_profile_versions_profile_id
    ON quality_profile_versions(profile_id);

-- Profile -> current version pointer. Added after both tables exist to avoid
-- ordering issues; guarded so re-runs are idempotent.
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'quality_profiles_current_version_id_fkey'
    ) THEN
        ALTER TABLE quality_profiles
            ADD CONSTRAINT quality_profiles_current_version_id_fkey
            FOREIGN KEY (current_version_id)
            REFERENCES quality_profile_versions(id)
            ON DELETE SET NULL;
    END IF;
END $$;

-- Profile versions are immutable snapshots. Editing a profile must create a
-- new version (spec section 4), so direct UPDATEs are rejected at the DB
-- layer. DELETEs remain allowed so that deleting a profile cascades to its
-- versions.
CREATE OR REPLACE FUNCTION forbid_quality_profile_version_update()
RETURNS TRIGGER AS $$
BEGIN
    RAISE EXCEPTION 'quality_profile_versions rows are immutable snapshots; create a new version instead';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS quality_profile_versions_no_update ON quality_profile_versions;
CREATE TRIGGER quality_profile_versions_no_update
    BEFORE UPDATE ON quality_profile_versions
    FOR EACH ROW
    EXECUTE FUNCTION forbid_quality_profile_version_update();

-- ---------------------------------------------------------------------------
-- trade_quality_evaluations
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS trade_quality_evaluations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    trade_id UUID NOT NULL REFERENCES trades(id) ON DELETE CASCADE,
    profile_version_id UUID NOT NULL REFERENCES quality_profile_versions(id) ON DELETE CASCADE,
    status VARCHAR(20) NOT NULL DEFAULT 'draft'
        CHECK (status IN ('draft', 'needs_input', 'completed', 'insufficient_data', 'error')),

    setup_score NUMERIC(5,2) CHECK (setup_score IS NULL OR setup_score BETWEEN 0 AND 100),
    setup_grade VARCHAR(1) CHECK (setup_grade IS NULL OR setup_grade IN ('A', 'B', 'C', 'D', 'F')),
    setup_compliance VARCHAR(10)
        CHECK (setup_compliance IS NULL OR setup_compliance IN ('PASS', 'FAIL', 'INCOMPLETE')),
    setup_coverage NUMERIC(5,2) CHECK (setup_coverage IS NULL OR setup_coverage BETWEEN 0 AND 100),

    entry_score NUMERIC(5,2) CHECK (entry_score IS NULL OR entry_score BETWEEN 0 AND 100),
    entry_grade VARCHAR(1) CHECK (entry_grade IS NULL OR entry_grade IN ('A', 'B', 'C', 'D', 'F')),
    entry_compliance VARCHAR(10)
        CHECK (entry_compliance IS NULL OR entry_compliance IN ('PASS', 'FAIL', 'INCOMPLETE')),
    entry_coverage NUMERIC(5,2) CHECK (entry_coverage IS NULL OR entry_coverage BETWEEN 0 AND 100),

    management_score NUMERIC(5,2) CHECK (management_score IS NULL OR management_score BETWEEN 0 AND 100),
    management_grade VARCHAR(1)
        CHECK (management_grade IS NULL OR management_grade IN ('A', 'B', 'C', 'D', 'F')),
    management_compliance VARCHAR(10)
        CHECK (management_compliance IS NULL OR management_compliance IN ('PASS', 'FAIL', 'INCOMPLETE')),
    management_coverage NUMERIC(5,2)
        CHECK (management_coverage IS NULL OR management_coverage BETWEEN 0 AND 100),

    user_inputs JSONB,
    detected_context JSONB,
    evidence_snapshot JSONB,
    results JSONB,

    evaluated_at TIMESTAMP WITH TIME ZONE,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_trade_quality_evaluations_user_id ON trade_quality_evaluations(user_id);
CREATE INDEX IF NOT EXISTS idx_trade_quality_evaluations_trade_id ON trade_quality_evaluations(trade_id);
CREATE INDEX IF NOT EXISTS idx_trade_quality_evaluations_user_trade
    ON trade_quality_evaluations(user_id, trade_id);
CREATE INDEX IF NOT EXISTS idx_trade_quality_evaluations_profile_version_id
    ON trade_quality_evaluations(profile_version_id);

-- A completed evaluation is an immutable snapshot (spec section 6): the
-- evidence used at evaluation time must never silently change. Earlier
-- lifecycle transitions (draft -> needs_input -> completed/insufficient_data)
-- remain possible until the row is completed.
CREATE OR REPLACE FUNCTION forbid_completed_evaluation_update()
RETURNS TRIGGER AS $$
BEGIN
    IF OLD.status = 'completed' THEN
        RAISE EXCEPTION 'completed trade_quality_evaluations are immutable snapshots; create a new evaluation instead';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trade_quality_evaluations_no_update_when_completed ON trade_quality_evaluations;
CREATE TRIGGER trade_quality_evaluations_no_update_when_completed
    BEFORE UPDATE ON trade_quality_evaluations
    FOR EACH ROW
    EXECUTE FUNCTION forbid_completed_evaluation_update();

-- ---------------------------------------------------------------------------
-- updated_at maintenance and documentation
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION update_quality_profiles_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = CURRENT_TIMESTAMP;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS update_quality_profiles_updated_at ON quality_profiles;
CREATE TRIGGER update_quality_profiles_updated_at
    BEFORE UPDATE ON quality_profiles
    FOR EACH ROW
    EXECUTE FUNCTION update_quality_profiles_updated_at();

COMMENT ON TABLE quality_profiles IS 'User-owned Quality Profiles (setup-specific grading definitions). Optional playbook linkage; profile configuration is stored in versioned snapshots.';
COMMENT ON TABLE quality_profile_versions IS 'Immutable configuration snapshots of a Quality Profile. Editing a profile creates a new version; historical evaluations remain linked to the version that produced them.';
COMMENT ON TABLE trade_quality_evaluations IS 'Post-trade quality evaluations linked to an exact immutable profile version, preserving the evidence snapshot used at evaluation time. Completed evaluations are immutable.';
COMMENT ON COLUMN quality_profiles.current_version_id IS 'The current immutable configuration version for this profile.';
COMMENT ON COLUMN trade_quality_evaluations.results IS 'Per-dimension evaluation results (setup/entry/management), including per-criterion states, scores, evidence, and coverage bookkeeping.';
