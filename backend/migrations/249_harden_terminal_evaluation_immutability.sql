-- Terminal trade-quality evaluations are immutable snapshots.
--
-- Docs/QUALITY_PROFILES_REQUIREMENT.md treats both `completed` and
-- `insufficient_data` as terminal states: once reached, an evaluation may not
-- be rewritten, upgraded, or replaced by saveResult(); a later attempt must
-- create a NEW trade_quality_evaluations row. Draft (and future
-- needs_input) rows remain mutable pre-terminal states.
--
-- This replaces the completed-only guard from migration 247 with a guard that
-- protects both terminal statuses. Account deletion is unaffected: DELETE
-- (including cascade cleanup in User.deleteUser) still works; immutability
-- applies to UPDATE only.

CREATE OR REPLACE FUNCTION forbid_terminal_evaluation_update()
RETURNS TRIGGER AS $$
BEGIN
    IF OLD.status IN ('completed', 'insufficient_data') THEN
        RAISE EXCEPTION
            'terminal trade_quality_evaluations (completed or insufficient_data) are immutable snapshots; create a new evaluation instead';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trade_quality_evaluations_no_update_when_completed
    ON trade_quality_evaluations;

CREATE TRIGGER trade_quality_evaluations_no_update_when_completed
    BEFORE UPDATE ON trade_quality_evaluations
    FOR EACH ROW
    EXECUTE FUNCTION forbid_terminal_evaluation_update();

-- The pre-hardening guard function is superseded.
DROP FUNCTION IF EXISTS forbid_completed_evaluation_update();

COMMENT ON TRIGGER trade_quality_evaluations_no_update_when_completed
    ON trade_quality_evaluations
    IS 'Completed and insufficient_data evaluations are immutable terminal snapshots; UPDATE is rejected.';
