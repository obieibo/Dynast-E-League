/**
 * @file dataYahoo.gs
 * @description Centralized engine for all Yahoo Fantasy Sports API calls. 
 * Handles league settings, team stats, matchups, standings, managers, 
 * the entire player universe, rosters, transactions, and draft results.
 * @dependencies _auth.gs, _helpers.gs, resolvePlayer.gs
 */

// ============================================================================
//  YAHOO LEAGUE INFO
// ============================================================================

function updateYahooLeagueInfo() {
  const leagueKey = _getLeagueKey();
  if (!leagueKey) return;

  const data = _fetchYahooAPI(`https://fantasysports.yahooapis.com/fantasy/v2/league/${leagueKey}/settings?format=json`);
  if (!data || !data.fantasy_content) {
    _logError('dataYahoo.gs', 'Failed to fetch league info.', 'HIGH');
    return;
  }

  const basicInfo = data.fantasy_content.league?.[0];
  const settings  = data.fantasy_content.league?.[1]?.settings?.[0];
  if (!basicInfo || !settings) return;

  const outputRows = [['CATEGORY', 'SETTING', 'VALUE', 'TYPE', 'ID', 'FLAG']];
  const complexKeys = ['roster_positions', 'stat_categories', 'stat_modifiers', 'divisions'];

  Object.keys(basicInfo).forEach(key => {
    const val = basicInfo[key];
    if (val === null || typeof val !== 'object') {
      outputRows.push(['league', key, val, '', '', '']);
    } else if (key === 'logo' && val.url) {
      outputRows.push(['league', 'logo_url', val.url, '', '', '']);
    }
  });

  Object.keys(settings).forEach(key => {
    const val = settings[key];
    if (val === null || typeof val !== 'object') {
      outputRows.push(['settings', key, val, '', '', '']);
    } else if (!complexKeys.includes(key)) {
      outputRows.push(['settings', key, JSON.stringify(val), '', '', '']);
    }
  });

  if (settings.roster_positions) {
    settings.roster_positions.forEach(item => {
      const pos = item.roster_position;
      outputRows.push(['roster_positions', pos.position, pos.count, pos.position_type || '', '', pos.is_bench ? 'Bench' : '']);
    });
  }

  if (settings.stat_categories?.stats) {
    settings.stat_categories.stats.forEach(item => {
      const stat = item.stat;
      outputRows.push(['stat_categories', stat.name || '', stat.display_name || stat.abbr || '', stat.position_type || '', stat.stat_id !== undefined ? String(stat.stat_id) : '', stat.is_only_display_stat == '1' ? 'Display Only' : '']);
    });
  }

  if (settings.stat_modifiers?.stats) {
    settings.stat_modifiers.stats.forEach(item => {
      const stat = item.stat;
      outputRows.push(['stat_modifiers', 'Stat Point Value', stat.value, '', stat.stat_id !== undefined ? String(stat.stat_id) : '', '']);
    });
  }

  if (settings.divisions) {
    settings.divisions.forEach(item => {
      const div = item.division;
      outputRows.push(['divisions', div.name, '', '', div.division_id !== undefined ? String(div.division_id) : '', '']);
    });
  }

  writeToData('_LEAGUE_INFO', outputRows);
  _updateTimestamp('UPDATE_LEAGUE');
}

// ============================================================================
//  YAHOO STANDINGS
// ============================================================================

function updateYahooStandings() {
  const leagueKey = _getLeagueKey();
  if (!leagueKey) return;

  const data = _fetchYahooAPI(`https://fantasysports.yahooapis.com/fantasy/v2/league/${leagueKey}/standings?format=json`);
  if (!data) return;

  const standingsDict = data.fantasy_content?.league?.[1]?.standings?.[0]?.teams;
  if (!standingsDict) return;

  const outputRows = [['RANK', 'TEAM_ID', 'MANAGER_ID', 'ROSTER', 'W', 'L', 'T', 'PCT', 'GB']];
  
  for (let i = 0; i < standingsDict.count; i++) {
    const t = standingsDict[i.toString()]?.team;
    if (!t) continue;

    const meta = t[0];
    const teamId = meta.find(item => item?.team_id)?.team_id || '';
    const rosterName = meta.find(item => item?.name)?.name || '';
    const mngrId = meta.find(item => item?.managers)?.managers?.[0]?.manager?.manager_id || '';

    const stats = t.find(item => item?.team_standings)?.team_standings;
    if (!stats) continue;
    const out = stats.outcome_totals || {};

    outputRows.push([
      stats.rank || '', teamId, mngrId, rosterName, 
      out.wins || 0, out.losses || 0, out.ties || 0, out.percentage || 0, stats.games_back || '-'
    ]);
  }

  writeToData('_STANDINGS', outputRows);
  _updateTimestamp('UPDATE_STANDINGS');
}

// ============================================================================
//  YAHOO TEAM STATS
// ============================================================================

function updateYahooTeamStats() {
  const leagueKey = _getLeagueKey();
  if (!leagueKey) return;

  const urls = [
    `https://fantasysports.yahooapis.com/fantasy/v2/league/${leagueKey}/settings?format=json`,
    `https://fantasysports.yahooapis.com/fantasy/v2/league/${leagueKey}/teams/stats?format=json`
  ];
  const [settingsData, statsData] = _fetchAllYahooAPI(urls);
  if (!settingsData || !statsData) return;

  const categories = settingsData.fantasy_content?.league?.[1]?.settings?.[0]?.stat_categories?.stats;
  const statMap = {};
  if (categories) categories.forEach(s => statMap[s.stat.stat_id] = s.stat.display_name);

  const teamsDict = statsData.fantasy_content?.league?.[1]?.teams;
  if (!teamsDict) return;

  const firstTeamStats = teamsDict['0']?.team?.find(item => item?.team_stats)?.team_stats?.stats || [];
  const statHeaders = firstTeamStats.map(s => statMap[s.stat.stat_id] || `Stat_${s.stat.stat_id}`);
  
  const outputRows = [['TEAM_ID', 'MANAGER_ID', 'ROSTER', ...statHeaders]];

  for (let i = 0; i < teamsDict.count; i++) {
    const t = teamsDict[i.toString()]?.team;
    if (!t) continue;

    const meta = t[0];
    const teamId = meta.find(item => item?.team_id)?.team_id || '';
    const rosterName = meta.find(item => item?.name)?.name || '';
    const mngrId = meta.find(item => item?.managers)?.managers?.[0]?.manager?.manager_id || '';

    const statVals = t.find(item => item?.team_stats)?.team_stats.stats.map(s => s.stat.value || '0') || [];
    outputRows.push([teamId, mngrId, rosterName, ...statVals]);
  }

  writeToData('_TEAM_STATS', outputRows);
  _updateTimestamp('UPDATE_TEAM_STATS');
}

// ============================================================================
//  YAHOO MATCHUPS
// ============================================================================

function updateYahooMatchups() {
  const leagueKey = _getLeagueKey();
  if (!leagueKey) return;

  const lgData = _fetchYahooAPI(`https://fantasysports.yahooapis.com/fantasy/v2/league/${leagueKey}?format=json`);
  const setData = _fetchYahooAPI(`https://fantasysports.yahooapis.com/fantasy/v2/league/${leagueKey}/settings?format=json`);
  if (!lgData || !setData) return;
  
  const currentWeek = parseInt(lgData.fantasy_content?.league?.[0]?.current_week, 10);
  const categories = setData.fantasy_content?.league?.[1]?.settings?.[0]?.stat_categories?.stats;
  const statMap = {};
  if (categories) categories.forEach(s => statMap[s.stat.stat_id] = s.stat.display_name);

  const urls = [];
  for (let w = 1; w <= currentWeek; w++) {
    urls.push(`https://fantasysports.yahooapis.com/fantasy/v2/league/${leagueKey}/scoreboard;week=${w}?format=json`);
  }
  const responses = _fetchAllYahooAPI(urls);

  const sheet = getDataSS()?.getSheetByName('_MATCHUPS');
  const existingData = sheet && sheet.getLastRow() > 0 ? sheet.getDataRange().getValues() : [];
  const mergedData = existingData.length > 0 ? existingData.map(r => [...r]) : [];
  let headersSet = existingData.length > 0;
  
  const rowMap = {};
  for (let i = 1; i < existingData.length; i++) {
    rowMap[`${existingData[i][0]}_${existingData[i][2]}`] = i; 
  }

  responses.forEach(data => {
    const matchups = data?.fantasy_content?.league?.[1]?.scoreboard?.['0']?.matchups;
    if (!matchups) return;

    for (let i = 0; i < matchups.count; i++) {
      const m = matchups[i.toString()]?.matchup;
      if (!m) continue;

      const matchWeek = parseInt(m.week) || 0;
      const teamData = m['0']?.teams;
      if (!teamData) continue;

      const score0 = parseFloat(teamData['0']?.team?.[1]?.team_points?.total || 0);
      const score1 = parseFloat(teamData['1']?.team?.[1]?.team_points?.total || 0);

      for (let t = 0; t < 2; t++) {
        const team = teamData[t.toString()]?.team;
        if (!team) continue;

        const meta = team[0];
        const teamId = meta.find(item => item?.team_id)?.team_id || '';
        const rosterName = meta.find(item => item?.name)?.name || '';
        const mngrId = meta.find(item => item?.managers)?.managers?.[0]?.manager?.manager_id || '';
        
        const oppTeam = teamData[t === 0 ? '1' : '0']?.team?.[0];
        const oppId = oppTeam?.find(item => item?.team_id)?.team_id || '';
        const oppMngrId = oppTeam?.find(item => item?.managers)?.managers?.[0]?.manager?.manager_id || '';
        const oppRoster = oppTeam?.find(item => item?.name)?.name || '';

        const score = t === 0 ? score0 : score1;
        const oppScore = t === 0 ? score1 : score0;
        let result = score > oppScore ? 'Win' : (score < oppScore ? 'Loss' : 'Tie');

        const stats = team[1]?.team_stats?.stats || [];
        const statVals = stats.map(s => {
          let val = s.stat?.value || '';
          return (typeof val === 'string' && val.includes('/')) ? `'${val}` : val;
        });

        if (!headersSet) {
          const statHeaders = stats.map(s => statMap[s.stat?.stat_id] || `Stat_${s.stat?.stat_id}`);
          mergedData.unshift(['WEEK', 'MATCHUP_ID', 'TEAM_ID', 'MANAGER_ID', 'ROSTER', 'TEAM_ID_2', 'MANAGER_ID_2', 'ROSTER_2', 'RESULT', 'SCORE', ...statHeaders]);
          headersSet = true;
        }

        const rowData = [matchWeek, i + 1, teamId, mngrId, rosterName, oppId, oppMngrId, oppRoster, result, score, ...statVals];
        const key = `${matchWeek}_${teamId}`;

        if (rowMap[key] !== undefined) mergedData[rowMap[key]] = rowData;
        else {
          mergedData.push(rowData);
          rowMap[key] = mergedData.length - 1;
        }
      }
    }
  });

  writeToData('_MATCHUPS', mergedData);
  _updateTimestamp('UPDATE_MATCHUPS');
}

// ============================================================================
//  YAHOO MANAGERS (ARCHIVE & DISPLAY)
// ============================================================================

function updateYahooManagers() {
  const ss = getPrimarySS();
  const currentYear = parseInt(ss.getRangeByName('CURRENT_YEAR')?.getValue(), 10);
  const keysRange = ss.getRangeByName('LEAGUE_KEYS_HISTORY');
  if (!currentYear || !keysRange) return;

  const keyMap = {};
  keysRange.getValues().forEach(row => {
    if (row[0] && row[2]) keyMap[parseInt(row[0])] = row[2].toString().trim();
  });
  keyMap[currentYear] = _getLeagueKey();

  const displaySheet = ss.getSheetByName('Managers');
  const existingData = displaySheet && displaySheet.getLastRow() >= 4 ? displaySheet.getRange(4, 1, displaySheet.getLastRow() - 3, 9).getValues() : [];
  
  const manualOverrides = {};
  existingData.forEach(row => {
    const yr = row[0], tId = row[6], abbr = row[3], mName = row[4];
    if (yr && tId) manualOverrides[`${yr}_${tId}`] = { abbr: abbr || '', mName: mName || '' };
  });

  const allRows = [];
  Object.keys(keyMap).sort((a,b) => a - b).forEach(year => {
    const data = _fetchYahooAPI(`https://fantasysports.yahooapis.com/fantasy/v2/league/${keyMap[year]}/teams?format=json`);
    const teamsData = data?.fantasy_content?.league?.[1]?.teams;
    if (!teamsData) return;

    for (let i = 0; i < teamsData.count; i++) {
      const teamArr = teamsData[i.toString()]?.team?.[0];
      if (!teamArr) continue;

      const tId = teamArr.find(item => item?.team_id)?.team_id || '';
      const tName = teamArr.find(item => item?.name)?.name || '';
      const mId = teamArr.find(item => item?.managers)?.managers?.[0]?.manager?.manager_id || '';
      const logoUrl = teamArr.find(item => item?.team_logos)?.team_logos?.[0]?.team_logo?.url || '';

      let abbr = manualOverrides[`${year}_${tId}`]?.abbr || '';
      let mName = manualOverrides[`${year}_${tId}`]?.mName || '';
      if (!mName && manualOverrides[`${year-1}_${tId}`]) mName = manualOverrides[`${year-1}_${tId}`].mName;

      allRows.push({ year: parseInt(year), tId, mId, tName, abbr, mName, logoUrl, shortName: '' });
    }
  });

  const allNames = [...new Set(allRows.map(r => r.mName).filter(Boolean))];
  const shortNameMap = {};
  const parsedNames = allNames.map(full => {
    const parts = full.trim().split(/\s+/);
    return { full, first: parts[0] || '', last: parts.length > 1 ? parts[parts.length - 1] : '' };
  });

  parsedNames.forEach(n => {
    if (!n.first) return;
    const sameFirst = parsedNames.filter(x => x.first.toLowerCase() === n.first.toLowerCase());
    if (sameFirst.length === 1) shortNameMap[n.full] = n.first;
    else if (n.last) {
      const sameInit = sameFirst.filter(x => x.last.charAt(0).toLowerCase() === n.last.charAt(0).toLowerCase());
      shortNameMap[n.full] = sameInit.length === 1 ? `${n.first} ${n.last.charAt(0)}.` : `${n.first} ${n.last.substring(0, 2)}.`;
    } else shortNameMap[n.full] = n.first;
  });

  allRows.forEach(r => r.shortName = r.mName ? (shortNameMap[r.mName] || r.mName) : '');

  const archiveOutput = [['YEAR', 'TEAM_ID', 'MANAGER_ID', 'ROSTER', 'ABBREVIATION', 'MANAGER', 'SHORT NAME', 'LOGO_URL']];
  allRows.forEach(r => archiveOutput.push([r.year, r.tId, r.mId, r.tName, r.abbr, r.mName, r.shortName, r.logoUrl]));
  writeToArchive('_MANAGERS', archiveOutput);

  const displayOutput = [];
  allRows.filter(r => r.year === currentYear || r.year === currentYear - 1)
         .sort((a,b) => b.year - a.year || parseInt(a.tId) - parseInt(b.tId))
         .forEach(r => displayOutput.push([r.year, '', r.tName, r.abbr, r.mName, r.shortName, r.tId, r.mId, r.logoUrl]));

  if (displayOutput.length > 0) {
    if (displaySheet.getLastRow() >= 4) displaySheet.getRange(4, 1, displaySheet.getLastRow() - 3, 9).clearContent();
    displaySheet.getRange(4, 1, displayOutput.length, 9).setValues(displayOutput);
    
    const imageValues = displayOutput.map(row => {
      const url = row[8];
      try { return url ? [SpreadsheetApp.newCellImage().setSourceUrl(url).build()] : ['']; } 
      catch (e) { return ['']; }
    });
    displaySheet.getRange(4, 2, imageValues.length, 1).setValues(imageValues);
  }
  
  _updateTimestamp('UPDATE_MANAGERS');
}

// ============================================================================
//  YAHOO PLAYERS (UNIVERSE)
// ============================================================================

function updateYahooPlayers() {
  const leagueKey = _getLeagueKey();
  if (!leagueKey) return;

  const maps = getPlayerMaps('YAHOOID');
  
  const tData = _fetchYahooAPI(`https://fantasysports.yahooapis.com/fantasy/v2/league/${leagueKey}/teams?format=json`);
  const tMap = {};
  if (tData?.fantasy_content?.league?.[1]?.teams) {
    const teams = tData.fantasy_content.league[1].teams;
    for (let i = 0; i < teams.count; i++) {
      const t = teams[i.toString()]?.team?.[0];
      const tId = t?.find(item => item?.team_id)?.team_id || '';
      const tName = t?.find(item => item?.name)?.name || '';
      const mId = t?.find(item => item?.managers)?.managers?.[0]?.manager?.manager_id || '';
      if (tId) tMap[tId] = { mId, tName };
    }
  }

  const outputRows = [['IDPLAYER', 'YAHOOID', 'PLAYER', 'TEAM', 'ELIGIBILITY', 'POSITION', 'IL', 'NA', 'TAG', 'INJURY_NOTE', 'STATUS', 'TEAM_ID', 'MANAGER_ID', 'ROSTER']];
  let start = 0, done = false;

  while (!done && start < 5000) {
    const batchUrls = [];
    for (let b = 0; b < 20; b++) {
      const offset = start + (b * 25);
      batchUrls.push(`https://fantasysports.yahooapis.com/fantasy/v2/league/${leagueKey}/players;out=ownership;start=${offset};count=25?format=json`);
    }

    const responses = _fetchAllYahooAPI(batchUrls);
    for (let data of responses) {
      if (!data) { done = true; break; }
      const leagueData = data.fantasy_content?.league?.[1]?.players;
      if (!leagueData || Array.isArray(leagueData) || leagueData.count === 0) { done = true; break; }

      for (let j = 0; j < leagueData.count; j++) {
        const rawP = leagueData[j.toString()]?.player;
        if (!rawP) continue;

        const p = _parseYahooPlayer(rawP);
        const { cleanPositions, isIL, isNA } = _parsePositions(p.positions);
        const primaryId = resolvePrimaryId(maps, p.pId, null, null, p.name, 'updateYahooPlayers', p.team);

        let status = 'Free Agent', tId = '', mId = '', rName = '';
        rawP.forEach(block => {
          if (!block?.ownership) return;
          const type = block.ownership.ownership_type || 'freeagents';
          if (type === 'team') {
            status = 'Rostered';
            const teamKey = block.ownership.owner_team_key || '';
            tId = teamKey.match(/\.t\.(\d+)$/)?.[1] || '';
            mId = tMap[tId]?.mId || '';
            rName = tMap[tId]?.tName || '';
          } else if (type === 'waivers') status = 'Waivers';
        });

        outputRows.push([primaryId, p.pId, p.name, p.team, p.positions, cleanPositions, isIL, isNA, p.status, p.injuryNote, status, tId, mId, rName]);
      }
      if (leagueData.count < 25) { done = true; break; }
    }
    start += 500;
  }

  writeToData('_PLAYERS', outputRows);
  _updateTimestamp('UPDATE_PLAYERS');
  flushIdMatchingQueue();
}

// ============================================================================
//  YAHOO TRANSACTIONS
// ============================================================================

function updateYahooTransactions() {
  const leagueKey = _getLeagueKey();
  if (!leagueKey) return;

  const maps = getPlayerMaps('YAHOOID');
  const timeZone = Session.getScriptTimeZone();

  const tData = _fetchYahooAPI(`https://fantasysports.yahooapis.com/fantasy/v2/league/${leagueKey}/teams?format=json`);
  const tMap = {};
  if (tData?.fantasy_content?.league?.[1]?.teams) {
    const teams = tData.fantasy_content.league[1].teams;
    for (let i = 0; i < teams.count; i++) {
      const t = teams[i.toString()]?.team?.[0];
      const tId = t?.find(item => item?.team_id)?.team_id;
      const mId = t?.find(item => item?.managers)?.managers?.[0]?.manager?.manager_id;
      if (tId && mId) tMap[tId.toString()] = mId.toString();
    }
  }

  const sheet = getDataSS()?.getSheetByName('_TRANSACTIONS');
  const existingData = sheet && sheet.getLastRow() > 0 ? sheet.getDataRange().getDisplayValues() : [['TRANS_ID', 'DATE', 'TIME', 'TEAM_ID', 'MANAGER_ID', 'ROSTER', 'TEAM_ID_2', 'MANAGER_ID_2', 'ROSTER_2', 'ACTION', 'IDPLAYER', 'YAHOOID', 'PLAYER', 'TEAM']];
  const existingKeys = new Set();
  for (let i = 1; i < existingData.length; i++) {
    existingKeys.add(`${existingData[i][0]}|${existingData[i][11]}|${existingData[i][9]}`); 
  }

  const newRows = [];
  let start = 0;
  for (let page = 0; page < 15; page++) {
    const data = _fetchYahooAPI(`https://fantasysports.yahooapis.com/fantasy/v2/league/${leagueKey}/transactions;start=${start}?format=json`);
    const transactions = data?.fantasy_content?.league?.[1]?.transactions;
    if (!transactions || transactions.count === 0) break;

    let allExisting = true;
    for (let i = 0; i < transactions.count; i++) {
      const transObj = transactions[i.toString()]?.transaction;
      if (!transObj) continue;

      const meta = transObj[0];
      const players = transObj[1]?.players;
      if (!players || players.count === 0) continue;

      const transId = meta.transaction_id?.toString() || '';
      const rawDate = new Date(meta.timestamp * 1000);
      const dateStr = "'" + Utilities.formatDate(rawDate, timeZone, 'M/d/yyyy');
      const timeStr = Utilities.formatDate(rawDate, timeZone, 'HH:mm:ss');

      for (let p = 0; p < players.count; p++) {
        const rawP = players[p.toString()]?.player;
        if (!rawP) continue;

        let yId = '', pName = '', pTeam = '', tDetails = null;
        rawP.forEach(item => {
          (Array.isArray(item) ? item : [item]).forEach(obj => {
            if (!obj) return;
            if (obj.player_id) yId = obj.player_id.toString();
            if (obj.name?.full) pName = obj.name.full;
            if (obj.editorial_team_abbr) pTeam = obj.editorial_team_abbr.toUpperCase();
            if (obj.transaction_data) tDetails = Array.isArray(obj.transaction_data) ? obj.transaction_data[0] : obj.transaction_data;
          });
        });

        if (!tDetails) continue;

        const srcName = tDetails.source_team_name || '', destName = tDetails.destination_team_name || '';
        const srcId = tDetails.source_team_key?.split('.t.')[1] || '', destId = tDetails.destination_team_key?.split('.t.')[1] || '';
        const srcType = tDetails.source_type || '';

        let action = 'UNKNOWN', t1 = '', m1 = '', r1 = '', t2 = '', m2 = '', r2 = '';

        if (srcName && destName) {
          action = 'Trade';
          t1 = srcId; m1 = tMap[srcId] || ''; r1 = srcName;
          t2 = destId; m2 = tMap[destId] || ''; r2 = destName;
        } else if (destName) {
          action = srcType === 'waivers' ? 'Waivers' : (srcType === 'freeagents' ? 'Free Agency' : 'Add');
          t1 = destId; m1 = tMap[destId] || ''; r1 = destName;
        } else if (srcName) {
          action = 'Drop';
          t1 = srcId; m1 = tMap[srcId] || ''; r1 = srcName;
        }

        const primaryId = resolvePrimaryId(maps, yId, null, null, pName, 'updateYahooTransactions', pTeam);
        const key = `${transId}|${yId}|${action}`;
        
        if (!existingKeys.has(key)) {
          allExisting = false;
          existingKeys.add(key);
          newRows.push([transId, dateStr, timeStr, t1, m1, r1, t2, m2, r2, action, primaryId, yId, pName, pTeam]);
        }
      }
    }
    if (allExisting || transactions.count < 25) break;
    start += 25;
  }

  if (newRows.length > 0) {
    const finalData = existingData.length > 1 ? [existingData[0], ...newRows, ...existingData.slice(1)] : [existingData[0], ...newRows];
    writeToData('_TRANSACTIONS', finalData);
  }
  _updateTimestamp('UPDATE_TRANSACTIONS');
  flushIdMatchingQueue();
}

// ============================================================================
//  YAHOO DRAFT
// ============================================================================

function updateYahooDraft() {
  const ss = getPrimarySS();
  const currentYear = ss.getRangeByName('CURRENT_YEAR')?.getValue();
  const leagueKey = _getLeagueKey();
  if (!leagueKey || !currentYear) return;

  const urlTeams = `https://fantasysports.yahooapis.com/fantasy/v2/league/${leagueKey}/teams?format=json`;
  const urlPicks = `https://fantasysports.yahooapis.com/fantasy/v2/league/${leagueKey}/draftresults?format=json`;
  const [teamData, draftData] = _fetchAllYahooAPI([urlTeams, urlPicks]);
  if (!teamData || !draftData) return;

  const tMap = {};
  const teams = teamData.fantasy_content.league[1].teams;
  for (let i = 0; i < teams.count; i++) {
    const t = teams[i.toString()]?.team?.[0];
    const tId = t?.find(item => item?.team_id)?.team_id;
    const mId = t?.find(item => item?.managers)?.managers?.[0]?.manager?.manager_id;
    const tName = t?.find(item => item?.name)?.name;
    if (tId) tMap[tId.toString()] = { mId, tName };
  }

  const results = draftData.fantasy_content.league[1].draft_results;
  const rawPicks = [];
  for (let i = 0; i < results.count; i++) {
    const r = results[i.toString()]?.draft_result;
    if (r) rawPicks.push({ round: parseInt(r.round), pick: parseInt(r.pick), tKey: r.team_key, pKey: r.player_key });
  }

  if (rawPicks.length === 0) return;

  const pUrls = [];
  for (let i = 0; i < rawPicks.length; i += 25) {
    const keys = rawPicks.slice(i, i + 25).map(r => r.pKey).join(',');
    pUrls.push(`https://fantasysports.yahooapis.com/fantasy/v2/league/${leagueKey}/players;player_keys=${keys}?format=json`);
  }
  
  const pMap = {};
  _fetchAllYahooAPI(pUrls).forEach(res => {
    const pDict = res?.fantasy_content?.league?.[1]?.players;
    if (!pDict) return;
    for (let i = 0; i < pDict.count; i++) {
      const rawP = pDict[i.toString()]?.player;
      if (rawP) {
        const p = _parseYahooPlayer(rawP);
        pMap[p.pKey] = p;
      }
    }
  });

  const maps = getPlayerMaps('YAHOOID');
  const numTeams = teams.count;
  
  const dataRows = [['ROUND', 'PICK', 'OVERALL', 'ADJUSTED', 'TEAM_ID', 'MANAGER_ID', 'ROSTER', 'KEEPER', 'IDPLAYER', 'YAHOOID', 'PLAYER', 'TEAM', 'ELIGIBILITY', 'POSITION', 'IL', 'NA']];
  const displayRows = [];
  let adjCount = 1;

  rawPicks.forEach(pick => {
    const p = pMap[pick.pKey] || {};
    const tId = pick.tKey.split('.t.')[1] || '';
    const mId = tMap[tId]?.mId || '';
    const rName = tMap[tId]?.tName || '';
    
    const primaryId = resolvePrimaryId(maps, p.pId, null, null, p.name, 'updateYahooDraft', p.team);
    const { cleanPositions, isIL, isNA } = _parsePositions(p.positions);

    dataRows.push([pick.round, pick.pick - ((pick.round - 1) * numTeams), pick.pick, p.keeper ? '' : adjCount++, tId, mId, rName, p.keeper, primaryId, p.pId, p.name, p.team, p.positions, cleanPositions, isIL, isNA]);

    displayRows.push([
      pick.round, pick.pick - ((pick.round - 1) * numTeams), pick.pick, p.keeper ? '' : (adjCount - 1),
      `=XLOOKUP(${mId}, MANAGERS_MANAGER_ID, MANAGERS_SHORT_NAME, "")`,
      `=INDEX(ICON_TEAM_LOGOS, MATCH(${tId}, CHOOSECOLS(ICON_TEAM_LOGOS, 1), 0), IF(AND(INDIRECT("I"&ROW()) <> "", $I$1 > 0), 4, 3))`, 
      rName,
      p.keeper ? '=IF(AND(INDIRECT("I"&ROW()) <> "", $I$1 > 0), ICON_K_LIGHT, ICON_K)' : '', p.name,
      p.team ? `=IFERROR(INDEX(MLB_TEAM_LOGOS, ROUNDUP(MATCH("${p.team}", TOCOL(MLB_TEAM_CODES), 0) / COLUMNS(MLB_TEAM_CODES)), MATCH(${currentYear}, MLB_TEAM_YEARS, 0) + IF(AND(INDIRECT("I"&ROW()) <> "", $I$1 > 0), 1, 0)), "${p.team}")` : '',
      cleanPositions, isIL ? '=IF(AND(INDIRECT("I"&ROW()) <> "", $I$1 > 0), ICON_IL_LIGHT, ICON_IL)' : '', isNA ? '=IF(AND(INDIRECT("I"&ROW()) <> "", $I$1 > 0), ICON_NA_LIGHT, ICON_NA)' : ''
    ]);
  });

  writeToData('_DRAFT', dataRows);

  const displaySheet = ss.getSheetByName('Draft');
  if (displaySheet && displayRows.length > 0) {
    if (displaySheet.getLastRow() >= 4) displaySheet.getRange(4, 1, displaySheet.getLastRow() - 3, 13).clearContent();
    displaySheet.getRange(4, 1, displayRows.length, 13).setValues(displayRows);
    displaySheet.getRange(4, 1, displayRows.length, 13).sort({column: 3, ascending: true});
  }
  _updateTimestamp('UPDATE_DRAFTS');
  flushIdMatchingQueue();
}

// ============================================================================
//  YAHOO ROSTERS
// ============================================================================

function updateYahooRosters() {
  const ss = getPrimarySS();
  const leagueKey = _getLeagueKey();
  const currentYear = ss.getRangeByName('CURRENT_YEAR')?.getValue();
  const faRoundRange = ss.getRangeByName('LEAGUE_FA_K_ROUND');
  const faRound = faRoundRange ? parseInt(faRoundRange.getValue()) : 15;
  if (!leagueKey) return;

  const maps = getPlayerMaps('YAHOOID');

  const dataSS = getDataSS();
  const draftMap = {}, transMap = {}, acqMap = {}, abbrMap = {};
  
  if (dataSS) {
    const dSheet = dataSS.getSheetByName('_DRAFT');
    if (dSheet && dSheet.getLastRow() > 1) {
      const dData = dSheet.getDataRange().getValues();
      const h = dData[0].map(x => x.toString().trim().toUpperCase());
      const iId = h.indexOf('IDPLAYER'), iRnd = h.indexOf('ROUND');
      if (iId > -1 && iRnd > -1) {
        for (let i = 1; i < dData.length; i++) {
          if (dData[i][iId]) draftMap[dData[i][iId]] = parseInt(dData[i][iRnd]);
        }
      }
    }

    const tSheet = dataSS.getSheetByName('_TRANSACTIONS');
    if (tSheet && tSheet.getLastRow() > 1) {
      const tData = tSheet.getDataRange().getDisplayValues();
      const h = tData[0].map(x => x.toString().trim().toUpperCase());
      const iId = h.indexOf('IDPLAYER'), iType = h.indexOf('ACTION'), iDate = h.indexOf('DATE'), iRoster = h.indexOf('ROSTER'), iTid = h.indexOf('TEAM_ID');
      if (iId > -1 && iType > -1) {
        for (let i = 1; i < tData.length; i++) {
          const id = tData[i][iId];
          if (id && !transMap[id]) {
            transMap[id] = { type: tData[i][iType], date: tData[i][iDate], sourceTeam: tData[i][iRoster], sourceTeamId: tData[i][iTid] };
          }
        }
      }
    }

    const aSheet = dataSS.getSheetByName('_ACQUIRED');
    if (aSheet && aSheet.getLastRow() > 1) {
      const aData = aSheet.getDataRange().getDisplayValues();
      const h = aData[0].map(x => x.toString().trim().toUpperCase());
      const iId = h.indexOf('IDPLAYER'), iVia = h.indexOf('ACQUIRED'), iDate = h.indexOf('DATE'), iRnd = h.indexOf('ROUND');
      
      if (iId > -1 && iVia > -1) {
        for (let i = 1; i < aData.length; i++) {
          if (aData[i][iId]) {
            acqMap[aData[i][iId]] = { 
              via: aData[i][iVia], 
              date: aData[i][iDate],
              round: aData[i][iRnd]
            };
          }
        }
      }
    }
  }

  const mSheet = ss.getSheetByName('Managers');
  if (mSheet && mSheet.getLastRow() >= 4) {
    const mData = mSheet.getRange(4, 1, mSheet.getLastRow() - 3, 7).getValues();
    mData.forEach(r => {
      const abbr = r[3];
      if (abbr) { 
        if (r[6]) abbrMap[r[6].toString()] = abbr; 
        if (r[2]) abbrMap[r[2].toString()] = abbr; 
      }
    });
  }

  const rData = _fetchYahooAPI(`https://fantasysports.yahooapis.com/fantasy/v2/league/${leagueKey}/teams;out=roster/players?format=json`);
  const teamsDict = rData?.fantasy_content?.league?.[1]?.teams;
  if (!teamsDict) return;

  const outputRows = [['TEAM_ID', 'MANAGER_ID', 'ROSTER', 'IDPLAYER', 'YAHOOID', 'PLAYER', 'TEAM', 'ELIGIBILITY', 'POSITION', 'IL', 'NA', 'KEEPER', 'ROUND', 'ACQUIRED', 'DATE']];

  for (let t = 0; t < teamsDict.count; t++) {
    const teamData = teamsDict[t.toString()]?.team;
    if (!teamData) continue;

    let rName = '', tId = '', mId = '', players = null;
    teamData.forEach(item => {
      if (Array.isArray(item)) {
        item.forEach(meta => {
          if (!meta) return;
          if (meta.name) rName = meta.name;
          if (meta.team_id) tId = meta.team_id.toString();
          if (meta.managers) mId = meta.managers[0]?.manager?.manager_id?.toString() || '';
        });
      } else if (item?.roster) players = item.roster['0']?.players;
    });

    if (!players) continue;

    for (let p = 0; p < players.count; p++) {
      const rawP = players[p.toString()]?.player;
      if (!rawP) continue;

      const pObj = _parseYahooPlayer(rawP);
      const primaryId = resolvePrimaryId(maps, pObj.pId, null, null, pObj.name, 'updateYahooRosters', pObj.team);
      const { cleanPositions, isIL, isNA } = _parsePositions(pObj.positions);

      const trans = primaryId ? (transMap[primaryId] || {}) : {};
      const tType = trans.type || '';
      const tDate = trans.date || '';
      const sourceAbbr = trans.sourceTeamId ? abbrMap[trans.sourceTeamId] : (abbrMap[trans.sourceTeam] || trans.sourceTeam);

      const acq = primaryId ? (acqMap[primaryId] || {}) : {};
      let aVia = '', aDate = '';

      if (pObj.keeper) {
        aVia = acq.via || (`${currentYear - 1} Draft`);
        aDate = acq.via ? acq.date : '';
        if (aVia.toUpperCase() === 'DRAFT') {
          let yr = aDate.replace(/'/g, '').trim();
          aVia = `${yr.length >= 4 ? yr.slice(-4) : (currentYear - 1)} Draft`;
          aDate = '';
        }
        if (aVia.toUpperCase().startsWith('TRADE')) aVia = aVia.replace(/Trade \((.*?)\)/i, 'Trade w/ $1');
      } else {
        if (tType === '') {
          // FIX: Only label them as "Draft" if they actually exist in the current year's draft map.
          // Otherwise, if they have no transaction history and weren't drafted, they are a Free Agent.
          aVia = (primaryId && draftMap[primaryId]) ? `${currentYear} Draft` : 'Free Agency';
        }
        else if (tType.toUpperCase() === 'TRADE') { 
          aVia = sourceAbbr ? `Trade w/ ${sourceAbbr}` : 'Trade'; 
          aDate = tDate; 
        } else { 
          aVia = tType; 
          aDate = tDate; 
        }
      }

      let savedRound = null;
      if (primaryId && acqMap[primaryId]?.round) {
        const parsed = parseInt(acqMap[primaryId].round, 10);
        if (!isNaN(parsed)) savedRound = parsed;
      }

      let round;
      if (pObj.keeper) {
        round = savedRound || faRound;
      } else if (primaryId && draftMap[primaryId]) {
        round = draftMap[primaryId];
      } else if (tType.toUpperCase() === 'TRADE' || aVia.toUpperCase().includes('TRADE')) {
        round = savedRound || faRound;
      } else {
        round = faRound;
      }

      outputRows.push([tId, mId, rName, primaryId, pObj.pId, pObj.name, pObj.team, pObj.positions, cleanPositions, isIL, isNA, pObj.keeper, round, aVia, aDate]);
    }
  }

  writeToData('_ROSTERS', outputRows);
  _updateTimestamp('UPDATE_ROSTERS');
  flushIdMatchingQueue();
}