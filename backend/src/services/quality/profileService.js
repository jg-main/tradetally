'use strict';

// Quality Profile persistence service (spec sections 4, 5.1, 5.2).
//
// Profile configuration is versioned. Editing a profile means inserting a NEW
// immutable quality_profile_versions row and repointing
// quality_profiles.current_version_id; prior versions are never updated, so
// historical evaluations stay linked to the version they were created with.
//
// Phase 1 scope: creation, immutable version creation, current-version
// reads, and the Canonical BO seed. No REST endpoints and no mass backfill.

const db = require('../../config/database');
const { DEFAULT_SCHEMA_VERSION } = require('./constants');
const { assertProfileVersionConfiguration } = require('./validation');
const {
  CANONICAL_BO_NAME,
  CANONICAL_BO_DESCRIPTION,
  getCanonicalBOConfig
} = require('./canonicalBO');

const PROFILE_COLUMNS = `
  id, user_id, name, description, playbook_id, instrument_type,
  is_active, current_version_id, created_at, updated_at
`;

const VERSION_COLUMNS = `
  id, profile_id, version_number, schema_version, configuration, created_at
`;

// Version columns qualified for queries that join quality_profiles so column
// names shared by both tables (id, created_at) are unambiguous.
const VERSION_COLUMNS_QUALIFIED = VERSION_COLUMNS
  .split(',')
  .map((column) => `v.${column.trim()}`)
  .join(', ');

async function listProfiles(userId) {
  const result = await db.query(
    `
      SELECT ${PROFILE_COLUMNS}
      FROM quality_profiles
      WHERE user_id = $1
      ORDER BY created_at ASC, name ASC
    `,
    [userId]
  );
  return result.rows;
}

async function findById(profileId, userId) {
  const result = await db.query(
    `
      SELECT ${PROFILE_COLUMNS}
      FROM quality_profiles
      WHERE id = $1 AND user_id = $2
    `,
    [profileId, userId]
  );
  return result.rows[0] || null;
}

async function findByName(userId, name) {
  const result = await db.query(
    `
      SELECT ${PROFILE_COLUMNS}
      FROM quality_profiles
      WHERE user_id = $1 AND LOWER(name) = LOWER($2)
    `,
    [userId, name]
  );
  return result.rows[0] || null;
}

async function getCurrentVersion(profileId, userId) {
  const result = await db.query(
    `
      SELECT ${VERSION_COLUMNS_QUALIFIED}
      FROM quality_profile_versions v
      JOIN quality_profiles p ON p.id = v.profile_id
      WHERE v.profile_id = $1
        AND v.id = p.current_version_id
        AND p.user_id = $2
    `,
    [profileId, userId]
  );
  return result.rows[0] || null;
}

// Lists every immutable version of one profile owned by `userId`, oldest
// first, with the profile name and a marker for the profile's current version.
// Version history metadata (Phase 5, spec sections 52/53). Read-only.
async function listVersions(profileId, userId) {
  const result = await db.query(
    `
      SELECT
        ${VERSION_COLUMNS_QUALIFIED},
        p.name AS profile_name,
        p.current_version_id,
        (v.id = p.current_version_id) AS is_current_version
      FROM quality_profile_versions v
      JOIN quality_profiles p ON p.id = v.profile_id
      WHERE v.profile_id = $1
        AND p.user_id = $2
      ORDER BY v.version_number ASC, v.id ASC
    `,
    [profileId, userId]
  );
  return result.rows;
}

// Loads one immutable version by id, scoped to its owning user. Returns the
// version columns plus profile name and current-version marker. Used by the
// Phase 5 re-evaluation and comparison paths to read the exact configuration
// that produced an evaluation without ever resolving "current version" again.
async function findVersionById(versionId, userId) {
  const result = await db.query(
    `
      SELECT
        ${VERSION_COLUMNS_QUALIFIED},
        p.name AS profile_name,
        p.current_version_id,
        (v.id = p.current_version_id) AS is_current_version
      FROM quality_profile_versions v
      JOIN quality_profiles p ON p.id = v.profile_id
      WHERE v.id = $1
        AND p.user_id = $2
    `,
    [versionId, userId]
  );
  return result.rows[0] || null;
}

// Creates a quality profile with its first immutable version (version 1).
//
// Generic profile creation REQUIRES an explicit valid configuration. Only
// the Canonical BO preset path (ensureCanonicalBO) injects the canonical
// default; a generic profile must never silently become Canonical BO.
async function createProfile(userId, profileData) {
  const configuration = profileData.configuration;
  if (configuration === undefined || configuration === null) {
    throw new Error(
      'Profile configuration is required; use ensureCanonicalBO() to create the Canonical BO preset'
    );
  }
  assertProfileVersionConfiguration(configuration);

  const name = typeof profileData.name === 'string' ? profileData.name.trim() : '';
  if (!name) {
    throw new Error('Profile name is required');
  }

  const playbookId = profileData.playbookId || null;
  const instrumentType = profileData.instrumentType || null;
  const isActive = profileData.isActive !== false;

  const client = await db.connect();
  try {
    await client.query('BEGIN');

    if (playbookId) {
      const playbookResult = await client.query(
        'SELECT 1 AS found FROM playbooks WHERE id = $1 AND user_id = $2',
        [playbookId, userId]
      );
      if (playbookResult.rows.length === 0) {
        throw new Error('playbook not found or not owned by this user');
      }
    }

    const profileResult = await client.query(
      `
        INSERT INTO quality_profiles (
          user_id, name, description, playbook_id, instrument_type, is_active
        )
        VALUES ($1, $2, $3, $4, $5, $6)
        RETURNING id
      `,
      [
        userId,
        name,
        profileData.description || null,
        playbookId,
        instrumentType,
        isActive
      ]
    );
    const profileId = profileResult.rows[0].id;

    const versionResult = await client.query(
      `
        INSERT INTO quality_profile_versions (
          profile_id, version_number, schema_version, configuration
        )
        VALUES ($1, $2, $3, $4)
        RETURNING ${VERSION_COLUMNS}
      `,
      [profileId, 1, DEFAULT_SCHEMA_VERSION, configuration]
    );

    // Return the actual persisted profile state (current_version_id set),
    // not the stale pre-version INSERT row.
    const updatedResult = await client.query(
      `
        UPDATE quality_profiles
        SET current_version_id = $1
        WHERE id = $2 AND user_id = $3
        RETURNING ${PROFILE_COLUMNS}
      `,
      [versionResult.rows[0].id, profileId, userId]
    );
    if (updatedResult.rows.length === 0) {
      throw new Error('profile could not be updated after version creation');
    }

    await client.query('COMMIT');
    return updatedResult.rows[0];
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

// Inserts the next immutable version for an existing profile and repoints
// current_version_id. Prior version rows are never modified.
async function createVersion(profileId, userId, configuration) {
  assertProfileVersionConfiguration(configuration);

  const profile = await findById(profileId, userId);
  if (!profile) {
    return null;
  }

  const client = await db.connect();
  try {
    await client.query('BEGIN');

    const maxResult = await client.query(
      `
        SELECT COALESCE(MAX(version_number), 0) + 1 AS next_version
        FROM quality_profile_versions
        WHERE profile_id = $1
      `,
      [profileId]
    );
    const nextVersion = Number(maxResult.rows[0].next_version);

    const versionResult = await client.query(
      `
        INSERT INTO quality_profile_versions (
          profile_id, version_number, schema_version, configuration
        )
        VALUES ($1, $2, $3, $4)
        RETURNING ${VERSION_COLUMNS}
      `,
      [profileId, nextVersion, DEFAULT_SCHEMA_VERSION, configuration]
    );

    await client.query(
      `
        UPDATE quality_profiles
        SET current_version_id = $1
        WHERE id = $2 AND user_id = $3
      `,
      [versionResult.rows[0].id, profileId, userId]
    );

    await client.query('COMMIT');
    return versionResult.rows[0];
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

// Seeds the Canonical BO profile (with its v1 configuration) for a user if it
// does not already exist. No-op when the user already has one. Existing users
// are never backfilled by a migration; later phases call this at the point
// where a profile is needed (e.g. registration or first profile-based grade).
async function ensureCanonicalBO(userId) {
  const existing = await findByName(userId, CANONICAL_BO_NAME);
  if (existing) {
    return existing;
  }
  return createProfile(userId, {
    name: CANONICAL_BO_NAME,
    description: CANONICAL_BO_DESCRIPTION,
    configuration: getCanonicalBOConfig()
  });
}

module.exports = {
  PROFILE_COLUMNS,
  VERSION_COLUMNS,
  listProfiles,
  findById,
  findByName,
  getCurrentVersion,
  listVersions,
  findVersionById,
  createProfile,
  createVersion,
  ensureCanonicalBO
};
