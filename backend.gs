// ID del foglio Google Sheets che contiene i dati delle prenotazioni
const SPREADSHEET_ID = '1iV5mfvw12YAUbl91rFbpqLa-ksWMmUkzXS5BUnylLjY';

// Nome dei fogli all'interno del tuo spreadsheet
const SHEETS = {
  BOOKINGS: 'Prenotazioni',
  CONFIG: 'dashboard'
};

// Funzione principale che gestisce le richieste web
function doGet(e) {
  // Se non c'è nessun parametro, mostra l'interfaccia utente
  if (!e.parameter.action) {
    return HtmlService.createHtmlOutputFromFile('index')
      .setTitle('Prenotazione Campi Padel')
      .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
  }
  
  // Altrimenti processa la richiesta API in base all'azione
  const output = ContentService.createTextOutput();
  output.setMimeType(ContentService.MimeType.JSON);
  
  try {
    let result;
    switch (e.parameter.action) {
      case 'checkAvailability':
        result = checkAvailability(e.parameter);
        break;
      case 'createBooking':
        result = createBooking(e.parameter);
        break;
      case 'getAvailableTimes':
        result = getAvailableTimes(e.parameter);
        break;
      case 'getGrid':
        result = getAvailabilityGrid(e.parameter);
        break;
      default:
        result = { success: false, error: `Azione non valida: ${e.parameter.action}` };
    }
    
    output.setContent(JSON.stringify(result));
  } catch (error) {
    output.setContent(JSON.stringify({
      success: false,
      error: `Errore: ${error.message || error}`
    }));
  }
  
  return output;
}

/**
 * Funzione per elaborare le richieste dal client
 * Questa funzione viene chiamata direttamente dall'HTML tramite google.script.run
 */
function processClientRequest(action, params) {
  try {
    switch(action) {
      case 'checkAvailability':
        return checkAvailability(params);
      case 'createBooking':
        return createBooking(params);
      case 'getAvailableTimes':
        return getAvailableTimes(params);
      case 'getGridData':
        return getAvailabilityGrid(params);
      default:
        return { success: false, error: `Azione non valida: ${action}` };
    }
  } catch (error) {
    console.error('Errore durante l\'elaborazione della richiesta:', error);
    return { 
      success: false, 
      error: `Errore durante l'elaborazione: ${error.message || error}`
    };
  }
}

/**
 * Verifica se uno slot è disponibile
 * @param {Object} params - Parametri della richiesta
 * @return {Object} Risultato della verifica
 */
function checkAvailability(params) {
  const { data, campo, orario } = params;
  
  // Validazione input
  if (!data || !campo || !orario) {
    return { success: false, error: 'Parametri mancanti' };
  }
  
  // Ottieni tutte le prenotazioni esistenti
  const bookings = getBookings();
  
  // Verifica se esiste già una prenotazione con questi parametri
  const conflictingBooking = bookings.find(booking => 
    booking.data === data && 
    booking.campo === campo && 
    booking.orario === orario
  );
  
  if (conflictingBooking) {
    return { 
      success: false, 
      error: 'Questo slot è già prenotato' 
    };
  }
  
  // Controlla anche le sovrapposizioni per prenotazioni adiacenti
  const hasOverlap = checkTimeOverlap(bookings, data, campo, orario);
  if (hasOverlap) {
    return {
      success: false,
      error: 'Questo orario si sovrappone a una prenotazione esistente'
    };
  }
  
  return { success: true };
}

/**
 * Crea una nuova prenotazione
 * @param {Object} params - Parametri della prenotazione
 * @return {Object} Risultato dell'operazione
 */
function createBooking(params) {
  const { data, campo, orario, utente, email, telefono } = params;
  
  // Validazione input
  if (!data || !campo || !orario) {
    return { success: false, error: 'Parametri mancanti' };
  }
  
  // Verifica prima che lo slot sia disponibile
  const availabilityCheck = checkAvailability(params);
  if (!availabilityCheck.success) {
    return availabilityCheck;
  }
  
  try {
    // Apri il foglio delle prenotazioni
    const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
    const sheet = ss.getSheetByName(SHEETS.BOOKINGS);
    
    // Crea un ID univoco per la prenotazione
    const bookingId = Utilities.getUuid();
    
    // Ottieni la data attuale
    const now = new Date();
    const dateCreated = Utilities.formatDate(now, Session.getScriptTimeZone(), "dd/MM/yyyy HH:mm:ss");
    
    // Formatta la data per evitare problemi
    let formattedDate = formatDateForStorage(data);
    
    // Aggiungi la prenotazione al foglio
    sheet.appendRow([
      bookingId,                // ID prenotazione
      formattedDate,            // Data prenotazione
      campo,                    // Campo selezionato
      orario,                   // Orario selezionato
      utente || 'N/A',          // Nome utente (se fornito)
      email || 'N/A',           // Email (se fornita)
      telefono || 'N/A',        // Telefono (se fornito)
      'confermata',             // Stato
      dateCreated               // Data creazione record
    ]);
    
    // Invia email di conferma se abbiamo l'email
    if (email) {
      sendConfirmationEmail(email, {
        bookingId,
        data: formattedDate,
        campo,
        orario,
        utente
      });
    }
    
    return { 
      success: true, 
      bookingId,
      message: 'Prenotazione creata con successo'
    };
  } catch (error) {
    console.error('Errore durante la creazione della prenotazione:', error);
    return { 
      success: false, 
      error: 'Errore durante la creazione della prenotazione: ' + error.message
    };
  }
}

/**
 * Ottiene gli orari disponibili per una data e campo specifici
 * @param {Object} params - Parametri della richiesta
 * @return {Object} Lista degli orari disponibili
 */
function getAvailableTimes(params) {
  const { data, campo } = params;
  
  // Validazione input
  if (!data || !campo) {
    return { success: false, error: 'Parametri mancanti' };
  }
  
  // Ottieni tutti gli orari possibili (dalla configurazione)
  const allTimeSlots = getTimeSlots();
  
  // Ottieni tutte le prenotazioni esistenti
  const bookings = getBookings();
  const formattedDate = formatDateForComparison(data);
  
  // Filtra gli slot disponibili escludendo quelli già prenotati
  // e quelli che si sovrappongono a prenotazioni esistenti
  const availableSlots = allTimeSlots.filter(slot => {
    // Verifica le sovrapposizioni
    return !checkTimeOverlap(bookings, formattedDate, campo, slot);
  });
  
  return { 
    success: true, 
    availableTimes: availableSlots
  };
}

/**
 * Ottiene la griglia di disponibilità per una data
 * @param {Object} params - Parametri della richiesta
 * @return {Object} Dati della griglia di disponibilità
 */
function getAvailabilityGrid(params) {
  const { data } = params;
  
  // Validazione input
  if (!data) {
    return { success: false, error: 'Data mancante' };
  }
  
  // Ottieni la configurazione dei campi
  const courts = getCourts();
  
  // Ottieni tutti gli orari possibili
  const allTimeSlots = getTimeSlots();
  
  // Ottieni tutte le prenotazioni e formatta la data
  const bookings = getBookings();
  const formattedDate = formatDateForComparison(data);
  
  // Prepara la griglia
  const grid = allTimeSlots.map(timeSlot => {
    const slotData = {
      time: timeSlot,
      courts: {}
    };
    
    // Per ogni campo, verifica la disponibilità
    courts.forEach(court => {
      // Controlla se c'è una sovrapposizione
      const hasOverlap = checkTimeOverlap(bookings, formattedDate, court, timeSlot);
      
      slotData.courts[court] = {
        available: !hasOverlap,
        status: !hasOverlap ? 'available' : 'booked'
      };
    });
    
    return slotData;
  });
  
  return {
    success: true,
    date: data,
    grid
  };
}

/**
 * Verifica le sovrapposizioni tra prenotazioni - MIGLIORATA
 * @param {Array} bookings - Lista delle prenotazioni esistenti
 * @param {string} date - Data da verificare
 * @param {string} court - Campo da verificare
 * @param {string} timeSlot - Slot orario da verificare (es. "10:00-11:30")
 * @return {boolean} True se c'è sovrapposizione
 */
function checkTimeOverlap(bookings, date, court, timeSlot) {
  // Estrai l'orario di inizio e fine dello slot
  const [startTime, endTime] = timeSlot.split('-').map(t => t.trim());
  
  // Converti in minuti per facilitare il confronto
  const slotStart = timeToMinutes(startTime);
  const slotEnd = timeToMinutes(endTime);
  
  // Log dettagliato per debug
  console.log(`Verifica sovrapposizioni per: ${date}, ${court}, ${timeSlot}`);
  
  // Filtra le prenotazioni ATTIVE per la stessa data e campo
  const courtBookings = bookings.filter(booking => {
    // Standardizza il formato della data per un confronto coerente
    const bookingDate = formatDateForComparison(booking.data);
    const targetDate = formatDateForComparison(date);
    
    // Verifica data, campo e stato
    const matchesDate = bookingDate === targetDate;
    const matchesCourt = booking.campo === court;
    const isActive = booking.stato !== 'cancellata';
    
    if (matchesDate && matchesCourt && isActive) {
      console.log(`Prenotazione trovata: ${booking.data}, ${booking.campo}, ${booking.orario}`);
    }
    
    return matchesDate && matchesCourt && isActive;
  });
  
  // Verifica le sovrapposizioni
  return courtBookings.some(booking => {
    const [bookingStart, bookingEnd] = booking.orario.split('-').map(t => t.trim());
    const bookedStart = timeToMinutes(bookingStart);
    const bookedEnd = timeToMinutes(bookingEnd);
    
    // Controllo di sovrapposizione semplificato e corretto
    const hasOverlap = (slotStart < bookedEnd) && (slotEnd > bookedStart);
    
    if (hasOverlap) {
      console.log(`Sovrapposizione con: ${booking.orario}`);
    }
    
    return hasOverlap;
  });
}

/**
 * Converte un orario in formato HH:MM in minuti totali
 * @param {string} time - Orario in formato HH:MM
 * @return {number} Minuti totali
 */
function timeToMinutes(time) {
  const [hours, minutes] = time.split(':').map(Number);
  return hours * 60 + minutes;
}

/**
 * Ottiene tutte le prenotazioni dal foglio
 * @return {Array} Lista delle prenotazioni
 */
function getBookings() {
  const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  const sheet = ss.getSheetByName(SHEETS.BOOKINGS);
  
  // Ottieni tutte le righe tranne l'intestazione
  const data = sheet.getDataRange().getValues();
  const headers = data[0];
  
  // Mappa gli indici delle colonne
  const idxId = headers.indexOf('ID');
  const idxData = headers.indexOf('Data');
  const idxCampo = headers.indexOf('Campo');
  const idxOrario = headers.indexOf('Orario');
  const idxStato = headers.indexOf('Stato');
  
  // Se non troviamo le colonne corrette, log e restituisci array vuoto
  if (idxId === -1 || idxData === -1 || idxCampo === -1 || idxOrario === -1 || idxStato === -1) {
    console.error('Intestazioni mancanti nel foglio Prenotazioni. Trovate:', headers);
    return [];
  }
  
  // Crea un array di oggetti prenotazione
  return data.slice(1).map(row => ({
    id: row[idxId],
    data: row[idxData],
    campo: row[idxCampo],
    orario: row[idxOrario],
    stato: row[idxStato]
  })).filter(booking => booking.stato !== 'cancellata');
}

/**
 * Ottiene la lista di tutti gli orari configurati
 * @return {Array} Lista degli orari disponibili
 */
function getTimeSlots() {
  // Puoi leggere questa lista dal foglio di configurazione
  // Per ora, la definiamo direttamente nel codice
  return [
    "09:00-10:30", "09:30-11:00", "10:00-11:30", "10:30-12:00",
    "11:00-12:30", "11:30-13:00", "12:00-13:30", "12:30-14:00",
    "13:00-14:30", "13:30-15:00", "14:00-15:30", "14:30-16:00",
    "15:00-16:30", "15:30-17:00", "16:00-17:30", "16:30-18:00",
    "17:00-18:30", "17:30-19:00", "18:00-19:30", "18:30-20:00",
    "19:00-20:30", "19:30-21:00", "20:00-21:30"
  ];
}

/**
 * Ottiene la lista dei campi disponibili
 * @return {Array} Lista dei campi
 */
function getCourts() {
  // Puoi leggere questa lista dal foglio di configurazione
  // Per ora, la definiamo direttamente nel codice
  return ["Campo 1", "Campo 2"];
}

/**
 * Formatta una data per il confronto
 * @param {string} date - Data in formato DD/MM/YYYY o YYYY-MM-DD
 * @return {string} Data formattata in YYYY-MM-DD per confronti coerenti
 */
function formatDateForComparison(date) {
  if (!date) return '';
  
  // Se la data è nel formato GG/MM/AAAA, converti in AAAA-MM-GG per il confronto
  if (date.includes('/')) {
    const parts = date.split('/');
    if (parts.length === 3) {
      return `${parts[2]}-${parts[1].padStart(2, '0')}-${parts[0].padStart(2, '0')}`;
    }
  }
  return date; // Già in formato AAAA-MM-GG
}

/**
 * Formatta una data per la memorizzazione
 * @param {string} date - Data in formato DD/MM/YYYY o YYYY-MM-DD
 * @return {string} Data formattata per la memorizzazione
 */
function formatDateForStorage(date) {
  if (!date) return '';
  
  // Se la data è nel formato AAAA-MM-GG, converti in GG/MM/AAAA per la memorizzazione
  if (date.includes('-')) {
    const parts = date.split('-');
    if (parts.length === 3) {
      return `${parts[2]}/${parts[1]}/${parts[0]}`;
    }
  }
  return date; // Già in formato GG/MM/AAAA
}

/**
 * Formatta una data per la visualizzazione
 * @param {string} date - Data in formato DD/MM/YYYY o YYYY-MM-DD
 * @return {string} Data formattata per la visualizzazione come DD/MM/YYYY
 */
function formatDateForDisplay(date) {
  if (!date) return '';
  
  // Se la data è nel formato AAAA-MM-GG, converti in GG/MM/AAAA per la visualizzazione
  if (date.includes('-')) {
    const parts = date.split('-');
    if (parts.length === 3) {
      return `${parts[2]}/${parts[1]}/${parts[0]}`;
    }
  }
  return date; // Già in formato GG/MM/AAAA
}

/**
 * Invia un'email di conferma all'utente
 * @param {string} email - Indirizzo email del destinatario
 * @param {Object} booking - Dati della prenotazione
 */
function sendConfirmationEmail(email, booking) {
  const subject = 'Conferma Prenotazione Campo Padel';
  const body = `
Gentile Cliente,

La tua prenotazione è stata confermata con successo!

Dettagli prenotazione:
- ID Prenotazione: ${booking.bookingId}
- Data: ${booking.data}
- Campo: ${booking.campo}
- Orario: ${booking.orario}

Ti aspettiamo!

Centro Padel
  `;
  
  try {
    MailApp.sendEmail(email, subject, body);
  } catch (error) {
    console.error('Errore durante l\'invio dell\'email:', error);
  }
}

/**
 * Funzione per generare HTML della griglia
 * @param {string} date - Data per la quale generare la griglia
 * @return {string} HTML della griglia di disponibilità
 */
function getGridHtml(date) {
  // Formatta la data per la query
  const formattedDate = formatDateForComparison(date);
  
  // Ottieni i dati della griglia
  const gridData = getAvailabilityGrid({ data: formattedDate });
  
  if (!gridData.success) {
    return `<div class="error">Errore nel caricamento della griglia: ${gridData.error}</div>`;
  }
  
  // Ottieni i campi e gli slot orari
  const courts = getCourts();
  const timeSlots = getTimeSlots();
  
  // Data visualizzata
  const displayDate = formatDateForDisplay(date);
  
  // Genera l'HTML della griglia
  let html = `
    <div class="grid-header">Disponibilità del ${displayDate}</div>
    <div class="grid-content">
      <table>
        <thead>
          <tr>
            <th>Orario</th>
  `;
  
  // Intestazioni colonne per ogni campo
  courts.forEach(court => {
    html += `<th>${court}</th>`;
  });
  
  html += `
          </tr>
        </thead>
        <tbody>
  `;
  
  // Riga per ogni slot orario
  gridData.grid.forEach(slot => {
    html += `
      <tr>
        <td class="time-cell">${slot.time}</td>
    `;
    
    // Colonna per ogni campo
    courts.forEach(court => {
      const isAvailable = slot.courts[court]?.available;
      const cellClass = isAvailable ? "available-cell" : "booked-cell";
      const cellText = isAvailable ? "Disponibile" : "Occupato";
      
      html += `
        <td class="${cellClass}" data-time="${slot.time}" data-court="${court}">
          ${cellText}
        </td>
      `;
    });
    
    html += `</tr>`;
  });
  
  html += `
        </tbody>
      </table>
    </div>
  `;
  
  return html;
}

// Aggiungi questa funzione - importantissima per la griglia
function getBookingsForDate(date) {
  // Ottieni tutte le prenotazioni
  const bookings = getBookings();
  
  // Assicurati che la data sia in formato coerente per il confronto
  const formattedDate = formatDateForComparison(date);
  
  // Filtra le prenotazioni per la data specificata
  return bookings.filter(booking => {
    const bookingDate = formatDateForComparison(booking.data);
    return bookingDate === formattedDate && booking.stato !== 'cancellata';
  });
}

// Modifica la funzione getGridHtml per usare la nuova funzione
function getGridHtml(date) {
  // Ottieni le prenotazioni per la data selezionata
  const dateBookings = getBookingsForDate(date);
  
  // Ottieni i campi e gli slot orari
  const courts = getCourts();
  const timeSlots = getTimeSlots();
  
  // Formatta la data per la visualizzazione
  const displayDate = formatDateForDisplay(date);
  
  // Genera l'HTML della griglia
  let html = `
    <div class="grid-header">Disponibilità del ${displayDate}</div>
    <div class="grid-content">
      <table>
        <thead>
          <tr>
            <th>Orario</th>
  `;
  
  // Intestazioni colonne per ogni campo
  courts.forEach(court => {
    html += `<th>${court}</th>`;
  });
  
  html += `
          </tr>
        </thead>
        <tbody>
  `;
  
  // Riga per ogni slot orario
  timeSlots.forEach(timeSlot => {
    html += `
      <tr>
        <td class="time-cell">${timeSlot}</td>
    `;
    
    // Colonna per ogni campo
    courts.forEach(court => {
      // Verifica se c'è sovrapposizione con prenotazioni esistenti
      const hasOverlap = checkTimeOverlap(dateBookings, date, court, timeSlot);
      
      const cellClass = hasOverlap ? "booked-cell" : "available-cell";
      const cellText = hasOverlap ? "Occupato" : "Disponibile";
      
      html += `
        <td class="${cellClass}" data-time="${timeSlot}" data-court="${court}">
          ${cellText}
        </td>
      `;
    });
    
    html += `</tr>`;
  });
  
  html += `
        </tbody>
      </table>
    </div>
  `;
  
  return html;
}

/**
 * Funzione per pubblicare l'app come webapp
 * Esegui questa funzione una volta per configurare l'app
 */
function setupWebApp() {
  // Questo mostra un URL nella console di log
  // che potrai utilizzare per accedere all'applicazione web
  Logger.log(ScriptApp.getService().getUrl());
}
