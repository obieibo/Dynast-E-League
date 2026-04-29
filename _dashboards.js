/**
 * @file _dashboards.gs
 * @description Populates the "All Players", "Batters", and "Pitchers" scouting 
 * dashboards using a dynamic configuration engine.
 */

// ============================================================================
// DASHBOARD CONFIGURATION (DATA DICTIONARY)
// ============================================================================
// HOW TO EDIT:
// source: "ENGINE", "FG_B" (Batting Actuals), "FG_P" (Pitching Actuals), 
//         "BS_B" (Savant Bat), "BS_P" (Savant Pitch), "PLAYERS", "ROSTERS", 
//         "FP" (Ranks), "SGP" (System SGP Calcs), "CALC" (Custom Math), "BLANK"
// header: The exact column name found in that source sheet
// format: "cStat" (Forces 0 for counting stats), "rStat" (Rate stat -> needs volHeader), 
//         "roster" (Adds 'Team'), "1dec" (1 decimal place)
// volHeader: Used only for "rStat". Determines which volume stat to check (PA or IP).
// ============================================================================

const ALL_PLAYERS_LAYOUT = [
 
  // Player Information
  /** IDPLAYER **/    { source: "ENGINE", header: "IDPLAYER" },
  /** MLB Logo **/    { source: "ENGINE", header: "TEAM" },
  /** Status **/      { source: "ROSTERS", header: "TEAM_ID", format: "roster" },
  /** IL **/          { source: "PLAYERS", header: "IL" },
  /** NA **/          { source: "PLAYERS", header: "NA" },
  /**  **/            { source: "BLANK" },
  /**  **/            { source: "BLANK" },
  /** Player **/      { source: "ENGINE", header: "Player" },
  /**  **/            { source: "BLANK" },
  /** Position(s) **/ { source: "ENGINE", header: "Position" },
  /**  **/            { source: "BLANK" },
  /**  **/            { source: "BLANK" },
  /**  **/            { source: "BLANK" },
  /**  **/            { source: "BLANK" },
  /**  **/            { source: "BLANK" },
  /**  **/            { source: "BLANK" },
 
  // Actual Statistics
  /** PA **/   { source: "FG_B", header: "PA", format: "cStat" },
  /** R **/    { source: "FG_B", header: "R", format: "cStat" },
  /** HR **/   { source: "FG_B", header: "HR", format: "cStat" },
  /** RBI **/  { source: "FG_B", header: "RBI", format: "cStat" },
  /** OPS **/  { source: "FG_B", header: "OPS", format: "rStat", volHeader: "PA" },
  /** NSB **/  { source: "CALC", type: "bNSB" },
  /** IP **/   { source: "FG_P", header: "IP", format: "cStat" },
  /** K **/    { source: "FG_P", header: "SO", format: "cStat" },
  /** ERA **/  { source: "FG_P", header: "ERA", format: "rStat", volHeader: "IP" },
  /** WHIP **/ { source: "FG_P", header: "WHIP", format: "rStat", volHeader: "IP" },
  /** QS **/   { source: "FG_P", header: "QS", format: "cStat" },
  /** NSVH **/ { source: "CALC", type: "pNSVH" },
 
  // Projected Statistics
  /** PA **/   { source: "ENGINE", header: "PA", format: "cStat" },
  /** R **/    { source: "ENGINE", header: "R", format: "cStat" },
  /** HR **/   { source: "ENGINE", header: "HR", format: "cStat" },
  /** RBI **/  { source: "ENGINE", header: "RBI", format: "cStat" },
  /** OPS **/  { source: "ENGINE", header: "OPS", format: "rStat", volHeader: "PA" },
  /** NSB **/  { source: "ENGINE", header: "NSB", format: "cStat" },
  /** IP **/   { source: "ENGINE", header: "IP", format: "cStat" },
  /** K **/    { source: "ENGINE", header: "K", format: "cStat" },
  /** ERA **/  { source: "ENGINE", header: "ERA", format: "rStat", volHeader: "IP" },
  /** WHIP **/ { source: "ENGINE", header: "WHIP", format: "rStat", volHeader: "IP" },
  /** QS **/   { source: "ENGINE", header: "QS", format: "cStat" },
  /** NSVH **/ { source: "ENGINE", header: "NSVH", format: "cStat" },
  
  // Rankings and SGP Values
  /** FP Rank **/   { source: "FP", header: "RANK" },
  /** PL **/        { source: "BLANK" },
  /** THE BAT X **/ { source: "SGP", header: "THE BAT X" },
  /** OOPSY **/     { source: "SGP", header: "OOPSY" },
  /** ATC **/       { source: "SGP", header: "ATC" },

  // Optimal Blend Model
  /** PAR **/    { source: "ENGINE", header: "PAR" },
  /** SGP **/    { source: "ENGINE", header: "SGP" },
  /** FIT **/    { source: "ENGINE", header: "FIT" },
];

const BATTERS_LAYOUT = [
  
  // Player Information
  /** IDPLAYER **/    { source: "ENGINE", header: "IDPLAYER" },
  /** MLB Logo **/    { source: "ENGINE", header: "TEAM" },
  /** Status **/      { source: "ROSTERS", header: "TEAM_ID", format: "roster" },
  /** IL **/          { source: "PLAYERS", header: "IL" },
  /** NA **/          { source: "PLAYERS", header: "NA" },
  /**  **/            { source: "BLANK" },
  /**  **/            { source: "BLANK" },
  /** Player **/      { source: "ENGINE", header: "Player" },
  /**  **/            { source: "BLANK" },
  /** Position(s) **/ { source: "ENGINE", header: "Position" },
  /**  **/            { source: "BLANK" },
  /**  **/            { source: "BLANK" },
  /**  **/            { source: "BLANK" },
  /**  **/            { source: "BLANK" },
  /**  **/            { source: "BLANK" },
  /**  **/            { source: "BLANK" },
  
  // Actual Statistics
  /** PA **/   { source: "FG_B", header: "PA", format: "cStat" },
  /** R **/    { source: "FG_B", header: "R", format: "cStat" },
  /** HR **/   { source: "FG_B", header: "HR", format: "cStat" },
  /** RBI **/  { source: "FG_B", header: "RBI", format: "cStat" },
  /** OPS **/  { source: "FG_B", header: "OPS", format: "rStat", volHeader: "PA" },
  /** NSB **/  { source: "CALC", type: "bNSB" },
  
  // Projected Statistics
  /** PA **/   { source: "ENGINE", header: "PA", format: "cStat" },
  /** R **/    { source: "ENGINE", header: "R", format: "cStat" },
  /** HR **/   { source: "ENGINE", header: "HR", format: "cStat" },
  /** RBI **/  { source: "ENGINE", header: "RBI", format: "cStat" },
  /** OPS **/  { source: "ENGINE", header: "OPS", format: "rStat", volHeader: "PA" },
  /** NSB **/  { source: "ENGINE", header: "NSB", format: "cStat" },
  
  // Rankings and SGP Values
  /** FP Rank **/   { source: "FP", header: "RANK" },
  /** PL **/        { source: "BLANK" },
  /** THE BAT X **/ { source: "SGP", header: "THE BAT X" },
  /** OOPSY **/     { source: "SGP", header: "OOPSY" },
  /** ATC **/       { source: "SGP", header: "ATC" },

  // Optimal Blend Model
  /** PAR **/    { source: "ENGINE", header: "PAR" },
  /** SGP **/    { source: "ENGINE", header: "SGP" },
  /** FIT **/    { source: "ENGINE", header: "FIT" },
  
  // Overall
  /** Batting **/ { source: "FG_B", header: "Batting" },
  /** wRC+ **/    { source: "FG_B", header: "wRC+" },
  /** xwOBA **/   { source: "FG_B", header: "xwOBA" },
  /** ΔxwOBA **/  { source: "CALC", type: "ΔxwOBA" },
  /** xISO **/    { source: "CALC", type: "xISO" },
  /** Barrel% **/ { source: "FG_B", header: "Barrel%" },
  /** Hard% **/   { source: "FG_B", header: "HardHit%" },
  /** SqUp% **/   { source: "FG_B", header: "SquaredUpSwing%" },
  /** EV90 **/    { source: "FG_B", header: "EV90" },
  /** BB% **/     { source: "FG_B", header: "BB%" },
  /** K% **/      { source: "FG_B", header: "K%" },
  /** O-Sw% **/   { source: "FG_B", header: "O-Swing%" },
  /** SwStr% **/  { source: "FG_B", header: "SwStr%" },
  /** Bat Spd **/ { source: "FG_B", header: "AvgBatSpeed" },
  /** FastSw% **/ { source: "FG_B", header: "FastSwing%" },
  /** SwLen **/   { source: "FG_B", header: "SwingLength" },
  /** GB% **/     { source: "FG_B", header: "GB%" },
  /** LD% **/     { source: "FG_B", header: "LD%" },
  /** HR/FB **/   { source: "FG_B", header: "HR/FB" },
  /** BABIP **/   { source: "FG_B", header: "BABIP" },
  /** Sprint **/  { source: "FG_B", header: "Spd" }
];

const PITCHERS_LAYOUT = [
  
  // Player Information
  /** IDPLAYER **/    { source: "ENGINE", header: "IDPLAYER" },
  /** MLB Logo **/    { source: "ENGINE", header: "TEAM" },
  /** Status **/      { source: "ROSTERS", header: "TEAM_ID", format: "roster" },
  /** IL **/          { source: "PLAYERS", header: "IL" },
  /** NA **/          { source: "PLAYERS", header: "NA" },
  /**  **/            { source: "BLANK" },
  /**  **/            { source: "BLANK" },
  /** Player **/      { source: "ENGINE", header: "Player" },
  /**  **/            { source: "BLANK" },
  /** Position(s) **/ { source: "ENGINE", header: "Position" },
  /**  **/            { source: "BLANK" },
  /**  **/            { source: "BLANK" },
  /**  **/            { source: "BLANK" },
  /**  **/            { source: "BLANK" },
  /**  **/            { source: "BLANK" },
  /**  **/            { source: "BLANK" },
  
  // Actual Statistics
  /** IP **/   { source: "FG_P", header: "IP", format: "cStat" },
  /** K **/    { source: "FG_P", header: "SO", format: "cStat" },
  /** ERA **/  { source: "FG_P", header: "ERA", format: "rStat", volHeader: "IP" },
  /** WHIP **/ { source: "FG_P", header: "WHIP", format: "rStat", volHeader: "IP" },
  /** QS **/   { source: "FG_P", header: "QS", format: "cStat" },
  /** NSVH **/ { source: "CALC", type: "pNSVH" },

  // Projected Statistics
  /** IP **/   { source: "ENGINE", header: "IP", format: "cStat" },
  /** K **/    { source: "ENGINE", header: "K", format: "cStat" },
  /** ERA **/  { source: "ENGINE", header: "ERA", format: "rStat", volHeader: "IP" },
  /** WHIP **/ { source: "ENGINE", header: "WHIP", format: "rStat", volHeader: "IP" },
  /** QS **/   { source: "ENGINE", header: "QS", format: "cStat" },
  /** NSVH **/ { source: "ENGINE", header: "NSVH", format: "cStat" },

  // Rankings and SGP Values
  /** FP Rank **/   { source: "FP", header: "RANK" },
  /** PL **/        { source: "BLANK" },
  /** THE BAT X **/ { source: "SGP", header: "THE BAT X" },
  /** OOPSY **/     { source: "SGP", header: "OOPSY" },
  /** ATC **/       { source: "SGP", header: "ATC" },

  // Optimal Blend Model
  /** PAR **/    { source: "ENGINE", header: "PAR" },
  /** SGP **/    { source: "ENGINE", header: "SGP" },
  /** FIT **/    { source: "ENGINE", header: "FIT" },

  // Stuff and Velocity
  /** Stuff+ **/  { source: "FG_P", header: "sp_stuff" },
  /** Pitch+ **/  { source: "FG_P", header: "sp_pitching" },
  /** FB Velo **/ { source: "FG_P", header: "FBv" },
  /** SwStr% **/  { source: "FG_P", header: "SwStr%" },
  /** O-Sw% **/   { source: "FG_P", header: "O-Swing%" },
  /** CSW% **/    { source: "FG_P", header: "C+SwStr%" },
  /** K% **/      { source: "FG_P", header: "K%" },
  /** BB% **/     { source: "FG_P", header: "BB%" },
  /** K-BB% **/   { source: "FG_P", header: "K-BB%" },
  /** xERA **/    { source: "FG_P", header: "xERA" },
  /** ΔxERA **/   { source: "CALC", type: "ΔxERA" },
  /** xFIP **/    { source: "FG_P", header: "xFIP" },
  /** ΔxFIP **/   { source: "CALC", type: "ΔxFIP" },
  /** SIERA **/   { source: "FG_P", header: "SIERA" },
  /** Barrel% **/ { source: "FG_P", header: "Barrel%" },
  /** Hard% **/   { source: "FG_P", header: "HardHit%" },
  /** GB% **/     { source: "FG_P", header: "GB%" },
  /** HR/FB **/   { source: "FG_P", header: "HR/FB" },
  /** P / IP **/  { source: "CALC", type: "P / IP" }
];

// ============================================================================
// LOGIC ENGINE
// ============================================================================

function updatePlayerDashboards() {
  const ss = getPrimarySS();
  const dataSS = getDataSS();
  if (!ss || !dataSS) return;

  Logger.log("Updating Player Dashboards via Config Layouts...");

  // 1. Fetch SGP Calibration Data
  const normPA = getDashboardSetting("ENGINE_SGP_VALUES", "OPS normalized PA", 500);
  const normIP_ERA = getDashboardSetting("ENGINE_SGP_VALUES", "ERA normalized IP", 150);
  const normIP_WHIP = getDashboardSetting("ENGINE_SGP_VALUES", "WHIP normalized IP", 150);
  const bOPS = getDashboardSetting("ENGINE_SGP_VALUES", "OPS baseline", 0.750);
  const bERA = getDashboardSetting("ENGINE_SGP_VALUES", "ERA baseline", 3.80);
  const bWHIP = getDashboardSetting("ENGINE_SGP_VALUES", "WHIP baseline", 1.20);
  const fR = getDashboardSetting("ENGINE_CATEGORY_SCALING", "R factor", 1);
  const fHR = getDashboardSetting("ENGINE_CATEGORY_SCALING", "HR factor", 1);
  const fRBI = getDashboardSetting("ENGINE_CATEGORY_SCALING", "RBI factor", 1);
  const fNSB = getDashboardSetting("ENGINE_CATEGORY_SCALING", "NSB factor", 1);
  const fOPS = getDashboardSetting("ENGINE_CATEGORY_SCALING", "OPS factor", 100);
  const fK = getDashboardSetting("ENGINE_CATEGORY_SCALING", "K factor", 1);
  const fQS = getDashboardSetting("ENGINE_CATEGORY_SCALING", "QS factor", 1);
  const fNSVH = getDashboardSetting("ENGINE_CATEGORY_SCALING", "NSVH factor", 1);
  const fERA = getDashboardSetting("ENGINE_CATEGORY_SCALING", "ERA factor", 50);
  const fWHIP = getDashboardSetting("ENGINE_CATEGORY_SCALING", "WHIP factor", 150);

  // 2. Load Source Data Maps
  const engineData = _sheetToMap(dataSS, "_ENGINE", "IDPLAYER", true); 
  const playersMap = _sheetToMap(dataSS, "_PLAYERS", "IDPLAYER");
  const rostersMap = _sheetToMap(dataSS, "_ROSTERS", "IDPLAYER");
  const fgBatMap = _sheetToMap(dataSS, "_FG_B", "IDPLAYER");
  const fgPitMap = _sheetToMap(dataSS, "_FG_P", "IDPLAYER");
  const bsBatMap = _sheetToMap(dataSS, "_BS_B", "player_id"); 
  const bsPitMap = _sheetToMap(dataSS, "_BS_P", "player_id"); 
  
  // Phase Logic (Pre-Season vs ROS)
  let fpMap;
  let projPhase = "Pre-Season"; 
  const fpRosSheet = dataSS.getSheetByName("_FP_ROS");
  if (fpRosSheet && fpRosSheet.getLastRow() > 1) {
    fpMap = _sheetToMap(dataSS, "_FP_ROS", "IDPLAYER");
    projPhase = "ROS"; 
  } else {
    fpMap = _sheetToMap(dataSS, "_FP_PRE", "IDPLAYER");
  }

const projBatMap = _buildSystemProjMap(dataSS, "_FG_PROJ_B");
const projPitMap = _buildSystemProjMap(dataSS, "_FG_PROJ_P");

  // 3. Formatting Math Helpers
  const cStat = (val) => { const num = parseFloat(val); return isNaN(num) ? 0 : num; };
  const rStat = (rateVal, volVal) => { if (cStat(volVal) === 0) return "-"; return (rateVal !== undefined && rateVal !== "" && rateVal !== null) ? rateVal : "-"; };
  const _diff = (v1, v2, dec) => { const n1 = parseFloat(v1); const n2 = parseFloat(v2); return (isNaN(n1) || isNaN(n2)) ? "" : (n1 - n2).toFixed(dec); };

  const calcSystemSGP = (pid, sysName, type) => {
    sysName = sysName.toLowerCase();
    if (type === "Batter") {
      const pData = projBatMap[pid]?.[sysName];
      if (!pData || !pData["PA"]) return "";
      const opsSGP = (((pData["OPS"] || 0) - bOPS) * pData["PA"] / normPA) / (fOPS / 100);
      const sgp = ((pData["R"] || 0)/fR) + ((pData["HR"] || 0)/fHR) + ((pData["RBI"] || 0)/fRBI) + (((pData["SB"] || 0) - (pData["CS"] || 0))/fNSB) + opsSGP;
      return sgp.toFixed(2);
    } else {
      const pData = projPitMap[pid]?.[sysName];
      if (!pData || !pData["IP"]) return "";
      const eraSGP = ((bERA - (pData["ERA"] || 0)) * pData["IP"] / normIP_ERA) / (fERA / 50);
      const whipSGP = ((bWHIP - (pData["WHIP"] || 0)) * pData["IP"] / normIP_WHIP) / (fWHIP / 150);
      const nsvh = (pData["SV"] || 0) + (pData["HLD"] || 0);
      const sgp = ((pData["SO"] || 0)/fK) + ((pData["QS"] || 0)/fQS) + (nsvh/fNSVH) + eraSGP + whipSGP;
      return sgp.toFixed(2);
    }
  };

  // 4. The Data Compiler (Processes 1 Cell based on Config Layout)
  const _processCell = (cfg, pid, type, row) => {
    if (cfg.source === "BLANK") return "";

    // Safeguard: Prevents Ohtani (Pitcher) from getting 0s in Batter Columns and vice versa.
    // Uses source-based checks to prevent wiping out dual-purpose stats like K% or BB%.
    const isBatStat = ["FG_B", "BS_B"].includes(cfg.source) || (cfg.source === "CALC" && ["bNSB", "ΔxwOBA", "xISO"].includes(cfg.type));
    const isPitStat = ["FG_P", "BS_P"].includes(cfg.source) || (cfg.source === "CALC" && ["pNSVH", "P / PA", "ΔERA", "ΔFIP"].includes(cfg.type));

    if (isBatStat && type === "Pitcher") return "";
    if (isPitStat && type === "Batter") return "";

    let rawVal = "";
    if (cfg.source === "ENGINE") rawVal = row[cfg.header];
    else if (cfg.source === "FG_B") rawVal = fgBatMap[pid]?.[cfg.header];
    else if (cfg.source === "FG_P") rawVal = fgPitMap[pid]?.[cfg.header];
    else if (cfg.source === "BS_B") rawVal = bsBatMap[pid]?.[cfg.header];
    else if (cfg.source === "BS_P") rawVal = bsPitMap[pid]?.[cfg.header];
    else if (cfg.source === "PLAYERS") rawVal = playersMap[pid]?.[cfg.header];
    else if (cfg.source === "ROSTERS") rawVal = rostersMap[pid]?.[cfg.header];
    else if (cfg.source === "FP") rawVal = fpMap[pid]?.["RANK"] || fpMap[pid]?.["BEST"];
    
    if (cfg.source === "SGP") return calcSystemSGP(pid, cfg.header, type);

    if (cfg.source === "CALC") {
       if (cfg.type === "bNSB") return cStat( (fgBatMap[pid]?.["SB"]||0) - (fgBatMap[pid]?.["CS"]||0) );
       if (cfg.type === "pNSVH") return cStat( (fgPitMap[pid]?.["SV"]||0) + (fgPitMap[pid]?.["HLD"]||0) );
       if (cfg.type === "P / IP") { const val = cStat((fgPitMap[pid]?.["Pitches"]||0) / (fgPitMap[pid]?.["IP"]||0)); return val === 0 ? "" : val; }
       if (cfg.type === "ΔxwOBA") return _diff(fgBatMap[pid]?.["xwOBA"], fgBatMap[pid]?.["wOBA"], 3);
       if (cfg.type === "xISO") return _diff(fgBatMap[pid]?.["xSLG"], fgBatMap[pid]?.["xAVG"], 3);
       if (cfg.type === "ΔxERA") return _diff(fgPitMap[pid]?.["xERA"], fgPitMap[pid]?.["ERA"], 2);
       if (cfg.type === "ΔxFIP") return _diff(fgPitMap[pid]?.["xFIP"], fgPitMap[pid]?.["FIP"], 2);
    }

    if (cfg.format === "roster") {
      // Fallback just in case the cell is truly blank
      if (!rawVal || rawVal.toString().trim() === "") return "FA"; 

      const s = rawVal.toString().trim();
      
      // Check for FA or Waivers (ignoring case just to be safe)
      if (s.toLowerCase() === "free agent" || s.toUpperCase() === "FA") return "FA";
      if (s.toLowerCase() === "waivers" || s.toUpperCase() === "W") return "W";
      
      // If it's a team, strip the word "Team " (if it exists) and return the ID
      return s.replace(/Team /ig, "");
    }
    if (cfg.format === "cStat") return cStat(rawVal);
    if (cfg.format === "1dec") { const num = parseFloat(rawVal); return !isNaN(num) ? num.toFixed(1) : ""; }
    if (cfg.format === "rStat") {
       let vol = 0;
       if (cfg.source === "ENGINE") vol = row[cfg.volHeader];
       else if (cfg.source === "FG_B") vol = fgBatMap[pid]?.[cfg.volHeader];
       else if (cfg.source === "FG_P") vol = fgPitMap[pid]?.[cfg.volHeader];
       return rStat(rawVal, vol);
    }

    return (rawVal !== undefined && rawVal !== null) ? rawVal : "";
  };

  // 5. Build Final Output Arrays
  const outAll = [];
  const outBat = [];
  const outPit = [];

  engineData.forEach(row => {
    const pid = row["IDPLAYER"];
    const type = row["Type"];

    outAll.push(ALL_PLAYERS_LAYOUT.map(cfg => _processCell(cfg, pid, type, row)));

    if (type === "Batter") {
      outBat.push(BATTERS_LAYOUT.map(cfg => _processCell(cfg, pid, type, row)));
    } else if (type === "Pitcher") {
      outPit.push(PITCHERS_LAYOUT.map(cfg => _processCell(cfg, pid, type, row)));
    }
  });

  // 6. Write Data to Dashboards Dynamically Sorting by FIT score
  _writeToDashboard(ss, "All Players", outAll, ALL_PLAYERS_LAYOUT.findIndex(c => c.header === "FIT"));
  _writeToDashboard(ss, "Batters", outBat, BATTERS_LAYOUT.findIndex(c => c.header === "FIT"));
  _writeToDashboard(ss, "Pitchers", outPit, PITCHERS_LAYOUT.findIndex(c => c.header === "FIT"));

const batSource = getDominantBatSource(projBatMap);
const iconFormula = batSource === "the bat x" ? "=ICON_THE_BAT_X" : "=ICON_THE_BAT";

// All Players → AQ4
ss.getSheetByName("All Players")?.getRange("AQ4").setFormula(iconFormula);

// Batters → AE4
ss.getSheetByName("Batters")?.getRange("AE4").setFormula(iconFormula);

// Pitchers → AE4
ss.getSheetByName("Pitchers")?.getRange("AE4").setFormula(iconFormula);

  Logger.log("Dashboards Compiled Successfully.");
}

// --- HELPER FUNCTIONS ---

function _writeToDashboard(ss, sheetName, dataArray, sortIndex) {
  const sheet = ss.getSheetByName(sheetName);
  if (!sheet) return;
  
  const lastRow = sheet.getMaxRows();
  if (lastRow >= 5) {
    sheet.getRange(5, 1, lastRow - 4, sheet.getMaxColumns()).clearContent();
  }

  if (dataArray.length > 0) {
    if (sortIndex !== -1) {
      dataArray.sort((a, b) => (parseFloat(b[sortIndex]) || 0) - (parseFloat(a[sortIndex]) || 0));
    }
    sheet.getRange(5, 1, dataArray.length, dataArray[0].length).setValues(dataArray);
  }
}

function _sheetToMap(dataSS, sheetName, keyHeader, returnArray = false) {
  const sheet = dataSS.getSheetByName(sheetName);
  const map = returnArray ? [] : {};
  if (!sheet || sheet.getLastRow() < 2) return map;

  const data = sheet.getDataRange().getValues();
  const headers = data[0].map(h => h.toString().trim()); 
  const keyIdx = headers.findIndex(h => h.toUpperCase() === keyHeader.toUpperCase());

  if (keyIdx === -1) return map;

  for (let i = 1; i < data.length; i++) {
    const key = data[i][keyIdx]?.toString().trim();
    if (!key) continue;

    const rowObj = {};
    headers.forEach((h, idx) => { rowObj[h] = data[i][idx]; });

    if (returnArray) map.push(rowObj);
    else map[key] = rowObj;
  }
  return map;
}

function _buildSystemProjMap(dataSS, sheetName) {
  const sheet = dataSS.getSheetByName(sheetName);
  const map = {};
  if (!sheet || sheet.getLastRow() < 2) return map;

  const data = sheet.getDataRange().getValues();
  const headers = data[0].map(h => h.toString().trim().toUpperCase());

  const getCol = (name) => headers.indexOf(name);
  const idIdx = getCol("IDPLAYER");
  const sysIdx = getCol("PROJECTIONS");
  const typeIdx = getCol("TYPE");

  const temp = {};

  // --- LOAD ALL DATA ---
  for (let i = 1; i < data.length; i++) {
    const pid = data[i][idIdx]?.toString().trim();
    const sys = data[i][sysIdx]?.toString().trim().toLowerCase();
    const type = data[i][typeIdx]?.toString().trim(); // ROS / Pre-Season

    if (!pid || !sys || !type) continue;

    if (!temp[pid]) temp[pid] = {};
    if (!temp[pid][sys]) temp[pid][sys] = {};

    const rowObj = {};
    headers.forEach((h, idx) => {
      if (['IDPLAYER','IDFANGRAPHS','YEAR','PROJECTIONS','TYPE','PLAYERNAME','TEAM'].includes(h)) return;
      rowObj[h] = parseFloat(data[i][idx]) || 0;
    });

    temp[pid][sys][type] = rowObj;
  }

  // --- PICK WITH FALLBACK ---
  function pickWithSource(pid, systems) {
    for (let s of systems) {
      const sys = temp[pid]?.[s];
      if (!sys) continue;

      if (sys["ROS"]) return { data: sys["ROS"], source: s };
      if (sys["Pre-Season"]) return { data: sys["Pre-Season"], source: s };
    }
    return { data: null, source: null };
  }

  // --- BUILD FINAL MAP ---
  for (let pid in temp) {
    map[pid] = {};

    // THE BAT X fallback chain
    const result = pickWithSource(pid, ["the bat x", "the bat"]);
    map[pid]["the bat x"] = result.data;

    // store metadata for icon logic
    if (!map["_meta"]) map["_meta"] = {};
    map["_meta"][pid] = result.source;

    // other systems (normal ROS → Pre fallback)
    for (let sys in temp[pid]) {
      if (sys === "the bat x" || sys === "the bat") continue;
      map[pid][sys] = temp[pid][sys]["ROS"] || temp[pid][sys]["Pre-Season"];
    }
  }

  return map;
}

function getDominantBatSource(projMap) {
  const counts = { "the bat x": 0, "the bat": 0 };

  if (!projMap["_meta"]) return "the bat x";

  for (let pid in projMap["_meta"]) {
    const src = projMap["_meta"][pid];
    if (counts[src] !== undefined) counts[src]++;
  }

  return counts["the bat x"] >= counts["the bat"] ? "the bat x" : "the bat";
}