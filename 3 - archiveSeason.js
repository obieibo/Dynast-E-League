/**
 * FILE: archiveSeason.gs
 * PURPOSE: Archives Drafts to the vault and Wipes Transactions from the engine.
 */

function archiveSeason() {
  const ss = getPrimarySS();
  const dataSS = getDataSS();
  const archiveId = ss.getRangeByName('SHEET_ARCHIVE_ID').getValue();
  const archiveSS = SpreadsheetApp.openById(archiveId);
  const currentYear = ss.getRangeByName('CURRENT_YEAR').getValue();

  Logger.log(`Starting Year-End Cleanup for ${currentYear}...`);

  // 1. ARCHIVE DRAFTS (Saves to Archive, then Wipes)
  const engineSheet = dataSS.getSheetByName('_DRAFT');
  if (engineSheet) {
    const engineData = engineSheet.getDataRange().getValues();
    if (engineData.length > 1) {
      let archiveSheet = archiveSS.getSheetByName('HIST_DRAFTS');
      if (!archiveSheet) {
        archiveSheet = archiveSS.insertSheet('HIST_DRAFTS');
        archiveSheet.appendRow(['YEAR', ...engineData[0]]);
      }
      const rowsToArchive = engineData.slice(1).map(row => [currentYear, ...row]);
      archiveSheet.getRange(archiveSheet.getLastRow() + 1, 1, rowsToArchive.length, rowsToArchive[0].length).setValues(rowsToArchive);
      
      engineSheet.deleteRows(2, engineSheet.getLastRow() - 1);
      Logger.log("Draft data archived and wiped.");
    }
  }

  // 2. WIPE TRANSACTIONS (Trash-cans them without saving to Archive)
  const transSheet = dataSS.getSheetByName('_TRANSACTIONS');
  if (transSheet && transSheet.getLastRow() > 1) {
    transSheet.deleteRows(2, transSheet.getLastRow() - 1);
    Logger.log("Transactions wiped from engine (Not archived).");
  }

  // 3. RESET VISUAL DISPLAY
  const displaySheet = ss.getSheetByName('Draft');
  if (displaySheet && displaySheet.getLastRow() >= 4) {
    displaySheet.deleteRows(4, displaySheet.getLastRow() - 3);
    Logger.log("Visual 'Draft' sheet reset.");
  }

  Logger.log(`Season ${currentYear} is officially closed and cleared.`);
}