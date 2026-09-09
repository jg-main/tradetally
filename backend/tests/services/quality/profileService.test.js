'use strict';

jest.mock('../../../src/config/database', () => ({
  query: jest.fn(),
  connect: jest.fn()
}));

const db = require('../../../src/config/database');
const profileService = require('../../../src/services/quality/profileService');
const { getCanonicalBOConfig } = require('../../../src/services/quality/canonicalBO');

function makeClient() {
  return {
    query: jest.fn(),
    release: jest.fn()
  };
}

function mockInsertRows(client, { profileRow, versionRow, updatedProfileRow }) {
  client.query.mockImplementation((sql) => {
    const statement = String(sql);
    if (statement.includes('INSERT INTO quality_profiles')) {
      return Promise.resolve({ rows: [{ id: profileRow.id }] });
    }
    if (statement.includes('INSERT INTO quality_profile_versions')) {
      return Promise.resolve({ rows: [versionRow] });
    }
    if (statement.includes('UPDATE quality_profiles')) {
      return Promise.resolve({ rows: [updatedProfileRow] });
    }
    return Promise.resolve({ rows: [] });
  });
}

function findCall(mockFn, fragment) {
  return mockFn.mock.calls.find(([sql]) => String(sql).includes(fragment));
}

const CANONICAL_CONFIG = getCanonicalBOConfig();

describe('profileService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('createProfile', () => {
    it('creates a profile with immutable version 1 and returns the persisted current_version_id', async () => {
      const client = makeClient();
      db.connect.mockResolvedValue(client);
      mockInsertRows(client, {
        profileRow: { id: 'profile-1' },
        versionRow: { id: 'version-1', profile_id: 'profile-1', version_number: 1, configuration: CANONICAL_CONFIG },
        updatedProfileRow: {
          id: 'profile-1',
          user_id: 'user-1',
          name: 'Breakout',
          current_version_id: 'version-1'
        }
      });

      const created = await profileService.createProfile('user-1', {
        name: 'Breakout',
        description: 'A description',
        configuration: CANONICAL_CONFIG
      });

      expect(created.id).toBe('profile-1');
      expect(created.current_version_id).toBe('version-1');
      expect(client.query.mock.calls[0][0]).toMatch(/BEGIN/);
      expect(client.query.mock.calls.some(([sql]) => String(sql).includes('COMMIT'))).toBe(true);

      const profileInsert = findCall(client.query, 'INSERT INTO quality_profiles');
      expect(profileInsert[1]).toEqual(['user-1', 'Breakout', 'A description', null, null, true]);

      const versionInsert = findCall(client.query, 'INSERT INTO quality_profile_versions');
      expect(versionInsert[1][0]).toBe('profile-1');
      expect(versionInsert[1][1]).toBe(1); // version_number
      expect(versionInsert[1][2]).toBe(1); // schema_version
      expect(versionInsert[1][3]).toBe(CANONICAL_CONFIG);

      const pointerUpdate = findCall(client.query, 'UPDATE quality_profiles');
      expect(pointerUpdate[1]).toEqual(['version-1', 'profile-1', 'user-1']);
      expect(pointerUpdate[0]).toMatch(/RETURNING/);

      expect(client.release).toHaveBeenCalled();
    });

    it('rejects generic profile creation without an explicit configuration', async () => {
      await expect(profileService.createProfile('user-1', { name: 'Episodic Pivot' }))
        .rejects.toThrow(/configuration is required/i);
      expect(db.connect).not.toHaveBeenCalled();
    });

    it('rejects an invalid configuration and a blank name before touching the database', async () => {
      await expect(profileService.createProfile('user-1', {
        name: 'Bad',
        configuration: { dimensions: { setup_quality: {} } }
      })).rejects.toThrow(/unknown dimension/);
      await expect(profileService.createProfile('user-1', {
        name: '   ',
        configuration: CANONICAL_CONFIG
      })).rejects.toThrow(/name is required/i);

      expect(db.connect).not.toHaveBeenCalled();
    });

    it('rejects a playbook_id that is not owned by the user', async () => {
      const client = makeClient();
      db.connect.mockResolvedValue(client);
      client.query.mockImplementation((sql) => {
        const statement = String(sql);
        if (statement.includes('SELECT 1 AS found FROM playbooks')) {
          return Promise.resolve({ rows: [] });
        }
        return Promise.resolve({ rows: [] });
      });

      await expect(profileService.createProfile('user-1', {
        name: 'Breakout',
        playbookId: 'playbook-other',
        configuration: CANONICAL_CONFIG
      })).rejects.toThrow(/playbook not found or not owned/);

      expect(client.query.mock.calls.some(([sql]) => String(sql).includes('ROLLBACK'))).toBe(true);
      expect(client.release).toHaveBeenCalled();
      expect(findCall(client.query, 'INSERT INTO quality_profiles')).toBeUndefined();
    });

    it('accepts a playbook_id owned by the user', async () => {
      const client = makeClient();
      db.connect.mockResolvedValue(client);
      client.query.mockImplementation((sql) => {
        const statement = String(sql);
        if (statement.includes('SELECT 1 AS found FROM playbooks')) {
          return Promise.resolve({ rows: [{ found: 1 }] });
        }
        if (statement.includes('INSERT INTO quality_profiles')) {
          return Promise.resolve({ rows: [{ id: 'profile-1' }] });
        }
        if (statement.includes('INSERT INTO quality_profile_versions')) {
          return Promise.resolve({ rows: [{ id: 'version-1' }] });
        }
        if (statement.includes('UPDATE quality_profiles')) {
          return Promise.resolve({ rows: [{ id: 'profile-1', current_version_id: 'version-1' }] });
        }
        return Promise.resolve({ rows: [] });
      });

      const created = await profileService.createProfile('user-1', {
        name: 'Breakout',
        playbookId: 'playbook-1',
        configuration: CANONICAL_CONFIG
      });

      expect(created.current_version_id).toBe('version-1');
      const profileInsert = findCall(client.query, 'INSERT INTO quality_profiles');
      expect(profileInsert[1]).toEqual(['user-1', 'Breakout', null, 'playbook-1', null, true]);
    });

    it('rolls back and rethrows when a statement fails', async () => {
      const client = makeClient();
      db.connect.mockResolvedValue(client);
      client.query.mockRejectedValue(new Error('boom'));

      await expect(profileService.createProfile('user-1', {
        name: 'Breakout',
        configuration: CANONICAL_CONFIG
      })).rejects.toThrow('boom');
      expect(client.query.mock.calls.some(([sql]) => String(sql).includes('ROLLBACK'))).toBe(true);
      expect(client.release).toHaveBeenCalled();
    });
  });

  describe('createVersion', () => {
    it('creates the next immutable version and repoints current_version_id', async () => {
      db.query.mockResolvedValue({ rows: [{ id: 'profile-1', user_id: 'user-1' }] });

      const client = makeClient();
      db.connect.mockResolvedValue(client);
      client.query.mockImplementation((sql) => {
        const statement = String(sql);
        if (statement.includes('SELECT COALESCE(MAX(version_number)')) {
          return Promise.resolve({ rows: [{ next_version: '2' }] });
        }
        if (statement.includes('INSERT INTO quality_profile_versions')) {
          return Promise.resolve({ rows: [{ id: 'version-2', version_number: 2 }] });
        }
        return Promise.resolve({ rows: [] });
      });

      const version = await profileService.createVersion('profile-1', 'user-1', CANONICAL_CONFIG);

      expect(version.id).toBe('version-2');
      expect(version.version_number).toBe(2);

      const insert = findCall(client.query, 'INSERT INTO quality_profile_versions');
      expect(insert[1]).toEqual(['profile-1', 2, 1, CANONICAL_CONFIG]);
    });

    it('returns null when the profile does not exist or is not owned by the user', async () => {
      db.query.mockResolvedValue({ rows: [] });
      const version = await profileService.createVersion('profile-1', 'user-1', CANONICAL_CONFIG);
      expect(version).toBeNull();
      expect(db.connect).not.toHaveBeenCalled();
    });
  });

  describe('ensureCanonicalBO', () => {
    it('creates the Canonical BO profile (with its explicit v1 config) when the user has none', async () => {
      db.query.mockResolvedValue({ rows: [] });

      const client = makeClient();
      db.connect.mockResolvedValue(client);
      mockInsertRows(client, {
        profileRow: { id: 'profile-1' },
        versionRow: { id: 'version-1', profile_id: 'profile-1', version_number: 1 },
        updatedProfileRow: { id: 'profile-1', user_id: 'user-1', name: 'Canonical BO', current_version_id: 'version-1' }
      });

      const profile = await profileService.ensureCanonicalBO('user-1');
      expect(profile.name).toBe('Canonical BO');
      expect(profile.current_version_id).toBe('version-1');

      const profileInsert = findCall(client.query, 'INSERT INTO quality_profiles');
      expect(profileInsert[1][1]).toBe('Canonical BO');
      expect(profileInsert[1][2]).toMatch(/Leading stock/);

      const versionInsert = findCall(client.query, 'INSERT INTO quality_profile_versions');
      expect(versionInsert[1][3].dimensions.setup.criteria[0].key).toBe('leader');
      expect(versionInsert[1][3].dimensions.setup.criteria[0].scoring).toBeDefined();
    });

    it('is a no-op when the user already has a Canonical BO profile', async () => {
      db.query.mockResolvedValue({ rows: [{ id: 'profile-1', user_id: 'user-1', name: 'Canonical BO' }] });

      const profile = await profileService.ensureCanonicalBO('user-1');
      expect(profile.id).toBe('profile-1');
      expect(db.connect).not.toHaveBeenCalled();
    });
  });

  describe('read helpers', () => {
    it('lists and fetches profiles scoped to the user', async () => {
      db.query.mockResolvedValueOnce({ rows: [{ id: 'p1' }] });
      const listed = await profileService.listProfiles('user-1');
      expect(listed).toEqual([{ id: 'p1' }]);
      expect(db.query.mock.calls[0][1]).toEqual(['user-1']);

      db.query.mockResolvedValueOnce({ rows: [{ id: 'p2' }] });
      const found = await profileService.findById('p2', 'user-2');
      expect(found).toEqual({ id: 'p2' });
      expect(db.query.mock.calls[1][1]).toEqual(['p2', 'user-2']);

      db.query.mockResolvedValueOnce({ rows: [] });
      const missing = await profileService.findById('p3', 'user-2');
      expect(missing).toBeNull();
    });

    it('fetches the current immutable version for a profile', async () => {
      db.query.mockResolvedValue({ rows: [{ id: 'v9', version_number: 9 }] });
      const version = await profileService.getCurrentVersion('profile-1', 'user-1');
      expect(version.version_number).toBe(9);
      expect(db.query.mock.calls[0][1]).toEqual(['profile-1', 'user-1']);
    });
  });
});
