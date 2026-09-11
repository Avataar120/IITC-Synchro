/**
 * Backend de synchro pour IITC - à coller dans script.google.com
 * ----------------------------------------------------------------
 * Stocke un blob JSON (vos données localStorage IITC préfixées "plugin-")
 * + un timestamp, dans un Google Sheet lié à ce script.
 *
 * Sécurité : simple jeton partagé (TOKEN). Changez-le avant de déployer,
 * et ne partagez jamais ce jeton publiquement.
 */

// 1) CHANGEZ CE JETON avant de déployer (chaîne aléatoire, ex: généré avec un gestionnaire de mots de passe)
const TOKEN = 'CHANGE_ME_SECRET_TOKEN';

const SHEET_NAME = 'Data';

function getSheet_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(SHEET_NAME);
    sheet.getRange('A1').setValue('{}');
    sheet.getRange('A2').setValue(0);
  }
  return sheet;
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

function unauthorized_() {
  return json_({ error: 'unauthorized' });
}

// Lecture : GET https://.../exec?token=XXX
function doGet(e) {
  const token = e && e.parameter && e.parameter.token;
  if (token !== TOKEN) return unauthorized_();

  const sheet = getSheet_();
  const rawData = sheet.getRange('A1').getValue() || '{}';
  const ts = Number(sheet.getRange('A2').getValue()) || 0;

  let data;
  try {
    data = JSON.parse(rawData);
  } catch (err) {
    data = {};
  }

  return json_({ data: data, ts: ts });
}

// Écriture : POST body = { token, ts, data }
// Content-Type doit être 'text/plain' côté client pour éviter le preflight CORS
function doPost(e) {
  let body;
  try {
    body = JSON.parse(e.postData.contents);
  } catch (err) {
    return json_({ error: 'bad_json' });
  }

  if (body.token !== TOKEN) return unauthorized_();

  const sheet = getSheet_();
  const currentTs = Number(sheet.getRange('A2').getValue()) || 0;

  // Refuse un push plus ancien que ce qui est déjà stocké (protection basique)
  if (typeof body.ts !== 'number' || body.ts < currentTs) {
    return json_({ error: 'stale', ts: currentTs });
  }

  sheet.getRange('A1').setValue(JSON.stringify(body.data || {}));
  sheet.getRange('A2').setValue(body.ts);

  return json_({ ok: true, ts: body.ts });
}
