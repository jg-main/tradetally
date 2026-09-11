-- Phase 5 (Version / Evaluation History) — primary quality evaluation
-- selection, per docs/QUALITY_PROFILES_REQUIREMENT.md sections 4, 6, 53, 66.
--
-- Requirements enforced here:
--   * at most ONE primary quality evaluation per trade;
--   * a primary evaluation must belong to the SAME trade and the SAME user;
--   * only terminal evaluations (completed / insufficient_data) may be primary
--     (draft / needs_input must never become primary);
--   * selecting a primary must NOT mutate the immutable historical evaluation
--     (results / evidence_snapshot / user_inputs / detected_context /
--     profile_version_id / evaluated_at stay untouched).
--
-- The primary selection therefore lives in a SEPARATE relation rather than a
-- mutable column on trade_quality_evaluations. This migration is purely
-- additive, preserves every existing evaluation row, and intentionally does
-- NOT backfill any primary (an unset primary stays unset; spec §53/§66).

-- ---------------------------------------------------------------------------
-- Composite key target for the primary relation's FK.
-- ---------------------------------------------------------------------------
-- (id, trade_id, user_id) is unique because id is the primary key, but
-- PostgreSQL still requires an explicit unique constraint to be the target of
-- a composite foreign key. The constraint lets the database itself guarantee
-- that a primary pointer references an evaluation with the same trade_id and
-- user_id instead of trusting service code.
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint c
        JOIN pg_class t ON t.oid = c.conrelid
        JOIN pg_namespace n ON n.oid = t.relnamespace
        WHERE c.conname = 'trade_quality_evaluations_id_trade_user_key'
          AND t.relname = 'trade_quality_evaluations'
          AND n.nspname = current_schema()
    ) THEN
        ALTER TABLE trade_quality_evaluations
            ADD CONSTRAINT trade_quality_evaluations_id_trade_user_key
            UNIQUE (id, trade_id, user_id);
    END IF;
END $$;

-- ---------------------------------------------------------------------------
-- trade_quality_primary_evaluations (single-row pointer per trade)
-- ---------------------------------------------------------------------------
-- trade_id is the PRIMARY KEY, so a trade can have at most one primary row.
-- The composite FK (evaluation_id, trade_id, user_id) guarantees same
-- trade + same user at the database level. ON DELETE CASCADE removes the
-- pointer when its evaluation (or the trade/user, via the evaluation) is
-- deleted, never leaving an orphaned primary.
CREATE TABLE IF NOT EXISTS trade_quality_primary_evaluations (
    trade_id UUID PRIMARY KEY REFERENCES trades(id) ON DELETE CASCADE,
    user_id UUID NOT NULL,
    evaluation_id UUID NOT NULL,
    selected_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT trade_quality_primary_evaluations_evaluation_fkey
        FOREIGN KEY (evaluation_id, trade_id, user_id)
        REFERENCES trade_quality_evaluations (id, trade_id, user_id)
        ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_trade_quality_primary_evaluations_evaluation_id
    ON trade_quality_primary_evaluations(evaluation_id);

CREATE INDEX IF NOT EXISTS idx_trade_quality_primary_evaluations_user_id
    ON trade_quality_primary_evaluations(user_id);

-- Only terminal evaluations may be primary. A CHECK constraint cannot
-- reference another table, so this eligibility rule is enforced with a
-- trigger. Terminal evaluations can never transition back to a pre-terminal
-- status (migration 249), so a valid primary stays valid.
CREATE OR REPLACE FUNCTION assert_primary_evaluation_terminal()
RETURNS TRIGGER AS $$
DECLARE
    evaluation_status VARCHAR(20);
BEGIN
    SELECT status INTO evaluation_status
    FROM trade_quality_evaluations
    WHERE id = NEW.evaluation_id;

    IF evaluation_status IS NULL THEN
        RAISE EXCEPTION 'primary evaluation % does not exist', NEW.evaluation_id;
    END IF;
    IF evaluation_status NOT IN ('completed', 'insufficient_data') THEN
        RAISE EXCEPTION
            'only terminal evaluations (completed or insufficient_data) may be primary; evaluation % is %',
            NEW.evaluation_id, evaluation_status;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trade_quality_primary_evaluations_terminal_only
    ON trade_quality_primary_evaluations;
CREATE TRIGGER trade_quality_primary_evaluations_terminal_only
    BEFORE INSERT OR UPDATE ON trade_quality_primary_evaluations
    FOR EACH ROW
    EXECUTE FUNCTION assert_primary_evaluation_terminal();

-- ---------------------------------------------------------------------------
-- History ordering indexes
-- ---------------------------------------------------------------------------
-- Deterministic history order is
--   evaluated_at DESC NULLS LAST, created_at DESC, id DESC
-- so provide a matching composite index for the per-trade lookup.
CREATE INDEX IF NOT EXISTS idx_trade_quality_evaluations_trade_history
    ON trade_quality_evaluations (
        user_id,
        trade_id,
        evaluated_at DESC NULLS LAST,
        created_at DESC,
        id DESC
    );

COMMENT ON TABLE trade_quality_primary_evaluations IS
    'At most one primary quality evaluation per trade (Phase 5). Separate from immutable evaluation snapshots; only terminal evaluations are eligible; no automatic promotion; no backfill.';
