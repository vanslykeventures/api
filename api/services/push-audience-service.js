const normalizeArray = (value) => {
  if (Array.isArray(value)) return value;
  if (value && typeof value === 'object') return Object.values(value);
  return [];
};

const normalizeId = (value) => {
  if (value === undefined || value === null || value === '') return null;
  return String(value);
};

const uniqueStrings = (values) =>
  Array.from(new Set(values.map(normalizeId).filter(Boolean)));

const normalizeRoles = (roles) => {
  const normalized = uniqueStrings(Array.isArray(roles) && roles.length > 0 ? roles : ['parent', 'coach'])
    .map((role) => role.toLowerCase());
  return {
    includeParents: normalized.includes('parent') || normalized.includes('parents'),
    includeCoaches: normalized.includes('coach') || normalized.includes('coaches'),
    includeAdmins: normalized.includes('admin') || normalized.includes('admins'),
  };
};

const extractRows = (payload) => {
  if (!payload || typeof payload !== 'object') return [];
  if (Array.isArray(payload.results)) return payload.results;
  if (Array.isArray(payload.result)) return payload.result;
  if (payload.result && typeof payload.result === 'object') return Object.values(payload.result);
  return [];
};

const extractCoachParentIds = (payload) =>
  extractRows(payload)
    .map((coach) => normalizeId(coach?.parent_id ?? coach?.parentId ?? coach?.id))
    .filter(Boolean);

const extractPlayerParentIds = (payload) =>
  extractRows(payload).flatMap((player) => {
    const directParentIds = [
      player?.parent_id,
      player?.parentId,
      player?.primary_parent_id,
      player?.secondary_parent_id,
    ];
    const parents = normalizeArray(player?.parents).flatMap((parent) => [
      parent?.parent_id,
      parent?.parentId,
      parent?.id,
    ]);
    return [...directParentIds, ...parents].map(normalizeId).filter(Boolean);
  });

function createPushAudienceResolver({ sourceApiGet }) {
  const coachesByTeamId = new Map();
  const playersByTeamId = new Map();

  const getTeamCoaches = async (teamId) => {
    const key = String(teamId);
    if (!coachesByTeamId.has(key)) {
      coachesByTeamId.set(key, sourceApiGet(`teams/${encodeURIComponent(key)}/coaches`));
    }
    return coachesByTeamId.get(key);
  };

  const getTeamPlayers = async (teamId) => {
    const key = String(teamId);
    if (!playersByTeamId.has(key)) {
      playersByTeamId.set(key, sourceApiGet(`teams/${encodeURIComponent(key)}/players`));
    }
    return playersByTeamId.get(key);
  };

  const resolveTeamsAudience = async (audience) => {
    const teamIds = uniqueStrings(audience?.teamIds ?? audience?.team_ids ?? []);
    const roles = normalizeRoles(audience?.recipientRoles ?? audience?.recipient_roles);
    const parentIds = [];

    await Promise.all(teamIds.map(async (teamId) => {
      if (roles.includeCoaches) {
        parentIds.push(...extractCoachParentIds(await getTeamCoaches(teamId)));
      }
      if (roles.includeParents) {
        parentIds.push(...extractPlayerParentIds(await getTeamPlayers(teamId)));
      }
    }));

    const resolvedParentIds = uniqueStrings(parentIds);

    return {
      audience: {
        type: 'parent_ids',
        parentIds: resolvedParentIds,
      },
      resolution: {
        originalAudience: audience,
        teamIds,
        recipientRoles: {
          parent: roles.includeParents,
          coach: roles.includeCoaches,
          admin: roles.includeAdmins,
        },
        resolvedParentIdCount: resolvedParentIds.length,
      },
    };
  };

  const resolveAudience = async (audience) => {
    if (!audience || typeof audience !== 'object') {
      return {
        audience: { type: 'all' },
        resolution: { originalAudience: audience ?? null, resolvedParentIdCount: null },
      };
    }

    if (audience.type === 'teams' || audience.type === 'team') {
      const teamAudience = audience.type === 'team'
        ? { ...audience, teamIds: [audience.teamId ?? audience.team_id] }
        : audience;
      return resolveTeamsAudience(teamAudience);
    }

    if (audience.type === 'parent_ids') {
      const parentIds = uniqueStrings(audience.parentIds ?? audience.parent_ids ?? []);
      return {
        audience: { type: 'parent_ids', parentIds },
        resolution: {
          originalAudience: audience,
          resolvedParentIdCount: parentIds.length,
        },
      };
    }

    return {
      audience,
      resolution: {
        originalAudience: audience,
        resolvedParentIdCount: null,
      },
    };
  };

  return {
    resolveAudience,
  };
}

module.exports = {
  createPushAudienceResolver,
};
