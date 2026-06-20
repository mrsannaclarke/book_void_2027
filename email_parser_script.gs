/***** VOID Fest parser - map publishing gate *****/
const SPREADSHEET_ID = '1OC0oAJZQf5kjQInaxbq_WxPCDl6IXDUNmKP9FbDojX8';

const INVENTORY_SHEET_NAME = 'inventory';
const SPACE_STATE_SHEET_NAME = 'space_state';
const SLEEP_STATE_SHEET_NAME = 'sleep_state';
const AUDIT_SHEET_NAME = 'booking_events';
const ERROR_SHEET_NAME = 'parser_errors';
const DRIFT_SHEET_NAME = 'sheet_drift';

const PARSED_LABEL_NAME = '2026-admin---bookwhen-parsed';
const PAGE_SIZE = 100;
const GMAIL_QUERY = 'in:inbox from:(mail@bookwhen.com) subject:([Bookwhen])';

const SPACE_STATE_HEADER = [
  'space_key',
  'date',
  'display',
  'public_social',
  'status',
  'lead_name',
  'lead_email',
  'lead_phone',
  'space_type',
  'bookwhen_ref',
  'last_bookwhen_event_at',
  'last_parser_update_at',
  'admin_notes'
];

const AUDIT_HEADER = [
  'event_id',
  'processed_at',
  'email_date',
  'gmail_thread_id',
  'gmail_message_id',
  'bookwhen_ref',
  'event_type',
  'space_key',
  'space_type',
  'space_label',
  'ticket',
  'quantity',
  'slot_count',
  'status',
  'display',
  'public_social',
  'lead_name',
  'lead_email',
  'lead_phone',
  'source_subject',
  'parse_notes'
];

const SLEEP_STATE_HEADER = [
  'room',
  'room_type',
  'status',
  'bookwhen_ref',
  'lead_name',
  'lead_email',
  'lead_phone',
  'booking_date',
  'last_bookwhen_event_at',
  'venue_notes'
];

const ERROR_HEADER = [
  'processed_at',
  'gmail_thread_id',
  'gmail_message_id',
  'subject',
  'reason',
  'excerpt'
];

const DRIFT_HEADER = [
  'checked_at',
  'severity',
  'tab',
  'row',
  'space_key',
  'issue',
  'details'
];

const ACTIVE_STATUSES = new Set(['full', 'occupied', 'booked', 'partial']);
const CANCELLED_STATUSES = new Set(['cancelled', 'released']);
const VALID_SPACE_STATE_STATUSES = new Set(['', 'full', 'occupied', 'booked', 'partial', 'cancelled', 'released']);
const RELEASE_EVENT_TYPES = new Set(['booking_cancelled', 'ticket_changed_from']);
const ACTIVE_EVENT_TYPES = new Set(['new_booking', 'ticket_changed_to', 'ticket_active']);
const VENDOR_TYPES = new Set(['VND10TENT', 'VND10OUT', 'VND10IN', 'VND10STREET']);

function runParser() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(5 * 60 * 1000)) {
    console.log('runParser: another run is in progress.');
    return;
  }

  try {
    const ctx = getParserContext_();
    const parsedLabel = getOrCreateLabel_(PARSED_LABEL_NAME);
    const threads = fetchInboxBookwhenThreads_(parsedLabel);
    if (!threads.length) {
      console.log('runParser: no Inbox Bookwhen threads to parse.');
      return;
    }

    threads.forEach(thread => {
      try {
        const msgs = thread.getMessages();
        const msg = msgs[msgs.length - 1];
        const parsed = parseMessageToEvents_(msg, thread, ctx.inventoryByKey);

        if (!parsed.events.length) {
          throw new Error('No parser-scope spaces found in message.');
        }

        appendAuditEvents_(ctx.auditSheet, ctx.auditIds, parsed.events);
        applyEventsToSpaceState_(ctx.stateSheet, ctx.stateRows, parsed.events);
        applyEventsToSleepState_(ctx.sleepSheet, ctx.sleepRows, parsed.events);

        thread.addLabel(parsedLabel);
        thread.moveToArchive();
      } catch (e) {
        appendParserError_(ctx.errorSheet, thread, e);
      }
    });
  } finally {
    try { lock.releaseLock(); } catch (_) {}
  }
}

function setupParserSheets() {
  getParserContext_();
}

function seedInventorySheet() {
  const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  const sh = getOrCreateSheet_(ss, INVENTORY_SHEET_NAME);
  ensureHeader_(sh, INVENTORY_HEADER, false);
  if (sh.getLastRow() > 1) {
    console.log('seedInventorySheet: inventory already has rows; leaving manual edits untouched.');
    return;
  }
  const rows = INVENTORY_DATA.map(row => INVENTORY_HEADER.map(h => row[h] || ''));
  if (rows.length) sh.getRange(2, 1, rows.length, INVENTORY_HEADER.length).setValues(rows);
}

function pruneVendorInventoryRows() {
  const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  const sh = getOrCreateSheet_(ss, INVENTORY_SHEET_NAME);
  const data = readSheetObjectsWithRows_(sh);
  const rowsToDelete = data
    .filter(item => isVendorInventoryRow_(item.values))
    .map(item => item.rowIndex)
    .sort((a, b) => b - a);
  rowsToDelete.forEach(rowIndex => sh.deleteRow(rowIndex));
  console.log('pruneVendorInventoryRows: deleted ' + rowsToDelete.length + ' vendor rows.');
}

function checkSheetDrift() {
  const ctx = getParserContext_();
  const checkedAt = new Date();
  const issues = [];
  const inventory = ctx.inventoryByKey;
  const stateData = readSheetObjectsWithRows_(ctx.stateSheet);
  const sleepData = readSheetObjectsWithRows_(ctx.sleepSheet);
  const activeSpaceCounts = {};
  const activeSleepRooms = {};

  stateData.forEach(item => {
    const row = item.values;
    const key = String(row.space_key || '').trim();
    const status = String(row.status || '').trim().toLowerCase();
    if (!key) {
      addDriftIssue_(issues, checkedAt, 'error', SPACE_STATE_SHEET_NAME, item.rowIndex, '', 'missing_space_key', 'space_state row has no space_key.');
      return;
    }

    const inv = inventory[key];
    if (!inv) {
      addDriftIssue_(issues, checkedAt, 'error', SPACE_STATE_SHEET_NAME, item.rowIndex, key, 'space_not_in_inventory', 'space_state key is not present in inventory.');
    } else {
      const stateType = String(row.space_type || '').trim().toUpperCase();
      const invType = String(inv.space_type || '').trim().toUpperCase();
      if (stateType && invType && stateType !== invType) {
        addDriftIssue_(issues, checkedAt, 'warning', SPACE_STATE_SHEET_NAME, item.rowIndex, key, 'space_type_mismatch', 'space_state=' + stateType + ', inventory=' + invType);
      }
      if (invType === 'SLEEP' && ACTIVE_STATUSES.has(status)) {
        activeSleepRooms[key] = true;
      }
    }

    if (!VALID_SPACE_STATE_STATUSES.has(status)) {
      addDriftIssue_(issues, checkedAt, 'warning', SPACE_STATE_SHEET_NAME, item.rowIndex, key, 'unexpected_status', 'status=' + status);
    }

    if (ACTIVE_STATUSES.has(status)) {
      activeSpaceCounts[key] = (activeSpaceCounts[key] || 0) + 1;
    }
  });

  Object.keys(activeSpaceCounts).forEach(key => {
    if (activeSpaceCounts[key] > 1) {
      addDriftIssue_(issues, checkedAt, 'error', SPACE_STATE_SHEET_NAME, '', key, 'duplicate_active_space_rows', activeSpaceCounts[key] + ' active rows for this space_key.');
    }
  });

  const activeSleepStateRooms = {};
  sleepData.forEach(item => {
    const row = item.values;
    const room = String(row.room || '').trim();
    const status = String(row.status || '').trim().toLowerCase();
    if (!room) {
      addDriftIssue_(issues, checkedAt, 'error', SLEEP_STATE_SHEET_NAME, item.rowIndex, '', 'missing_room', 'sleep_state row has no room value.');
      return;
    }
    const inv = inventory[room];
    if (!inv) {
      addDriftIssue_(issues, checkedAt, 'error', SLEEP_STATE_SHEET_NAME, item.rowIndex, room, 'room_not_in_inventory', 'sleep_state room is not present in inventory.');
    } else if (String(inv.space_type || '').trim().toUpperCase() !== 'SLEEP') {
      addDriftIssue_(issues, checkedAt, 'error', SLEEP_STATE_SHEET_NAME, item.rowIndex, room, 'room_not_sleep_type', 'inventory space_type=' + inv.space_type);
    }
    if (ACTIVE_STATUSES.has(status)) activeSleepStateRooms[room] = true;
  });

  Object.keys(activeSleepRooms).forEach(room => {
    if (!activeSleepStateRooms[room]) {
      addDriftIssue_(issues, checkedAt, 'warning', SLEEP_STATE_SHEET_NAME, '', room, 'active_sleep_missing_from_sleep_state', 'space_state marks this sleep room active, but sleep_state does not.');
    }
  });
  Object.keys(activeSleepStateRooms).forEach(room => {
    if (!activeSleepRooms[room]) {
      addDriftIssue_(issues, checkedAt, 'warning', SLEEP_STATE_SHEET_NAME, '', room, 'active_sleep_missing_from_space_state', 'sleep_state marks this room active, but space_state does not.');
    }
  });

  writeDriftIssues_(ctx.driftSheet, issues);
  console.log('checkSheetDrift: wrote ' + issues.length + ' issue rows.');
}

function getParserContext_() {
  const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  const inventorySheet = getOrCreateSheet_(ss, INVENTORY_SHEET_NAME);
  const stateSheet = getOrCreateSheet_(ss, SPACE_STATE_SHEET_NAME);
  const sleepSheet = getOrCreateSheet_(ss, SLEEP_STATE_SHEET_NAME);
  const auditSheet = getOrCreateSheet_(ss, AUDIT_SHEET_NAME);
  const errorSheet = getOrCreateSheet_(ss, ERROR_SHEET_NAME);
  const driftSheet = getOrCreateSheet_(ss, DRIFT_SHEET_NAME);

  ensureHeader_(inventorySheet, INVENTORY_HEADER, false);
  if (inventorySheet.getLastRow() < 2) seedInventorySheet();

  ensureHeader_(stateSheet, SPACE_STATE_HEADER, false);
  ensureHeader_(sleepSheet, SLEEP_STATE_HEADER, false);
  ensureHeader_(auditSheet, AUDIT_HEADER, false);
  ensureHeader_(errorSheet, ERROR_HEADER, false);
  ensureHeader_(driftSheet, DRIFT_HEADER, false);

  return {
    ss,
    inventorySheet,
    stateSheet,
    sleepSheet,
    auditSheet,
    errorSheet,
    driftSheet,
    inventoryByKey: readInventoryByKey_(inventorySheet),
    stateRows: readSpaceStateRows_(stateSheet),
    sleepRows: readSleepStateRows_(sleepSheet),
    auditIds: readAuditIds_(auditSheet)
  };
}

function fetchInboxBookwhenThreads_(parsedLabel) {
  const parsedName = parsedLabel.getName();
  return GmailApp.search(GMAIL_QUERY, 0, PAGE_SIZE).filter(thread => {
    return !thread.getLabels().some(label => label.getName() === parsedName);
  });
}

function parseMessageToEvents_(msg, thread, inventoryByKey) {
  const subject = msg.getSubject() || '';
  const bodyText = msg.getPlainBody() || '';
  const bodyHtml = msg.getBody() || '';
  const text = normalizeText_(bodyText || stripTags_(bodyHtml));
  const processedAt = new Date();
  const ref = extractRef_(subject, text);
  if (!ref) throw new Error('Missing Bookwhen ref.');

  const messageId = (msg.getId && msg.getId()) || '';
  const threadId = (thread.getId && thread.getId()) || '';
  const emailDate = (msg.getDate && msg.getDate()) || processedAt;
  const kind = classifyEmail_(subject, text);
  const contact = extractContactFields_(bodyHtml, bodyText);
  const ticket = extractTicket_(text);
  const quantity = extractQuantity_(text);
  const parserSpaces = extractEventSpaces_(kind, subject, text, inventoryByKey);

  const events = parserSpaces.map(item => {
    const inv = inventoryByKey[item.spaceKey] || {};
    const status = statusForEvent_(item.eventType, inv, ticket, quantity);
    const slotCount = slotCountForEvent_(status, inv, ticket, quantity);
    const display = contact.publicTeamName || contact.leadName || '';
    const publicSocial = normalizeSocial(contact.publicSocial || '');
    const eventId = [messageId, ref, item.eventType, item.spaceKey].join(':');

    return {
      event_id: eventId,
      processed_at: processedAt,
      email_date: emailDate,
      gmail_thread_id: threadId,
      gmail_message_id: messageId,
      bookwhen_ref: ref,
      event_type: item.eventType,
      space_key: item.spaceKey,
      space_type: inv.space_type || '',
      space_type_label: inv.space_type_label || '',
      space_label: inv.space_label || item.spaceKey,
      capacity: inv.capacity || '',
      building: inv.building || '',
      location: inv.location || '',
      ticket: ticket,
      quantity: quantity,
      slot_count: slotCount,
      status: status,
      display: display,
      public_social: publicSocial,
      lead_name: contact.leadName || '',
      lead_email: contact.leadEmail || '',
      lead_phone: contact.leadPhone || '',
      is_sleep: String(inv.is_sleep || '').toUpperCase() === 'TRUE',
      source_subject: subject,
      parse_notes: item.note || ''
    };
  });

  return { ref, kind, events };
}

function extractEventSpaces_(kind, subject, text, inventoryByKey) {
  const allText = subject + '\n' + text;
  const allKeys = extractParserScopeSpaceKeys_(allText, inventoryByKey);

  if (kind === 'booking_cancelled') {
    return allKeys.map(k => ({ spaceKey: k, eventType: 'booking_cancelled', note: 'Booking cancelled email.' }));
  }

  if (kind === 'ticket_changed') {
    const changeStart = text.search(/\bFrom:\s*/i);
    const changeText = changeStart >= 0 ? text.slice(changeStart) : text;
    const fromBlock = captureBetween_(changeText, /\bFrom:\s*/i, /\n\s*To:\s*/i);
    const toBlock = captureBetween_(changeText, /\n\s*To:\s*/i, /\n\s*(?:View booking|Booking contact:)/i);
    const fromKeys = new Set(extractParserScopeSpaceKeys_(fromBlock, inventoryByKey));
    const toKeys = new Set(extractParserScopeSpaceKeys_(toBlock, inventoryByKey));
    const out = [];

    fromKeys.forEach(k => out.push({ spaceKey: k, eventType: 'ticket_changed_from', note: 'Ticket changed From block.' }));
    toKeys.forEach(k => out.push({ spaceKey: k, eventType: 'ticket_changed_to', note: 'Ticket changed To block.' }));
    allKeys.forEach(k => {
      if (!fromKeys.has(k) && !toKeys.has(k)) {
        out.push({ spaceKey: k, eventType: 'ticket_active', note: 'Additional active space on ticket-changed booking.' });
      }
    });
    return dedupeSpaceEvents_(out);
  }

  return allKeys.map(k => ({ spaceKey: k, eventType: 'new_booking', note: 'New booking email.' }));
}

function extractParserScopeSpaceKeys_(raw, inventoryByKey) {
  const text = normalizeText_(raw);
  const keys = [];
  const push = key => {
    const k = toSiteKey_(key);
    if (!k || keys.indexOf(k) !== -1) return;
    const inv = inventoryByKey[k];
    if (!inv) return;
    if (String(inv.parser_scope || '').toUpperCase() !== 'TRUE') return;
    if (VENDOR_TYPES.has(inv.space_type)) return;
    keys.push(k);
  };

  let m;
  const roomRx = /\b(?:Room\s+)?(\d{3})\s+(?:Small|Medium|Large|Extra[-\s]*Large|Opener|Entourage|Headliner|Encore)\b/ig;
  while ((m = roomRx.exec(text)) !== null) push(m[1]);

  const ariumRx = /\b(?:Arium|Flex\s*Lounge)\s*A(\d{1,2})\b/ig;
  while ((m = ariumRx.exec(text)) !== null) push('A' + m[1]);

  const dreamRx = /\bDream\s*Tent\s+(\d{1,2})\b/ig;
  while ((m = dreamRx.exec(text)) !== null) push('DT' + m[1]);

  return keys;
}

function applyEventsToSpaceState_(sheet, stateRows, events) {
  events.forEach(event => {
    if (RELEASE_EVENT_TYPES.has(event.event_type)) {
      releaseSpaceState_(sheet, stateRows, event);
      return;
    }
    if (ACTIVE_EVENT_TYPES.has(event.event_type)) {
      createSpaceStateIfMissing_(sheet, stateRows, event);
    }
  });
}

function createSpaceStateIfMissing_(sheet, stateRows, event) {
  const existing = stateRows.bySpaceKey[event.space_key];
  const existingStatus = existing ? String(existing.values.status || '').trim().toLowerCase() : '';
  if (existing && existingStatus !== 'cancelled' && existingStatus !== 'released') {
    return;
  }

  const rowObj = {
    space_key: event.space_key,
    date: event.email_date,
    display: event.is_sleep ? '' : event.display,
    public_social: event.is_sleep ? '' : event.public_social,
    status: event.status,
    lead_name: event.lead_name,
    lead_email: event.lead_email,
    lead_phone: event.lead_phone,
    space_type: event.space_type,
    bookwhen_ref: event.bookwhen_ref,
    last_bookwhen_event_at: event.email_date,
    last_parser_update_at: event.processed_at,
    admin_notes: ''
  };
  appendObjectRow_(sheet, SPACE_STATE_HEADER, rowObj);
  const rowIndex = sheet.getLastRow();
  stateRows.bySpaceKey[event.space_key] = { rowIndex, values: rowObj };
  stateRows.byRefSpace[event.bookwhen_ref + '|' + event.space_key] = { rowIndex, values: rowObj };
}

function releaseSpaceState_(sheet, stateRows, event) {
  const refKey = event.bookwhen_ref + '|' + event.space_key;
  const found = stateRows.byRefSpace[refKey];
  if (!found) {
    return;
  }
  const rowIndex = found.rowIndex;
  const updates = {
    status: 'cancelled',
    last_bookwhen_event_at: event.email_date,
    last_parser_update_at: event.processed_at,
    admin_notes: appendNote_(found.values.admin_notes, event.event_type + ' ' + event.bookwhen_ref)
  };
  patchObjectRow_(sheet, SPACE_STATE_HEADER, rowIndex, updates);
}

function applyEventsToSleepState_(sheet, sleepRows, events) {
  events.forEach(event => {
    if (!event.is_sleep) return;
    if (RELEASE_EVENT_TYPES.has(event.event_type)) {
      releaseSleepState_(sheet, sleepRows, event);
      return;
    }
    if (ACTIVE_EVENT_TYPES.has(event.event_type)) {
      createSleepStateIfMissing_(sheet, sleepRows, event);
    }
  });
}

function createSleepStateIfMissing_(sheet, sleepRows, event) {
  const refRoom = event.bookwhen_ref + '|' + event.space_key;
  if (sleepRows.byRefRoom[refRoom]) return;
  const existing = sleepRows.byRoom[event.space_key];
  const existingStatus = existing ? String(existing.values.status || '').trim().toLowerCase() : '';
  if (existing && existingStatus !== 'cancelled' && existingStatus !== 'released') return;

  const rowObj = {
    room: event.space_key,
    room_type: roomTypeFromEvent_(event),
    status: 'full',
    bookwhen_ref: event.bookwhen_ref,
    lead_name: event.lead_name,
    lead_email: event.lead_email,
    lead_phone: event.lead_phone,
    booking_date: event.email_date,
    last_bookwhen_event_at: event.email_date,
    venue_notes: ''
  };
  appendObjectRow_(sheet, SLEEP_STATE_HEADER, rowObj);
  const rowIndex = sheet.getLastRow();
  sleepRows.byRoom[event.space_key] = { rowIndex, values: rowObj };
  sleepRows.byRefRoom[refRoom] = { rowIndex, values: rowObj };
}

function releaseSleepState_(sheet, sleepRows, event) {
  const found = sleepRows.byRefRoom[event.bookwhen_ref + '|' + event.space_key];
  if (!found) return;
  patchObjectRow_(sheet, SLEEP_STATE_HEADER, found.rowIndex, {
    status: 'cancelled',
    last_bookwhen_event_at: event.email_date
  });
}

function roomTypeFromEvent_(event) {
  const label = String(event.space_label || '').replace(/^Room\s+\d+\s*/i, '').trim();
  if (label) return label;
  const ticket = String(event.ticket || '').trim();
  return ticket || event.space_type_label || 'Sleep Room';
}

function appendAuditEvents_(sheet, auditIds, events) {
  const rows = [];
  events.forEach(event => {
    if (auditIds[event.event_id]) return;
    rows.push(AUDIT_HEADER.map(h => event[h] == null ? '' : event[h]));
    auditIds[event.event_id] = true;
  });
  if (rows.length) {
    sheet.getRange(sheet.getLastRow() + 1, 1, rows.length, AUDIT_HEADER.length).setValues(rows);
  }
}

function appendParserError_(sheet, thread, error) {
  const msgs = thread.getMessages();
  const msg = msgs[msgs.length - 1];
  const row = {
    processed_at: new Date(),
    gmail_thread_id: (thread.getId && thread.getId()) || '',
    gmail_message_id: (msg.getId && msg.getId()) || '',
    subject: msg.getSubject() || '',
    reason: String(error && error.message || error),
    excerpt: normalizeText_(msg.getPlainBody() || '').slice(0, 500)
  };
  appendObjectRow_(sheet, ERROR_HEADER, row);
  console.warn('Parser error:', row.subject, row.reason);
}

function doGet(e) {
  const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  const sh = ss.getSheetByName(SPACE_STATE_SHEET_NAME);
  if (!sh || sh.getLastRow() < 2) {
    return jsonResponse_({ spaces: {}, updated_at: new Date().toISOString() });
  }

  const rows = readSheetObjects_(sh);
  const spaces = {};
  rows.forEach(row => {
    const key = String(row.space_key || '').trim();
    if (!key) return;
    const status = String(row.status || '').trim().toLowerCase();
    if (!ACTIVE_STATUSES.has(status)) return;

    const isSleep = String(row.space_type || '').trim().toUpperCase() === 'SLEEP';
    if (isSleep) {
      spaces[key] = { status: 'full' };
      return;
    }

    const name = String(row.display || '').trim();
    const social = String(row.public_social || '').trim();
    const ticket = '';
    const group = { name, social, ticket };
    spaces[key] = {
      status: status === 'partial' ? '' : 'full',
      name,
      social,
      groups: (name || social || ticket) ? [group] : []
    };
  });

  return jsonResponse_({ spaces, updated_at: new Date().toISOString() });
}

function installTimeTrigger() {
  ScriptApp.getProjectTriggers()
    .filter(t => t.getHandlerFunction && t.getHandlerFunction() === 'runParser')
    .forEach(t => {
      try { ScriptApp.deleteTrigger(t); } catch (_) {}
    });
  ScriptApp.newTrigger('runParser').timeBased().everyHours(1).create();
}

function getOrCreateSheet_(ss, name) {
  return ss.getSheetByName(name) || ss.insertSheet(name);
}

function ensureHeader_(sheet, header, clearIfMismatch) {
  const width = header.length;
  const have = sheet.getRange(1, 1, 1, width).getValues()[0];
  const matches = header.every((h, i) => String(have[i] || '') === h);
  if (matches) return;
  if (clearIfMismatch) sheet.clear();
  sheet.getRange(1, 1, 1, width).setValues([header]);
}

function readInventoryByKey_(sheet) {
  const rows = readSheetObjects_(sheet);
  const map = {};
  rows.forEach(row => {
    const key = String(row.space_key || '').trim();
    if (key) map[key] = row;
  });
  return map;
}

function readSpaceStateRows_(sheet) {
  const data = readSheetObjectsWithRows_(sheet);
  const bySpaceKey = {};
  const byRefSpace = {};
  data.forEach(item => {
    const key = String(item.values.space_key || '').trim();
    const ref = String(item.values.bookwhen_ref || '').trim();
    if (key) bySpaceKey[key] = item;
    if (key && ref) byRefSpace[ref + '|' + key] = item;
  });
  return { bySpaceKey, byRefSpace };
}

function readSleepStateRows_(sheet) {
  const data = readSheetObjectsWithRows_(sheet);
  const byRoom = {};
  const byRefRoom = {};
  data.forEach(item => {
    const room = String(item.values.room || '').trim();
    const ref = String(item.values.bookwhen_ref || '').trim();
    if (room) byRoom[room] = item;
    if (room && ref) byRefRoom[ref + '|' + room] = item;
  });
  return { byRoom, byRefRoom };
}

function readAuditIds_(sheet) {
  const rows = readSheetObjects_(sheet);
  const ids = {};
  rows.forEach(row => {
    const id = String(row.event_id || '').trim();
    if (id) ids[id] = true;
  });
  return ids;
}

function addDriftIssue_(issues, checkedAt, severity, tab, row, spaceKey, issue, details) {
  issues.push({
    checked_at: checkedAt,
    severity: severity,
    tab: tab,
    row: row || '',
    space_key: spaceKey || '',
    issue: issue,
    details: details || ''
  });
}

function writeDriftIssues_(sheet, issues) {
  ensureHeader_(sheet, DRIFT_HEADER, true);
  if (!issues.length) return;
  const rows = issues.map(issue => DRIFT_HEADER.map(h => issue[h] == null ? '' : issue[h]));
  sheet.getRange(2, 1, rows.length, DRIFT_HEADER.length).setValues(rows);
}

function isVendorInventoryRow_(row) {
  const type = String(row.space_type || row.source_space_type || '').trim().toUpperCase();
  const category = String(row.map_category || '').trim().toLowerCase();
  const label = String(row.space_label || '').trim();
  return VENDOR_TYPES.has(type) || category === 'vendor' || /^Vendor\b/i.test(label);
}

function readSheetObjects_(sheet) {
  return readSheetObjectsWithRows_(sheet).map(item => item.values);
}

function readSheetObjectsWithRows_(sheet) {
  const lastRow = sheet.getLastRow();
  const lastCol = sheet.getLastColumn();
  if (lastRow < 2 || lastCol < 1) return [];
  const values = sheet.getRange(1, 1, lastRow, lastCol).getValues();
  const header = values[0].map(h => String(h || '').trim());
  const out = [];
  for (let r = 1; r < values.length; r++) {
    const obj = {};
    header.forEach((h, i) => { if (h) obj[h] = values[r][i]; });
    out.push({ rowIndex: r + 1, values: obj });
  }
  return out;
}

function appendObjectRow_(sheet, header, obj) {
  sheet.getRange(sheet.getLastRow() + 1, 1, 1, header.length)
    .setValues([header.map(h => obj[h] == null ? '' : obj[h])]);
}

function patchObjectRow_(sheet, header, rowIndex, updates) {
  Object.keys(updates).forEach(key => {
    const col = header.indexOf(key) + 1;
    if (col > 0) sheet.getRange(rowIndex, col).setValue(updates[key]);
  });
}

function extractRef_(subject, text) {
  const m = String(subject + '\n' + text).match(/\bRef:\s*([A-Z0-9-]+)\b/i);
  return m ? m[1].toUpperCase() : '';
}

function classifyEmail_(subject, text) {
  const s = String(subject + '\n' + text);
  if (/Booking cancelled/i.test(s) || /has been cancelled/i.test(s)) return 'booking_cancelled';
  if (/Ticket changed/i.test(s) || /Ticket on booking .* changed/i.test(s)) return 'ticket_changed';
  return 'new_booking';
}

function extractContactFields_(html, text) {
  const plain = normalizeText_(stripTags_(html) + '\n' + text);
  const bookingContactEmail = extractBookingContactEmail_(plain);
  return {
    leadName: extractLeadName_(plain),
    leadEmail: bookingContactEmail || extractFirstEmail_(plain),
    leadPhone: extractPhone_(plain),
    publicTeamName: extractFieldAfterLabel_(plain, /\(Public\)\s*Team\/Group\/Shop\s*Name/i),
    publicSocial: extractFieldAfterLabel_(plain, /Instagram\s*\(preferred\),?\s*or\s*website/i)
  };
}

function extractLeadName_(plain) {
  const m = plain.match(/\b([A-Z][A-Za-z'.-]+(?:\s+[A-Z][A-Za-z'.-]+)+)\s+[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/);
  if (!m) return '';
  if (/Void Tattoo Fest/i.test(m[1])) return '';
  return m[1].trim();
}

function extractBookingContactEmail_(plain) {
  const m = plain.match(/Booking contact:\s*([A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,})/i);
  return m ? m[1].trim() : '';
}

function extractFirstEmail_(plain) {
  const m = plain.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/);
  return m ? m[0].trim() : '';
}

function extractPhone_(plain) {
  const m = plain.match(/Phone Number\s+((?:\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4})/i) ||
    plain.match(/(?:\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}/);
  return m ? String(m[1] || m[0]).trim() : '';
}

function extractFieldAfterLabel_(plain, labelRx) {
  const lines = String(plain || '').split(/\n+/).map(s => s.trim()).filter(Boolean);
  for (let i = 0; i < lines.length; i++) {
    if (labelRx.test(lines[i])) {
      for (let j = i + 1; j < lines.length; j++) {
        const v = lines[j].trim();
        if (!v) continue;
        if (/^(Phone Number|Address|Booking details:|Do you agree|Additional information|Other artists included)/i.test(v)) continue;
        if (/^Yes\s+-\s+at time of booking$/i.test(v)) continue;
        if (/^[-–—]$/.test(v)) continue;
        if (labelRx.source.indexOf('Team') >= 0 && /@|https?:\/\/|instagram\.com/i.test(v)) continue;
        return v;
      }
    }
  }
  return '';
}

function extractTicket_(plain) {
  const patterns = [
    /\d+\s*x\s*Buy[-\s]?out\s*\(Full\s*Booth\)/i,
    /Buy[-\s]?out\s*\(Full\s*Booth\)/i,
    /Half\s*Booth\s*\(4\s*Artists?\)/i,
    /Duo\s*\(?.*?2\s*Artist\s*Slots?\)?/i,
    /Single\s*Artist\s*Slot/i,
    /Opener Queen|Entourage Double Queens?|Headliner King|Encore King/i
  ];
  for (let i = 0; i < patterns.length; i++) {
    const m = plain.match(patterns[i]);
    if (m) return m[0].trim();
  }
  return '';
}

function extractQuantity_(plain) {
  const m = String(plain || '').match(/\b(\d+)\s*x\s*Buy[-\s]?out/i);
  return m ? parseInt(m[1], 10) : 1;
}

function statusForEvent_(eventType, inv, ticket, quantity) {
  if (RELEASE_EVENT_TYPES.has(eventType)) return 'cancelled';
  if (String(inv.is_sleep || '').toUpperCase() === 'TRUE') return 'full';
  if (/buy[-\s]?out/i.test(ticket)) return 'full';
  const capacity = parseInt(inv.capacity || '1', 10) || 1;
  return quantity >= capacity ? 'full' : 'partial';
}

function slotCountForEvent_(status, inv, ticket, quantity) {
  if (status === 'cancelled') return 0;
  if (/buy[-\s]?out/i.test(ticket)) return parseInt(inv.capacity || quantity || 1, 10) || 1;
  if (/half\s*booth/i.test(ticket)) return 4;
  if (/duo/i.test(ticket)) return 2;
  return quantity || 1;
}

function toSiteKey_(raw) {
  const k = String(raw || '').trim();
  if (!k) return '';
  if (/^\d{3}$/.test(k)) return k;
  if (/^A\d{1,2}$/i.test(k)) return k.toLowerCase();
  if (/^DT\d{1,2}$/i.test(k)) return String(parseInt(k.replace(/^DT/i, ''), 10));
  return k.toLowerCase();
}

function dedupeSpaceEvents_(events) {
  const seen = {};
  return events.filter(event => {
    const key = event.spaceKey + '|' + event.eventType;
    if (seen[key]) return false;
    seen[key] = true;
    return true;
  });
}

function captureBetween_(text, startRx, endRx) {
  const src = String(text || '');
  const start = src.search(startRx);
  if (start < 0) return '';
  const tail = src.slice(start).replace(startRx, '');
  const end = tail.search(endRx);
  return end < 0 ? tail : tail.slice(0, end);
}

function normalizeSocial(raw) {
  let s = String(raw || '').trim();
  if (!s || /^[-–—]$/.test(s)) return '';
  const ig = s.match(/(?:https?:\/\/)?(?:www\.)?instagram\.com\/@?([a-z0-9._]+)/i);
  if (ig) return '@' + ig[1];
  const at = s.match(/^@?([a-z0-9._]{2,})$/i);
  if (at && !s.includes('.')) return '@' + at[1];
  return s.replace(/^https?:\/\//i, '').replace(/^www\./i, '').replace(/\/$/, '');
}

function normalizeText_(raw) {
  return String(raw || '')
    .replace(/\r/g, '\n')
    .replace(/[\u2012\u2013\u2014\u2212]/g, '-')
    .replace(/\t/g, ' ')
    .replace(/[ ]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function stripTags_(html) {
  return String(html || '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(?:p|div|tr|li|td|h\d)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&');
}

function appendNote_(existing, note) {
  const old = String(existing || '').trim();
  return old ? old + ' | ' + note : note;
}

function getOrCreateLabel_(name) {
  return GmailApp.getUserLabelByName(name) || GmailApp.createLabel(name);
}

function jsonResponse_(payload) {
  return ContentService.createTextOutput(JSON.stringify(payload))
    .setMimeType(ContentService.MimeType.JSON);
}
