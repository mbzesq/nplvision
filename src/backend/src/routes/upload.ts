import { Router } from 'express';
import multer from 'multer';
import * as XLSX from 'xlsx';
import { v4 as uuidv4 } from 'uuid';
import pool from '../db';
import { detectFileType, FileType } from '../services/fileTypeDetector';
import { authenticateToken } from '../middleware/authMiddleware';
import { 
  mapForeclosureData, 
  mapDailyMetricsData, 
  ForeclosureRecord, 
  DailyMetricsRecord,
  mapDailyMetricsCurrentData,
  mapDailyMetricsHistoryData,
  mapForeclosureEventData,
  ForeclosureEventData,
  cleanCurrency,
  cleanPercentage,
  parseExcelDate,
  getValue
} from '../services/columnMappers';
import { 
  getStateForLoan
} from '../services/foreclosureService';
import { 
  insertDailyMetricsHistory, 
  upsertDailyMetricsCurrent 
} from '../services/currentHistoryService';

const router = Router();
const storage = multer.memoryStorage();
const upload = multer({ storage });

// Helper function to detect actual file format by examining content
function detectActualFileFormat(buffer: Buffer): 'xlsx' | 'csv' {
  const uint8Array = new Uint8Array(buffer);
  // Excel 2007+ (OOXML) files are ZIP archives, which start with 'PK'
  if (uint8Array[0] === 0x50 && uint8Array[1] === 0x4B) {
    return 'xlsx';
  }
  // Excel 97-2003 (CFB) files have a specific signature
  if (uint8Array[0] === 0xD0 && uint8Array[1] === 0xCF) {
    return 'xlsx';
  }
  // If neither signature matches, assume it's a text-based format like CSV.
  return 'csv';
}

// Helper function to extract report date from filename or default to today
function getReportDate(filename: string): string {
  try {
    // Try to extract date from filename patterns like:
    // daily_metrics_2024-01-15.xlsx
    // foreclosure_data_20240115.xlsx
    // metrics-2024.01.15.xlsx
    const datePatterns = [
      /(\d{4}-\d{2}-\d{2})/,           // YYYY-MM-DD
      /(\d{4})(\d{2})(\d{2})/,         // YYYYMMDD
      /(\d{4})\.(\d{2})\.(\d{2})/,     // YYYY.MM.DD
      /(\d{4})_(\d{2})_(\d{2})/        // YYYY_MM_DD
    ];
    
    for (const pattern of datePatterns) {
      const match = filename.match(pattern);
      if (match) {
        if (match.length === 2) {
          // Already in YYYY-MM-DD format
          const date = new Date(match[1]);
          if (!isNaN(date.getTime())) {
            return match[1];
          }
        } else if (match.length === 4) {
          // Year, month, day captured separately
          const dateStr = `${match[1]}-${match[2]}-${match[3]}`;
          const date = new Date(dateStr);
          if (!isNaN(date.getTime())) {
            return dateStr;
          }
        }
      }
    }
  } catch (error) {
    console.warn('Error extracting date from filename:', error);
  }
  
  // Default to today's date
  return new Date().toISOString().split('T')[0];
}

// Helper function to parse CSV data
function parseCsvData(buffer: Buffer): any[] {
  // Handle UTF-8 with BOM
  let csvText = buffer.toString('utf-8');
  // Remove BOM if present
  if (csvText.charCodeAt(0) === 0xFEFF) {
    csvText = csvText.substring(1);
  }
  const lines = csvText.split(/\r?\n/);

  if (lines.length === 0) return [];

  const parseCSVLine = (line: string): string[] => {
    const result: string[] = [];
    let current = '';
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
      const char = line[i];
      const nextChar = line[i + 1];

      if (char === '"') {
        if (inQuotes && nextChar === '"') {
          current += '"';
          i++; 
        } else {
          inQuotes = !inQuotes;
        }
      } else if (char === ',' && !inQuotes) {
        result.push(current.trim());
        current = '';
      } else {
        current += char;
      }
    }
    result.push(current.trim());
    return result;
  };

  let headerIndex = -1;
  let headers: string[] = [];

  // Find the first row that looks like a header (e.g., contains 'Loan ID')
  for (let i = 0; i < Math.min(10, lines.length); i++) {
    if (lines[i].includes('Loan ID') && lines[i].includes('Prin Bal')) {
      headers = parseCSVLine(lines[i]);
      headerIndex = i;
      break;
    }
  }

  if (headerIndex === -1) return []; // No header found

  const records: any[] = [];
  for (let i = headerIndex + 1; i < lines.length; i++) {
    if (lines[i].trim() === '') continue;

    const values = parseCSVLine(lines[i]);
    const record: any = {};
    headers.forEach((header, index) => {
      if (header) {
         record[header] = values[index] || '';
      }
    });

    if (Object.values(record).some(v => v !== '')) {
      records.push(record);
    }
  }
  return records;
}

// --- Database Insertion Functions ---
async function insertForeclosureRecords(records: ForeclosureRecord[]): Promise<number> {
  let insertedCount = 0;
  const insertQuery = `
    INSERT INTO foreclosure_events (
      upload_session_id, file_date, loan_id, investor_id, investor_loan_number,
      fc_atty_poc, fc_atty_poc_phone, fc_atty_poc_email, fc_jurisdiction, fc_status,
      active_fc_days, hold_fc_days, total_fc_days, fc_closed_date, fc_closed_reason,
      contested_start_date, contested_reason, contested_summary, active_loss_mit,
      active_loss_mit_start_date, active_loss_mit_reason, last_note_date, last_note,
      title_received_actual_start, title_received_expected_completion, title_received_actual_completion,
      title_received_delay_reason, first_legal_expected_start, first_legal_actual_start,
      first_legal_expected_completion, first_legal_actual_completion, first_legal_completion_variance,
      first_legal_delay_reason, service_perfected_expected_start, service_perfected_actual_start,
      service_perfected_expected_completion, service_perfected_actual_completion,
      service_perfected_completion_variance, service_perfected_delay_reason,
      publication_started_expected_start, publication_started_actual_start,
      publication_started_expected_completion, publication_started_actual_completion,
      publication_started_completion_variance, publication_started_delay_reason,
      order_of_reference_expected_start, order_of_reference_actual_start,
      order_of_reference_expected_completion, order_of_reference_actual_completion,
      order_of_reference_completion_variance, order_of_reference_delay_reason,
      judgment_entered_expected_start, judgment_entered_actual_start,
      judgment_entered_expected_completion, judgment_entered_actual_completion,
      judgment_entered_completion_variance, judgment_entered_delay_reason,
      redemption_expires_expected_start, redemption_expires_actual_start,
      redemption_expires_expected_completion, redemption_expires_actual_completion,
      redemption_expires_completion_variance, redemption_expires_delay_reason,
      sale_held_expected_start, sale_held_expected_completion, sale_held_actual_completion,
      sale_held_completion_variance, sale_held_delay_reason, rrc_expected_start,
      rrc_actual_start, rrc_expected_completion, rrc_actual_completion,
      rrc_completion_variance, rrc_delay_reason, source_filename, data_issues
    ) VALUES (
      $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20,
      $21, $22, $23, $24, $25, $26, $27, $28, $29, $30, $31, $32, $33, $34, $35, $36, $37, $38, $39,
      $40, $41, $42, $43, $44, $45, $46, $47, $48, $49, $50, $51, $52, $53, $54, $55, $56, $57, $58,
      $59, $60, $61, $62, $63, $64, $65, $66, $67, $68, $69, $70, $71, $72, $73
    )
  `;

  for (const record of records) {
    try {
      const values = [
        record.upload_session_id, record.file_date, record.loan_id, record.investor_id, record.investor_loan_number,
        record.fc_atty_poc, record.fc_atty_poc_phone, record.fc_atty_poc_email, record.fc_jurisdiction, record.fc_status,
        record.active_fc_days, record.hold_fc_days, record.total_fc_days, record.fc_closed_date, record.fc_closed_reason,
        record.contested_start_date, record.contested_reason, record.contested_summary, record.active_loss_mit,
        record.active_loss_mit_start_date, record.active_loss_mit_reason, record.last_note_date, record.last_note,
        record.title_received_actual_start, record.title_received_expected_completion, record.title_received_actual_completion,
        record.title_received_delay_reason, record.first_legal_expected_start, record.first_legal_actual_start,
        record.first_legal_expected_completion, record.first_legal_actual_completion, record.first_legal_completion_variance,
        record.first_legal_delay_reason, record.service_perfected_expected_start, record.service_perfected_actual_start,
        record.service_perfected_expected_completion, record.service_perfected_actual_completion,
        record.service_perfected_completion_variance, record.service_perfected_delay_reason,
        record.publication_started_expected_start, record.publication_started_actual_start,
        record.publication_started_expected_completion, record.publication_started_actual_completion,
        record.publication_started_completion_variance, record.publication_started_delay_reason,
        record.order_of_reference_expected_start, record.order_of_reference_actual_start,
        record.order_of_reference_expected_completion, record.order_of_reference_actual_completion,
        record.order_of_reference_completion_variance, record.order_of_reference_delay_reason,
        record.judgment_entered_expected_start, record.judgment_entered_actual_start,
        record.judgment_entered_expected_completion, record.judgment_entered_actual_completion,
        record.judgment_entered_completion_variance, record.judgment_entered_delay_reason,
        record.redemption_expires_expected_start, record.redemption_expires_actual_start,
        record.redemption_expires_expected_completion, record.redemption_expires_actual_completion,
        record.redemption_expires_completion_variance, record.redemption_expires_delay_reason,
        record.sale_held_expected_start, record.sale_held_expected_completion, record.sale_held_actual_completion,
        record.sale_held_completion_variance, record.sale_held_delay_reason, record.rrc_expected_start,
        record.rrc_actual_start, record.rrc_expected_completion, record.rrc_actual_completion,
        record.rrc_completion_variance, record.rrc_delay_reason, record.source_filename, record.data_issues
      ];

      await pool.query(insertQuery, values);
      insertedCount++;
    } catch (error) {
      console.error('Error inserting foreclosure record:', error, 'Record data:', record);
    }
  }

  return insertedCount;
}

async function insertDailyMetricsRecords(records: DailyMetricsRecord[]): Promise<number> {
  let insertedCount = 0;
  const insertQuery = `
    INSERT INTO daily_metrics (
      upload_session_id, loan_id, investor, investor_name, inv_loan, first_name, last_name,
      address, city, state, zip, prin_bal, unapplied_bal, int_rate, pi_pmt, remg_term,
      origination_date, org_term, org_amount, lien_pos, next_pymt_due, last_pymt_received,
      first_pymt_due, maturity_date, loan_type, legal_status, warning, pymt_method, draft_day,
      spoc, jan_25, feb_25, mar_25, apr_25, may_25, jun_25, jul_25, aug_25, sep_25, oct_25,
      nov_25, dec_25, source_filename, data_issues
    ) VALUES (
      $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20,
      $21, $22, $23, $24, $25, $26, $27, $28, $29, $30, $31, $32, $33, $34, $35, $36, $37, $38, $39,
      $40, $41, $42, $43, $44
    )
  `;

  for (const record of records) {
    try {
      const values = [
        record.upload_session_id, record.loan_id, record.investor, record.investor_name, record.inv_loan,
        record.first_name, record.last_name, record.address, record.city, record.state, record.zip,
        record.prin_bal, record.unapplied_bal, record.int_rate, record.pi_pmt, record.remg_term,
        record.origination_date, record.org_term, record.org_amount, record.lien_pos, record.next_pymt_due,
        record.last_pymt_received, record.first_pymt_due, record.maturity_date, record.loan_type,
        record.legal_status, record.warning, record.pymt_method, record.draft_day, record.spoc,
        record.jan_25, record.feb_25, record.mar_25, record.apr_25, record.may_25, record.jun_25,
        record.jul_25, record.aug_25, record.sep_25, record.oct_25, record.nov_25, record.dec_25,
        record.source_filename, record.data_issues
      ];

      await pool.query(insertQuery, values);
      insertedCount++;
    } catch (error) {
      console.error('Error inserting daily metrics record:', error, 'Record data:', record);
    }
  }

  return insertedCount;
}

// --- Main Upload Endpoint ---
router.post('/upload', authenticateToken, upload.single('loanFile'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No file uploaded' });
  }

  try {
    // Parse file based on actual content, not extension
    let jsonData: any[];
    const fileExtension = req.file.originalname.toLowerCase();
    const actualFormat = detectActualFileFormat(req.file.buffer);

    console.log(`[Upload] File extension: .${fileExtension.split('.').pop()}, Actual format detected: ${actualFormat}`);

    if (actualFormat === 'xlsx') {
      const workbook = XLSX.read(req.file.buffer, { type: 'buffer' });
      const sheetName = workbook.SheetNames[0];
      const sheet = workbook.Sheets[sheetName];
      jsonData = XLSX.utils.sheet_to_json(sheet, { defval: '' });
    } else {
      // It's either a real CSV or an XLSX-named CSV. Parse as CSV.
      jsonData = parseCsvData(req.file.buffer);
    }

    if (jsonData.length === 0) {
      return res.status(400).json({ error: 'No data found in the uploaded file.' });
    }

    // Detect file type based on headers
    const headers = Object.keys(jsonData[0] as any);
    const detection = detectFileType(headers);

    console.log(`File type detected: ${detection.fileType} (${detection.confidence.toFixed(1)}% confidence)`);
    console.log(`Matched headers: ${detection.matchedHeaders.join(', ')}`);

    if (detection.fileType === 'unknown') {
      return res.status(400).json({ 
        error: 'Unable to identify file type. Please ensure your file contains the expected column headers.',
        details: {
          detectedConfidence: detection.confidence,
          supportedTypes: ['foreclosure_data', 'daily_metrics']
        }
      });
    }

    const uploadSessionId = uuidv4();
    await pool.query(
      `INSERT INTO upload_sessions (id, original_filename, file_type, record_count, status)
       VALUES ($1, $2, $3, $4, $5)`,
      [uploadSessionId, req.file.originalname, detection.fileType, jsonData.length, 'processing']
    );

    let insertedCount = 0;
    let skippedCount = 0;
    let errorCount = 0;
    let errorDetails: string[] = [];
    let successMessage = '';

    // Extract report date from filename or default to today  
    const reportDate = getReportDate(req.file.originalname);
    console.log(`Processing ${detection.fileType} upload with report date: ${reportDate}`);

    if (detection.fileType === 'foreclosure_data') {
      // Process foreclosure records with enhanced logic for multiple entries per loan
      console.log(`Starting foreclosure data processing for ${jsonData.length} records`);
      
      // Step 1: Filter and group foreclosure records
      const validForeclosureRecords: any[] = [];
      const loanGroups: { [loanId: string]: any[] } = {};
      
      for (let i = 0; i < jsonData.length; i++) {
        const row = jsonData[i];
        
        // Dynamic header lookup
        const loanId = getValue(row, ['Loan ID', 'loan_id']);
        const fcJurisdiction = getValue(row, ['FC Jurisdiction', 'fc_jurisdiction']);
        
        if (!loanId) {
          console.warn(`Row ${i + 1}: Skipping foreclosure record with missing loan_id`);
          skippedCount++;
          continue;
        }
        
        // Filter out bankruptcy rows - only process Judicial and NonJudicial
        if (!fcJurisdiction || 
            (!fcJurisdiction.toLowerCase().includes('judicial') && 
             !fcJurisdiction.toLowerCase().includes('nonjudicial'))) {
          console.log(`Row ${i + 1}: Skipping non-foreclosure record with jurisdiction: ${fcJurisdiction}`);
          skippedCount++;
          continue;
        }
        
        validForeclosureRecords.push({ ...row, _rowIndex: i + 1 });
        
        // Group by loan ID
        if (!loanGroups[loanId]) {
          loanGroups[loanId] = [];
        }
        loanGroups[loanId].push({ ...row, _rowIndex: i + 1 });
      }
      
      console.log(`Filtered ${validForeclosureRecords.length} valid foreclosure records from ${jsonData.length} total rows`);
      console.log(`Found ${Object.keys(loanGroups).length} unique loans with foreclosure data`);
      
      // Step 2: Process each loan group
      for (const [loanId, loanRecords] of Object.entries(loanGroups)) {
        try {
          // Insert all records into history table
          for (const record of loanRecords) {
            try {
              const { insertForeclosureEventsHistory, createForeclosureHistoryRecord } = await import('../services/currentHistoryService');
              const eventData = mapForeclosureEventData(record);
              const historyRecord = createForeclosureHistoryRecord(eventData, reportDate);
              await insertForeclosureEventsHistory(historyRecord);
            } catch (error) {
              console.error(`Error inserting history record for loan ${loanId}, row ${record._rowIndex}:`, error);
              errorCount++;
            }
          }
          
          // Step 3: Determine active foreclosure (FC Closed Date is blank/null)
          const activeRecord = loanRecords.find(record => {
            const fcClosedDate = getValue(record, ['FC Closed Date', 'fc_closed_date']);
            return !fcClosedDate || fcClosedDate.toString().trim() === '';
          });
          
          if (activeRecord) {
            try {
              // Use the new, correct functions
              const eventData = mapForeclosureEventData(activeRecord);
              
              // Upsert foreclosure event data into foreclosure_events table
              const upsertQuery = `
                INSERT INTO foreclosure_events (
                  loan_id, fc_jurisdiction, fc_status, fc_start_date, fc_closed_date, 
                  fc_closed_reason, active_fc_days, hold_fc_days, total_fc_days
                ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
                ON CONFLICT (loan_id) DO UPDATE SET
                  fc_jurisdiction = EXCLUDED.fc_jurisdiction,
                  fc_status = EXCLUDED.fc_status,
                  fc_start_date = EXCLUDED.fc_start_date,
                  fc_closed_date = EXCLUDED.fc_closed_date,
                  fc_closed_reason = EXCLUDED.fc_closed_reason,
                  active_fc_days = EXCLUDED.active_fc_days,
                  hold_fc_days = EXCLUDED.hold_fc_days,
                  total_fc_days = EXCLUDED.total_fc_days,
                  updated_at = now()
              `;
              
              await pool.query(upsertQuery, [
                eventData.loan_id,
                eventData.fc_jurisdiction,
                eventData.fc_status,
                eventData.fc_start_date,
                eventData.fc_closed_date,
                eventData.fc_closed_reason,
                eventData.active_fc_days,
                eventData.hold_fc_days,
                eventData.total_fc_days
              ]);

              const state = await getStateForLoan(eventData.loan_id);
              if (state) {
                console.log(`Processing foreclosure milestones for loan ${eventData.loan_id} in state ${state}`);
                // Milestone processing would go here if needed
              }

              console.log(`Processed active foreclosure for loan ${loanId}`);
            } catch (error) {
              console.error(`Error processing active foreclosure for loan ${loanId}:`, error);
              errorCount++;
            }
          } else {
            console.log(`No active foreclosure found for loan ${loanId} (all have closed dates)`);
          }
          
          insertedCount++;
          
          if (insertedCount % 50 === 0) {
            console.log(`Processed ${insertedCount} loan foreclosure groups...`);
          }
        } catch (error) {
          errorCount++;
          console.error(`Error processing foreclosure group for loan ${loanId}:`, error);
        }
      }
      
      console.log(`Foreclosure processing complete: ${insertedCount} loan groups processed, ${skippedCount} rows skipped, ${errorCount} errors`);
      successMessage = `Successfully processed ${insertedCount} loans with foreclosure data (${validForeclosureRecords.length} total records, ${skippedCount} skipped, ${errorCount} errors).`;
    } 
    else if (detection.fileType === 'daily_metrics') {
      // Process daily metrics with current/history schema
      console.log(`Starting daily metrics processing for ${jsonData.length} records`);
      
      for (let i = 0; i < jsonData.length; i++) {
        const row = jsonData[i];
        try {
          // Map the data using new structure
          const historyRecord = mapDailyMetricsHistoryData(row, reportDate);
          const currentRecord = mapDailyMetricsCurrentData(row, reportDate);
          
          // Validate required fields
          if (!historyRecord.loan_id) {
            console.warn(`Row ${i + 1}: Skipping daily metrics record with missing loan_id`);
            skippedCount++;
            continue;
          }
          
          // Insert into history table (idempotent with ON CONFLICT)
          await insertDailyMetricsHistory(historyRecord);
          
          // Upsert into current table (idempotent by design)
          await upsertDailyMetricsCurrent(currentRecord);
          
          insertedCount++;
          
          if (insertedCount % 100 === 0) {
            console.log(`Processed ${insertedCount} daily metrics records...`);
          }
        } catch (error) {
          errorCount++;
          console.error(`Row ${i + 1}: Error processing daily metrics record for loan ${getValue(row, ['Loan ID'])}:`, error);
          // Capture the first 5 error messages to avoid overwhelming the response
          if (errorCount <= 5 && error instanceof Error) {
            errorDetails.push(`Row ${i + 1}: ${error.message}`);
          }
          // Continue processing other records even if one fails
        }
      }
      
      console.log(`Daily metrics processing complete: ${insertedCount} inserted, ${skippedCount} skipped, ${errorCount} errors`);
      successMessage = `Successfully imported ${insertedCount} of ${jsonData.length} daily metrics records (${skippedCount} skipped, ${errorCount} errors).`;
    }

    // Update upload session with final status
    const finalStatus = errorCount > 0 ? 'completed_with_errors' : 'completed';
    await pool.query(
      `UPDATE upload_sessions SET status = $1 WHERE id = $2`,
      [finalStatus, uploadSessionId]
    );

    res.json({
      status: 'success',
      message: successMessage,
      fileType: detection.fileType,
      confidence: detection.confidence,
      record_count: insertedCount,
      skipped_count: skippedCount || 0,
      error_count: errorCount || 0,
      total_records: jsonData.length,
      report_date: reportDate,
      upload_session_id: uploadSessionId,
      errors: errorDetails
    });

  } catch (error) {
    console.error('Error processing file:', error);
    res.status(500).json({ error: 'Failed to process file' });
  }
});

export default router;