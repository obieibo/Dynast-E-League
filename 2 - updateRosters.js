/**
 * FILE: updateRosters.gs
 * PURPOSE: Fetches all rostered players across all 12 fantasy teams
 * from the Yahoo Fantasy Sports API and writes a comprehensive
 * roster snapshot to _ROSTERS in the Data workbook.
 *
 * This script deliberately does NOT fetch transaction data or
 * draft results from Yahoo — it reads those outputs from
 * _TRANSACTIONS and _DRAFT instead. This enforces the
 * fetch-once principle: updateTransactions() and updateDraft()
 * own that data and must run before this script in the
 * execution order defined in triggerGroups.gs.
 */


// ============================================================
//  CONSTANTS
// ============================================================

const ROSTERS_SHEET   = '_ROSTERS';
const ROSTERS_HEADERS = [
  'IDPLAYER', 'PLAYER', 'MLB_TEAM', 'ELIGIBILITY', 'POSITION',
  'IL', 'NA', 'STATUS', 'TEAM_ID', 'MANAGER_ID', 'ROSTER',
  'TRANSACTION', 'TRANS_DATE', 'KEEPER', 'ROUND',
  'ACQUIRED', 'DATE'
];


// ============================================================
//  MAIN FUNCTION
// ============================================================

function updateRosters() {
  const ss = getPrimarySS(); 

  const leagueKey   = getLeagueKey();
  const currentYear = ss.getRangeByName('CURRENT_YEAR')?.getValue();
  const faRound     = ss.getRangeByName('LEAGUE_FA_K_ROUND')?.getValue() || 15;

  if (!leagueKey) {
    Logger.log('updateRosters: no league key found. Aborting.');
    return;
  }

  const maps = getPlayerMaps('YAHOOID');

  // Load supporting data from Data workbook & Managers map
  const draftRoundMap   = _loadDraftRoundMap();
  const transactionMap  = _loadLatestTransactionMap();
  const acquiredMap     = _loadAcquiredMap(); // No longer requires current year
  const abbrMap         = _loadTeamAbbreviationMap(ss); 

  // Fetch all rosters from Yahoo
  const rosterPayload = fetchYahooAPI(
    `https://fantasysports.yahooapis.com/fantasy/v2/league/${leagueKey}/teams;out=roster/players?format=json`
  );

  if (!rosterPayload) {
    Logger.log('updateRosters: Yahoo roster fetch failed. Aborting.');
    return;
  }

  // Parse rosters and build output rows
  const outputRows = _parseAllRosters(
    rosterPayload, maps, draftRoundMap, transactionMap, acquiredMap, faRound, currentYear, abbrMap
  );

  // Write to Data workbook
  writeToData(ROSTERS_SHEET, [ROSTERS_HEADERS, ...outputRows]);
  Logger.log('updateRosters: wrote ' + outputRows.length + ' rostered players.');

  // Timestamp
  updateTimestamp('UPDATE_ROSTERS');
  flushIdMatchingQueue();
}


// ============================================================
//  SUPPORTING DATA LOADERS
// ============================================================

function _loadDraftRoundMap() {
  const dataSS = getDataSS();
  const sheet  = dataSS?.getSheetByName('_DRAFT');

  if (!sheet || sheet.getLastRow() < 2) {
    Logger.log('_loadDraftRoundMap: _DRAFT empty or missing. Run updateDraft() first.');
    return {};
  }

  const data    = sheet.getDataRange().getValues();
  const headers = data[0].map(h => h.toString().trim().toUpperCase());
  const iId     = headers.indexOf('IDPLAYER');
  const iRound  = headers.indexOf('ROUND');

  if (iId === -1 || iRound === -1) {
    Logger.log('_loadDraftRoundMap: required columns missing from _DRAFT.');
    return {};
  }

  const draftMap = {};
  for (let i = 1; i < data.length; i++) {
    const id    = data[i][iId]    ? data[i][iId].toString().trim()    : '';
    const round = data[i][iRound] ? parseInt(data[i][iRound])         : 0;
    if (id && round) draftMap[id] = round;
  }

  return draftMap;
}


function _loadLatestTransactionMap() {
  const dataSS = getDataSS();
  const sheet  = dataSS?.getSheetByName('_TRANSACTIONS');

  if (!sheet || sheet.getLastRow() < 2) {
    Logger.log('_loadLatestTransactionMap: _TRANSACTIONS empty or missing.');
    return {};
  }

  const data    = sheet.getDataRange().getDisplayValues();
  const headers = data[0].map(h => h.toString().trim().toUpperCase());
  const iId     = headers.indexOf('IDPLAYER');
  const iType   = headers.indexOf('TYPE');
  const iDate   = headers.indexOf('DATE');
  const iManager= headers.indexOf('MANAGER'); 
  const iTeamId = headers.indexOf('TEAM_ID'); 

  if (iId === -1 || iType === -1 || iDate === -1) {
    Logger.log('_loadLatestTransactionMap: required columns missing from _TRANSACTIONS.');
    return {};
  }

  const transMap = {};
  for (let i = 1; i < data.length; i++) {
    const id           = data[i][iId]      ? data[i][iId].toString().trim()      : '';
    const type         = data[i][iType]    ? data[i][iType].toString().trim()    : '';
    const date         = data[i][iDate]    ? data[i][iDate].toString().trim()    : '';
    const sourceTeam   = iManager !== -1 && data[i][iManager] ? data[i][iManager].toString().trim() : '';
    const sourceTeamId = iTeamId  !== -1 && data[i][iTeamId]  ? data[i][iTeamId].toString().trim()  : '';
    
    // First occurrence = most recent (rows are newest-first)
    if (id && !transMap[id]) {
      transMap[id] = { type, date, sourceTeam, sourceTeamId };
    }
  }

  if (Object.keys(transMap).length === 0) {
    Logger.log('WARNING: _loadLatestTransactionMap found no transaction records.');
  }
  
  return transMap;
}


function _loadAcquiredMap() {
  const dataSS = getDataSS();
  const sheet  = dataSS?.getSheetByName('_ACQUIRED');

  if (!sheet || sheet.getLastRow() < 2) {
    Logger.log('_loadAcquiredMap: _ACQUIRED empty or missing. Will populate after saveAcquired() runs.');
    return {};
  }

  const data    = sheet.getDataRange().getDisplayValues();
  const headers = data[0].map(h => h.toString().trim().toUpperCase());
  const iId     = headers.indexOf('IDPLAYER');
  const iVia    = headers.indexOf('ACQUIRED'); 
  const iDate   = headers.indexOf('DATE');     

  if (iId === -1 || iVia === -1) {
    Logger.log('_loadAcquiredMap: required columns missing from _ACQUIRED.');
    return {};
  }

  const acquiredMap = {};
  for (let i = 1; i < data.length; i++) {
    // REMOVED YEAR FILTERING: We want to load previous year keeper records too!
    const id   = data[i][iId]   ? data[i][iId].toString().trim()   : '';
    const via  = data[i][iVia]  ? data[i][iVia].toString().trim()  : '';
    const date = iDate !== -1 && data[i][iDate] ? data[i][iDate].toString().trim() : '';

    if (id && via) acquiredMap[id] = { via, date };
  }

  return acquiredMap;
}


function _loadTeamAbbreviationMap(ss) {
  const abbrMap = {};
  const sheet = ss.getSheetByName('Managers');
  if (!sheet) return abbrMap;

  const data = sheet.getDataRange().getValues();
  
  for (let i = 3; i < data.length; i++) {
    const teamName = data[i][2] ? data[i][2].toString().trim() : ''; // Col C
    const abbr     = data[i][3] ? data[i][3].toString().trim() : ''; // Col D
    const teamId   = data[i][6] ? data[i][6].toString().trim() : ''; // Col G

    if (abbr) {
      if (teamId && !abbrMap[teamId]) abbrMap[teamId] = abbr;
      if (teamName && !abbrMap[teamName]) abbrMap[teamName] = abbr;
    }
  }
  return abbrMap;
}


// ============================================================
//  ROSTER PARSER
// ============================================================

function _parseAllRosters(
  rosterPayload, maps, draftRoundMap, transactionMap, acquiredMap, faRound, currentYear, abbrMap
) {
  const outputRows = [];
  const teamsDict  = rosterPayload?.fantasy_content?.league?.[1]?.teams;

  if (!teamsDict) {
    Logger.log('_parseAllRosters: no teams data found in Yahoo response.');
    return outputRows;
  }

  const numTeams = teamsDict.count || 0;

  for (let t = 0; t < numTeams; t++) {
    const teamData = teamsDict[t.toString()]?.team;
    if (!teamData) continue;

    // Extract team metadata
    let fantasyTeam = '', teamId = '', managerId = '', rosterPlayers = null;

    teamData.forEach(item => {
      if (Array.isArray(item)) {
        item.forEach(meta => {
          if (!meta) return;
          if (meta.name)     fantasyTeam = meta.name;
          if (meta.team_id)  teamId      = meta.team_id.toString();
          if (meta.managers) managerId   = meta.managers[0]?.manager?.manager_id?.toString() || '';
        });
      } else if (item?.roster) {
        rosterPlayers = item.roster['0']?.players;
      }
    });

    if (!rosterPlayers) continue;

    const playerCount = rosterPlayers.count || 0;

    for (let p = 0; p < playerCount; p++) {
      const playerData = rosterPlayers[p.toString()]?.player;
      if (!playerData) continue;

      const parsed   = parseYahooPlayer(playerData);
      const masterId = resolveMasterId(maps, parsed.pId, null, parsed.name, 'updateRosters', parsed.team);

      const { cleanPositions, isIL, isNA } = parsePositions(parsed.positions);

      // Transaction data
      const trans         = transactionMap[masterId] || {};
      const transType     = trans.type || '';
      const transDate     = _formatDateOrYear(trans.date || '');
      const transSource   = trans.sourceTeam || ''; 
      const transSourceId = trans.sourceTeamId || ''; 
      
      const sourceAbbr    = abbrMap[transSourceId] || abbrMap[transSource] || transSource;

      // Acquisition data
      const acq          = acquiredMap[masterId] || {};
      const acqVia       = acq.via  || '';
      const acqDate      = _formatDateOrYear(acq.date || '');

      let acquiredVia  = '';
      let acquiredDate = '';

      if (parsed.keeper === 'K') {
        acquiredVia  = acqVia || (`${currentYear - 1} Draft`);
        acquiredDate = acqVia ? acqDate : '';
        
        if (acquiredVia.toUpperCase() === 'DRAFT') {
          let yr = acquiredDate.replace(/'/g, '').trim();
          if (yr.length >= 4) yr = yr.slice(-4);
          else yr = (currentYear - 1).toString();
          
          acquiredVia  = `${yr} Draft`;
          acquiredDate = '';
        }
        
        if (acquiredVia.toUpperCase().startsWith('TRADE')) {
          acquiredVia = acquiredVia.replace(/Trade \((.*?)\)/i, 'Trade w/ $1');
        }
      } else {
        if (transType === '') {
          acquiredVia  = `${currentYear} Draft`;
          acquiredDate = '';
        } else if (transType.toUpperCase() === 'TRADE') {
          acquiredVia  = sourceAbbr ? `Trade w/ ${sourceAbbr}` : 'Trade';
          acquiredDate = transDate;
        } else {
          acquiredVia  = transType;
          acquiredDate = transDate;
        }
      }

      const isFaOrWaiver = _isFaOrWaiverAcquisition(transType, acquiredVia);
      let   round        = isFaOrWaiver ? faRound : (draftRoundMap[masterId] || faRound);

      outputRows.push([
        masterId,
        parsed.name,
        parsed.team,
        parsed.positions,
        cleanPositions,
        isIL,
        isNA,
        'Rostered',
        teamId,
        managerId,
        fantasyTeam,
        transType,
        transDate,       
        parsed.keeper,
        round,
        acquiredVia,
        acquiredDate     
      ]);
    }
  }

  Logger.log('_parseAllRosters: parsed ' + outputRows.length + ' rostered players across ' + numTeams + ' teams.');
  return outputRows;
}


// ============================================================
//  ACQUISITION HELPERS
// ============================================================

function _isFaOrWaiverAcquisition(transType, acquiredVia) {
  const faKeywords = ['free', 'waiv', 'add'];
  const transLower   = transType.toLowerCase();
  const acquiredLower = acquiredVia.toLowerCase();
  return faKeywords.some(kw => transLower.includes(kw) || acquiredLower.includes(kw));
}


// ============================================================
//  DATE FORMATTER
// ============================================================

function _formatDateOrYear(val) {
  if (!val) return '';
  
  const strVal = val.toString().trim().replace(/^'/, '');
  
  if (/^\d{4}$/.test(strVal)) return "'" + strVal;
  
  if (/^\d{5}(\.\d+)?$/.test(strVal)) {
    const serialNum = parseFloat(strVal);
    const d = new Date(Math.round((serialNum - 25569) * 86400000));
    const utcDate = new Date(d.getTime() + d.getTimezoneOffset() * 60000);
    return "'" + Utilities.formatDate(utcDate, Session.getScriptTimeZone(), 'M/d/yyyy');
  }
  
  const parsedDate = new Date(strVal);
  if (!isNaN(parsedDate.getTime())) {
    return "'" + Utilities.formatDate(parsedDate, Session.getScriptTimeZone(), 'M/d/yyyy');
  }
  
  return "'" + strVal;
}