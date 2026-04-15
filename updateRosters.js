/**
 * FILE: updateRosters.gs
 * PURPOSE: Fetches all rostered players across all 12 fantasy teams
 *          from the Yahoo Fantasy Sports API and writes a comprehensive
 *          roster snapshot to _ROSTERS in the Data workbook.
 *
 *          This script deliberately does NOT fetch transaction data or
 *          draft results from Yahoo — it reads those outputs from
 *          _TRANSACTIONS and _DRAFT instead. This enforces the
 *          fetch-once principle: updateTransactions() and updateDraft()
 *          own that data and must run before this script in the
 *          execution order defined in triggerGroups.gs.
 *
 * READS FROM: Yahoo Fantasy Sports API (teams/roster/players endpoint)
 *             _TRANSACTIONS (Data WB) — for acquisition history
 *             _DRAFT (Data WB)        — for original draft round
 *             _ACQUIRED (Data WB)     — for persistent acquisition tracking
 *             Named ranges: CURRENT_YEAR, LEAGUE_FA_K_ROUND
 * WRITES TO:  _ROSTERS (Data WB)
 * CALLED BY:  commonUpdates() in triggerGroups.gs
 *             Must run AFTER updateTransactions() and updateDraft()
 * DEPENDENCIES: helperFunctions.gs, playerResolution.gs,
 *               yahooAuthentication.gs
 *
 * OUTPUT SCHEMA (_ROSTERS):
 *   Col A  IDPLAYER       — Master BBREF ID
 *   Col B  PLAYER         — Player display name
 *   Col C  MLB_TEAM       — MLB team abbreviation
 *   Col D  ELIGIBILITY    — Full eligibility string including IL/NA
 *   Col E  POSITION       — Clean eligibility string (IL/NA stripped)
 *   Col F  IL             — TRUE if player has IL eligibility
 *   Col G  NA             — TRUE if player has NA eligibility (minors)
 *   Col H  STATUS         — 'Rostered'
 *   Col I  TEAM_ID        — Yahoo fantasy team ID
 *   Col J  MANAGER_ID     — Yahoo manager ID
 *   Col K  ROSTER         — Fantasy team display name
 *   Col L  TRANSACTION    — Most recent transaction type (ADD, DROP, TRADE)
 *   Col M  TRANS_DATE     — Most recent transaction date
 *   Col N  KEEPER         — 'K' if keeper, '' if not
 *   Col O  ROUND          — Original draft round (from _DRAFT)
 *   Col P  ACQUIRED_VIA   — How player was acquired (Draft, Free Agency, etc.)
 *   Col Q  ACQUIRED_DATE  — Date player was acquired by current team
 *
 * ROUND LOGIC:
 *   If player was drafted: original draft round from _DRAFT
 *   If player was added via free agency or waivers: LEAGUE_FA_K_ROUND
 *   LEAGUE_FA_K_ROUND is the round used for keeper eligibility
 *   calculations for waiver/FA acquisitions (typically round 15+)
 *   The keeper -1 round adjustment is NOT applied here — it is a
 *   derived calculation built downstream on top of this raw round value
 *
 * ACQUISITION TRACKING:
 *   _ACQUIRED is a persistent log maintained by saveAcquired.gs.
 *   It stores how each player was acquired by their current team
 *   (Draft, Free Agency, Waivers, Trade) and when.
 *   This script reads _ACQUIRED to populate ACQUIRED_VIA and
 *   ACQUIRED_DATE — it does not write to _ACQUIRED directly.
 *   saveAcquired.gs reads _ROSTERS output and writes to _ACQUIRED.
 */


// ============================================================
//  CONSTANTS
// ============================================================

const ROSTERS_SHEET   = '_ROSTERS';
const ROSTERS_HEADERS = [
  'IDPLAYER', 'PLAYER', 'MLB_TEAM', 'ELIGIBILITY', 'POSITION',
  'IL', 'NA', 'STATUS', 'TEAM_ID', 'MANAGER_ID', 'ROSTER',
  'TRANSACTION', 'TRANS_DATE', 'KEEPER', 'ROUND',
  'ACQUIRED_VIA', 'ACQUIRED_DATE'
];


// ============================================================
//  MAIN FUNCTION
// ============================================================

/**
 * Fetches all rostered players from Yahoo, enriches each player
 * with draft round, transaction history, and acquisition data
 * from existing Data workbook sheets, then writes the complete
 * roster snapshot to _ROSTERS.
 *
 * Execution steps:
 *   1. Read settings (year, FA round, league key)
 *   2. Build player resolution maps
 *   3. Load supporting data from _DRAFT, _TRANSACTIONS, _ACQUIRED
 *   4. Fetch all rosters from Yahoo in a single API call
 *   5. Parse each rostered player and enrich with supporting data
 *   6. Write output to _ROSTERS
 *   7. Stamp UPDATE_ROSTERS timestamp
 */
function updateRosters() {
  const ss = getMasterSS();

  const leagueKey  = getLeagueKey();
  const currentYear = ss.getRangeByName('CURRENT_YEAR')?.getValue();
  const faRound     = ss.getRangeByName('LEAGUE_FA_K_ROUND')?.getValue() || 15;

  if (!leagueKey) {
    Logger.log('updateRosters: no league key found. Aborting.');
    return;
  }

  const maps = getPlayerMaps('YAHOOID');

  // Step 3 — Load supporting data from Data workbook
  const draftRoundMap   = _loadDraftRoundMap();
  const transactionMap  = _loadLatestTransactionMap();
  const acquiredMap     = _loadAcquiredMap(currentYear);

  // Step 4 — Fetch all rosters from Yahoo
  const rosterPayload = fetchYahooAPI(
    `https://fantasysports.yahooapis.com/fantasy/v2/league/${leagueKey}/teams;out=roster/players?format=json`
  );

  if (!rosterPayload) {
    Logger.log('updateRosters: Yahoo roster fetch failed. Aborting.');
    return;
  }

  // Step 5 — Parse rosters and build output rows
  const outputRows = _parseAllRosters(
    rosterPayload, maps, draftRoundMap, transactionMap, acquiredMap, faRound, currentYear
  );

  // Step 6 — Write to Data workbook
  writeToData(ROSTERS_SHEET, [ROSTERS_HEADERS, ...outputRows]);
  Logger.log('updateRosters: wrote ' + outputRows.length + ' rostered players.');

  // Step 7 — Timestamp
  updateTimestamp('UPDATE_ROSTERS');
  flushIdMatchingQueue();
}


// ============================================================
//  SUPPORTING DATA LOADERS
//  Each reads from a Data workbook sheet written by another script.
//  These replace the Yahoo API calls that updateRosters.gs
//  previously made independently for draft and transaction data.
// ============================================================

/**
 * Reads _DRAFT from the Data workbook and builds a lookup map of
 * Yahoo player key → original draft round.
 *
 * Uses IDPLAYER (col I, index 8) as key rather than player key —
 * _DRAFT stores IDPLAYER which was already resolved from the Yahoo
 * player key during updateDraft(). This is intentional: if a player
 * was traded after the draft, their IDPLAYER is stable but their
 * Yahoo team association has changed.
 *
 * Returns empty map if _DRAFT is unavailable — affected players
 * will fall through to the FA round assignment.
 *
 * @returns {Object} IDPLAYER (string) → round (number)
 */
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

  Logger.log('_loadDraftRoundMap: loaded ' + Object.keys(draftMap).length + ' draft rounds.');
  return draftMap;
}


/**
 * Reads _TRANSACTIONS from the Data workbook and builds a map of
 * IDPLAYER → most recent transaction { type, date, sourceTeam }.
 *
 * Transactions are stored most-recent-first in _TRANSACTIONS
 * (updateTransactions prepends new rows). This function reads
 * sequentially and takes the first occurrence of each IDPLAYER —
 * which is therefore the most recent transaction for that player.
 *
 * Returns empty map if _TRANSACTIONS is unavailable.
 *
 * @returns {Object} IDPLAYER (string) → { type: string, date: string, sourceTeam: string }
 */
function _loadLatestTransactionMap() {
  const dataSS = getDataSS();
  const sheet  = dataSS?.getSheetByName('_TRANSACTIONS');

  if (!sheet || sheet.getLastRow() < 2) {
    Logger.log('_loadLatestTransactionMap: _TRANSACTIONS empty or missing.');
    return {};
  }

  const data    = sheet.getDataRange().getValues();
  const headers = data[0].map(h => h.toString().trim().toUpperCase());
  const iId     = headers.indexOf('IDPLAYER');
  const iType   = headers.indexOf('TYPE');
  const iDate   = headers.indexOf('DATE');
  const iManager = headers.indexOf('MANAGER'); // Grabs the Source Team

  if (iId === -1 || iType === -1 || iDate === -1) {
    Logger.log('_loadLatestTransactionMap: required columns missing from _TRANSACTIONS.');
    return {};
  }

  const transMap = {};
  for (let i = 1; i < data.length; i++) {
    const id         = data[i][iId]      ? data[i][iId].toString().trim()      : '';
    const type       = data[i][iType]    ? data[i][iType].toString().trim()    : '';
    const date       = data[i][iDate]    ? data[i][iDate].toString().trim()    : '';
    const sourceTeam = iManager !== -1 && data[i][iManager] ? data[i][iManager].toString().trim() : '';
    
    // First occurrence = most recent (rows are newest-first)
    if (id && !transMap[id]) {
      transMap[id] = { type, date, sourceTeam };
    }
  }

  Logger.log('_loadLatestTransactionMap: loaded ' + Object.keys(transMap).length + ' transaction records.');
  return transMap;
}


/**
 * Reads _ACQUIRED from the Data workbook and builds a map of
 * IDPLAYER → { via, date } for the current year only.
 *
 * _ACQUIRED is a persistent log of how each player was acquired
 * by their current team. It is written by saveAcquired.gs which
 * runs after updateRosters() in the trigger group.
 *
 * Filters to current year rows to avoid showing stale acquisition
 * data from prior years when a player has been re-acquired.
 *
 * Returns empty map if _ACQUIRED is unavailable — ACQUIRED_VIA and
 * ACQUIRED_DATE will be blank for all players on this run.
 *
 * @param  {number} currentYear
 * @returns {Object} IDPLAYER (string) → { via: string, date: string }
 */
function _loadAcquiredMap(currentYear) {
  const dataSS = getDataSS();
  const sheet  = dataSS?.getSheetByName('_ACQUIRED');

  if (!sheet || sheet.getLastRow() < 2) {
    Logger.log('_loadAcquiredMap: _ACQUIRED empty or missing. Will populate after saveAcquired() runs.');
    return {};
  }

  const data    = sheet.getDataRange().getValues();
  const headers = data[0].map(h => h.toString().trim().toUpperCase());
  const iYear   = headers.indexOf('YEAR');
  const iId     = headers.indexOf('IDPLAYER');
  const iVia    = headers.indexOf('ACQUIRED_VIA');
  const iDate   = headers.indexOf('ACQUIRED_DATE');

  if (iId === -1 || iVia === -1) {
    Logger.log('_loadAcquiredMap: required columns missing from _ACQUIRED.');
    return {};
  }

  const acquiredMap = {};
  for (let i = 1; i < data.length; i++) {
    const year = iYear !== -1 ? parseInt(data[i][iYear]) : 0;
    if (year && year !== parseInt(currentYear)) continue; // Current year only

    const id   = data[i][iId]   ? data[i][iId].toString().trim()   : '';
    const via  = data[i][iVia]  ? data[i][iVia].toString().trim()  : '';
    const date = iDate !== -1 && data[i][iDate] ? data[i][iDate].toString().trim() : '';

    if (id && via) acquiredMap[id] = { via, date };
  }

  Logger.log('_loadAcquiredMap: loaded ' + Object.keys(acquiredMap).length + ' acquisition records.');
  return acquiredMap;
}


// ============================================================
//  ROSTER PARSER
// ============================================================

/**
 * Parses the Yahoo roster API response for all teams and returns
 * an array of output rows ready to write to _ROSTERS.
 *
 * @param  {Object} rosterPayload  - Parsed Yahoo API response
 * @param  {Object} maps           - Player resolution maps
 * @param  {Object} draftRoundMap  - IDPLAYER → draft round
 * @param  {Object} transactionMap - IDPLAYER → { type, date, sourceTeam }
 * @param  {Object} acquiredMap    - IDPLAYER → { via, date }
 * @param  {number} faRound        - Round assigned to FA/waiver pickups
 * @param  {number} currentYear    - Current season year
 * @returns {Array[]} Output rows (no headers)
 */
function _parseAllRosters(
  rosterPayload, maps, draftRoundMap, transactionMap, acquiredMap, faRound, currentYear
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
      const masterId = resolveMasterId(maps, parsed.pId, null, parsed.name, 'updateRosters');

      const { cleanPositions, isIL, isNA } = parsePositions(parsed.positions);

      // Transaction data — from _TRANSACTIONS
      const trans       = transactionMap[masterId] || {};
      const transType   = trans.type || '';
      const transDate   = trans.date || '';
      const transSource = trans.sourceTeam || ''; // Gets the manager they were traded from

      // Acquisition data — from _ACQUIRED
      const acq         = acquiredMap[masterId] || {};
      let   acquiredVia  = acq.via  || '';
      let   acquiredDate = acq.date || '';

      // Determine round assignment
      const isFaOrWaiver = _isFaOrWaiverAcquisition(transType, acquiredVia);
      let   round        = isFaOrWaiver ? faRound : (draftRoundMap[masterId] || faRound);

      // Upgrade generic 'TRADE' labels to the new detailed format, or set if missing
      if (!acquiredVia || acquiredVia.toUpperCase() === 'TRADE') {
        if (parsed.keeper === 'K' || transType === '') {
          acquiredVia  = 'Draft';
          acquiredDate = currentYear.toString();
        } else if (transType === 'TRADE') {
          // Format as "Trade (Manager Name)"
          acquiredVia  = transSource ? `Trade (${transSource})` : 'Trade';
          acquiredDate = transDate;
        } else {
          acquiredVia  = transType;
          acquiredDate = transDate;
        }
      }

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

/**
 * Determines whether a player's acquisition should be treated as
 * a free agent or waiver pickup for round assignment purposes.
 * FA/waiver acquisitions are assigned faRound regardless of the
 * player's original draft round history.
 *
 * Checks both the most recent transaction type (from _TRANSACTIONS)
 * and the persistent acquired-via value (from _ACQUIRED) since
 * either may contain the relevant information depending on whether
 * saveAcquired has run yet this season.
 *
 * @param  {string} transType   - Most recent transaction type ('ADD', 'DROP', 'TRADE', '')
 * @param  {string} acquiredVia - Persistent acquisition type from _ACQUIRED
 * @returns {boolean} true if player should receive faRound assignment
 */
function _isFaOrWaiverAcquisition(transType, acquiredVia) {
  const faKeywords = ['free', 'waiv', 'add'];

  const transLower   = transType.toLowerCase();
  const acquiredLower = acquiredVia.toLowerCase();

  return faKeywords.some(kw => transLower.includes(kw) || acquiredLower.includes(kw));
}