/**
 * FILE: updateTransactions.gs
 * PURPOSE: Fetches the complete transaction history for the league
 * from the Yahoo Fantasy Sports API and maintains an
 * incremental log in _TRANSACTIONS. New transactions are
 * prepended so the most recent always appear at the top.
 * Existing transactions are never overwritten or deleted.
 *
 * This script OWNS all transaction data. No other script
 * fetches transaction data from Yahoo — they read from
 * _TRANSACTIONS instead. This is enforced by the execution
 * order in triggerGroups.gs where updateTransactions() runs
 * before any script that depends on transaction data.
 *
 * READS FROM: Yahoo Fantasy Sports API (transactions endpoint)
 * _TRANSACTIONS (Data WB) — existing rows for deduplication
 * Managers sheet (Master WB) — team ID → manager ID mapping
 * WRITES TO:  _TRANSACTIONS (Data WB)
 * CALLED BY:  commonUpdates() in triggerGroups.gs
 * Must run BEFORE updateRosters() in execution order
 * DEPENDENCIES: helperFunctions.gs, playerResolution.gs,
 * yahooAuthentication.gs
 *
 * OUTPUT SCHEMA (_TRANSACTIONS):
 * Col A  TRANSACTION_ID — Yahoo transaction ID (deduplication key)
 * Col B  DATE           — formatted M/d/yyyy
 * Col C  TIME           — formatted HH:mm:ss
 * Col D  TEAM_ID        — Yahoo team ID of the acting manager (or Source team in trade)
 * Col E  MANAGER_ID     — Yahoo manager ID of the acting manager (or Source team in trade)
 * Col F  MANAGER        — Team name display string (or Source team in trade)
 * Col G  TEAM_ID_2      — Yahoo team ID of Destination team (Trades only)
 * Col H  MANAGER_ID_2   — Yahoo manager ID of Destination team (Trades only)
 * Col I  MANAGER_2      — Team name display string of Destination team (Trades only)
 * Col J  TYPE           — ADD, DROP, Waivers, Free Agency, or TRADE
 * Col K  IDPLAYER       — Master BBREF ID
 * Col L  PLAYER         — Player display name
 * Col M  MLB_TEAM       — Player's MLB team abbreviation
 * Col N  ELIGIBILITY    — Full eligibility string including IL/NA
 * Col O  POSITION       — Clean eligibility string (IL/NA stripped)
 * Col P  IL             — TRUE if player has IL eligibility
 * Col Q  NA             — TRUE if player has NA eligibility (minors)
 *
 * DEDUPLICATION:
 * Keyed on TRANSACTION_ID + PLAYER + TYPE (composite key).
 * This handles trades correctly — a single trade transaction ID
 * contains multiple players moving in opposite directions, each
 * needing their own row with the same transaction ID.
 *
 * PAGINATION:
 * Yahoo returns transactions in pages of 25. The script fetches
 * pages sequentially until it finds a page where every transaction
 * already exists in _TRANSACTIONS, at which point it stops.
 * On first run it fetches all available history (typically
 * Yahoo caps at ~250 most recent transactions).
 */

// ============================================================
//  CONSTANTS
// ============================================================

const TRANSACTIONS_SHEET  = '_TRANSACTIONS';
const TRANSACTIONS_HEADERS = [
  'TRANSACTION_ID', 'DATE', 'TIME', 'TEAM_ID', 'MANAGER_ID', 'MANAGER', 
  'TEAM_ID_2', 'MANAGER_ID_2', 'MANAGER_2', // NEW COLUMNS
  'TYPE', 'IDPLAYER', 'PLAYER', 'MLB_TEAM',
  'ELIGIBILITY', 'POSITION', 'IL', 'NA'
];

// Number of transactions Yahoo returns per page
const TRANSACTIONS_PAGE_SIZE = 25;

// Maximum pages to fetch in a single execution.
// Yahoo caps history at ~250 transactions (10 pages).
// Set higher than needed as a safety ceiling.
const TRANSACTIONS_MAX_PAGES = 15;


// ============================================================
//  MAIN FUNCTION
// ============================================================

function updateTransactions() {
  const leagueKey = getLeagueKey();
  if (!leagueKey) {
    Logger.log('updateTransactions: no league key found. Aborting.');
    return;
  }

  const maps     = getPlayerMaps('YAHOOID');
  const timeZone = Session.getScriptTimeZone();

  // Step 1 — Build team ID → manager ID map
  const teamToManagerMap = _buildTeamToManagerMap(leagueKey);

  // Step 2 — Load existing data for deduplication
  const { existingData, existingKeys } = _loadExistingTransactions();

  // Step 3 — Fetch new transactions from Yahoo
  const newRows = _fetchNewTransactions(
    leagueKey, maps, teamToManagerMap, existingKeys, timeZone
  );

  if (newRows.length === 0) {
    Logger.log('updateTransactions: no new transactions found.');
    updateTimestamp('UPDATE_TRANSACTIONS');
    return;
  }

  // Step 4 — Prepend new rows to existing data and write
  const outputData = existingData.length > 1
    ? [TRANSACTIONS_HEADERS, ...newRows, ...existingData.slice(1)]
    : [TRANSACTIONS_HEADERS, ...newRows];

  writeToData(TRANSACTIONS_SHEET, outputData);
  Logger.log('updateTransactions: added ' + newRows.length + ' new transaction rows.');

  // Step 5 — Timestamp
  updateTimestamp('UPDATE_TRANSACTIONS')
  flushIdMatchingQueue();
}


// ============================================================
//  TEAM → MANAGER MAP
// ============================================================

function _buildTeamToManagerMap(leagueKey) {
  const url      = `https://fantasysports.yahooapis.com/fantasy/v2/league/${leagueKey}/teams?format=json`;
  const data     = fetchYahooAPI(url);
  const teamMap  = {};

  if (!data) {
    Logger.log('_buildTeamToManagerMap: fetch failed. Manager IDs will be empty.');
    return teamMap;
  }

  const teams = data.fantasy_content?.league?.[1]?.teams;
  if (!teams) return teamMap;

  for (let i = 0; i < teams.count; i++) {
    const t   = teams[i.toString()]?.team?.[0];
    const tId = t?.find(item => item?.team_id)?.team_id;
    const mId = t?.find(item => item?.managers)?.managers?.[0]?.manager?.manager_id;
    if (tId && mId) teamMap[tId.toString()] = mId.toString();
  }

  Logger.log('_buildTeamToManagerMap: mapped ' + Object.keys(teamMap).length + ' teams.');
  return teamMap;
}


// ============================================================
//  EXISTING DATA LOADER
// ============================================================

function _loadExistingTransactions() {
  const dataSS = getDataSS();
  const sheet  = dataSS?.getSheetByName(TRANSACTIONS_SHEET);

  if (!sheet || sheet.getLastRow() < 2) {
    Logger.log('_loadExistingTransactions: sheet empty or missing. Starting fresh.');
    return {
      existingData: [TRANSACTIONS_HEADERS],
      existingKeys: new Set()
    };
  }

  const existingData = sheet.getDataRange().getDisplayValues();
  const existingKeys = new Set();

  // Build composite key from TRANSACTION_ID (col 0) + PLAYER (col 11) + TYPE (col 9)
  for (let i = 1; i < existingData.length; i++) {
    const row = existingData[i];
    const key = row[0] + '|' + row[11] + '|' + row[9];
    existingKeys.add(key);
  }

  Logger.log('_loadExistingTransactions: loaded ' + (existingData.length - 1) +
             ' existing rows, ' + existingKeys.size + ' unique keys.');
  return { existingData, existingKeys };
}


// ============================================================
//  TRANSACTION FETCHER
// ============================================================

function _fetchNewTransactions(leagueKey, maps, teamToManagerMap, existingKeys, timeZone) {
  const newRows = [];
  let   start   = 0;

  for (let page = 0; page < TRANSACTIONS_MAX_PAGES; page++) {
    const url  = `https://fantasysports.yahooapis.com/fantasy/v2/league/${leagueKey}/transactions;start=${start}?format=json`;
    const data = fetchYahooAPI(url);

    if (!data) {
      Logger.log('_fetchNewTransactions: fetch failed at start=' + start + '. Stopping.');
      break;
    }

    const transactions = data.fantasy_content?.league?.[1]?.transactions;

    if (Array.isArray(transactions) || !transactions || transactions.count === 0) {
      Logger.log('_fetchNewTransactions: no transactions returned at start=' + start + '.');
      break;
    }

    const pageRows    = [];
    let   allExisting = true;

    for (let i = 0; i < transactions.count; i++) {
      const transObj = transactions[i.toString()]?.transaction;
      if (!transObj) continue;

      const rows = _parseTransactionRows(
        transObj, maps, teamToManagerMap, timeZone
      );

      rows.forEach(row => {
        // Key uses index 11 (Player) and 9 (Type) due to new columns
        const key = row[0] + '|' + row[11] + '|' + row[9];
        if (!existingKeys.has(key)) {
          allExisting = false;
          pageRows.push(row);
          existingKeys.add(key); 
        }
      });
    }

    newRows.push(...pageRows);

    if (allExisting) {
      Logger.log('_fetchNewTransactions: reached existing history at start=' + start + '. Stopping.');
      break;
    }

    if (transactions.count < TRANSACTIONS_PAGE_SIZE) {
      Logger.log('_fetchNewTransactions: last page reached at start=' + start + '.');
      break;
    }

    start += TRANSACTIONS_PAGE_SIZE;
  }

  return newRows;
}


// ============================================================
//  TRANSACTION PARSER
// ============================================================

function _parseTransactionRows(transObj, maps, teamToManagerMap, timeZone) {
  const rows    = [];
  const meta    = transObj[0];
  const players = transObj[1]?.players;

  if (!meta || !players || players.count === 0) return rows;

  const transId = meta.transaction_id?.toString() || '';
  const rawDate = new Date(meta.timestamp * 1000);
  
  // ---> CHANGED: Force text with apostrophe so Sheets doesn't auto-format
  const dateStr = "'" + Utilities.formatDate(rawDate, timeZone, 'M/d/yyyy');
  const timeStr = Utilities.formatDate(rawDate, timeZone, 'HH:mm:ss');

  for (let p = 0; p < players.count; p++) {
    const pData = players[p.toString()]?.player;
    if (!pData) continue;

    let pName    = '';
    let pTeam    = '';
    let pElig    = '';
    let yId      = null;
    let tDetails = null;

    for (let j = 0; j < pData.length; j++) {
      const item   = pData[j];
      const target = Array.isArray(item) ? item : [item];

      target.forEach(obj => {
        if (!obj) return;
        if (obj.player_id)        yId      = obj.player_id.toString();
        if (obj.name?.full)       pName    = obj.name.full;
        if (obj.editorial_team_abbr) pTeam = obj.editorial_team_abbr.toUpperCase();
        if (obj.display_position) pElig    = obj.display_position;
        if (obj.transaction_data) tDetails = obj.transaction_data;
      });
    }

    if (Array.isArray(tDetails)) tDetails = tDetails[0];
    if (!tDetails) continue;

    const srcTeamName  = tDetails.source_team_name      || '';
    const destTeamName = tDetails.destination_team_name || '';
    const srcTeamKey   = tDetails.source_team_key       || '';
    const destTeamKey  = tDetails.destination_team_key  || '';
    const sourceType   = tDetails.source_type           || '';

    const parseTeamId = (key) => key ? key.split('.t.')[1] || '' : '';
    const srcId  = parseTeamId(srcTeamKey);
    const destId = parseTeamId(destTeamKey);

    let teamId = '', managerId = '', managerDisplay = '';
    let teamId2 = '', managerId2 = '', managerDisplay2 = '';
    let actionType = 'UNKNOWN';

    // Route logic for specific action types
    if (srcTeamName && destTeamName) {
      // TRADE
      actionType      = 'Trade';
      
      // Team 1 is the Source (giving up the player)
      teamId          = srcId;
      managerDisplay  = srcTeamName;
      managerId       = teamToManagerMap[srcId] || '';
      
      // Team 2 is the Destination (receiving the player)
      teamId2         = destId;
      managerDisplay2 = destTeamName;
      managerId2      = teamToManagerMap[destId] || '';

    } else if (destTeamName) {
      // ADD (Waivers or Free Agency)
      if (sourceType === 'waivers') {
        actionType = 'Waivers';
      } else if (sourceType === 'freeagents') {
        actionType = 'Free Agency';
      } else {
        actionType = 'Add'; 
      }
      
      teamId         = destId;
      managerDisplay = destTeamName;
      managerId      = teamToManagerMap[destId] || '';
      
    } else if (srcTeamName) {
      // DROP
      actionType     = 'Drop';
      
      teamId         = srcId;
      managerDisplay = srcTeamName;
      managerId      = teamToManagerMap[srcId] || '';
    }

    const masterId = resolveMasterId(maps, yId, null, pName, 'updateTransactions', pTeam);

    // Parse position eligibility
    const { cleanPositions, isIL, isNA } = parsePositions(pElig);

    rows.push([
      transId,
      dateStr,
      timeStr,
      teamId,
      managerId,
      managerDisplay,
      teamId2,         // NEW
      managerId2,      // NEW
      managerDisplay2, // NEW
      actionType,
      masterId,
      pName,
      pTeam,
      pElig,
      cleanPositions,
      isIL,
      isNA
    ]);
  }

  return rows;
}