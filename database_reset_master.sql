-- NPLVision Master Database Reset Script
-- This script drops all existing tables and re-creates the complete schema from scratch.
-- It is the single source of truth for the database structure.

-- Step 1: Drop all tables in an order that respects dependencies, using CASCADE for safety.
DROP TABLE IF EXISTS collateral_documents CASCADE;
DROP TABLE IF EXISTS property_data_history CASCADE;
DROP TABLE IF EXISTS property_data_current CASCADE;
DROP TABLE IF EXISTS foreclosure_milestone_statuses CASCADE;
DROP TABLE IF EXISTS foreclosure_events_history CASCADE;
DROP TABLE IF EXISTS foreclosure_events CASCADE;
DROP TABLE IF EXISTS daily_metrics_history CASCADE;
DROP TABLE IF EXISTS daily_metrics_current CASCADE;
DROP TABLE IF EXISTS upload_sessions CASCADE;
DROP TABLE IF EXISTS users CASCADE;
DROP TABLE IF EXISTS loans CASCADE; -- Legacy table
DROP TABLE IF EXISTS enrichments CASCADE; -- Legacy table
DROP TABLE IF EXISTS llm_queries CASCADE; -- Legacy table
DROP TYPE IF EXISTS user_role CASCADE;

-- Step 2: Create user role type and users table.
CREATE TYPE user_role AS ENUM ('super_user', 'admin', 'manager', 'user');

CREATE TABLE users (
    id SERIAL PRIMARY KEY,
    email TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    first_name TEXT,
    last_name TEXT,
    role user_role NOT NULL DEFAULT 'user',
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Step 3: Create the table for tracking upload sessions.
CREATE TABLE upload_sessions (
    id UUID PRIMARY KEY,
    original_filename TEXT,
    file_type TEXT,
    record_count INTEGER,
    status TEXT NOT NULL DEFAULT 'processing',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Step 4: Create the primary 'current state' table for daily metrics.
CREATE TABLE daily_metrics_current (
    loan_id TEXT PRIMARY KEY,
    investor_name TEXT,
    first_name TEXT,
    last_name TEXT,
    address TEXT,
    city TEXT,
    state TEXT,
    zip TEXT,
    prin_bal NUMERIC(15, 2),
    int_rate NUMERIC(8, 6),
    next_pymt_due DATE,
    last_pymt_received DATE,
    loan_type TEXT, -- Also known as Asset Status
    legal_status TEXT,
    lien_pos TEXT,
    maturity_date DATE,
    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now()
);

-- Step 5: Create the history table for daily metrics.
CREATE TABLE daily_metrics_history (
    id SERIAL PRIMARY KEY,
    loan_id TEXT NOT NULL,
    report_date DATE NOT NULL,
    investor_name TEXT,
    first_name TEXT,
    last_name TEXT,
    address TEXT,
    city TEXT,
    state TEXT,
    zip TEXT,
    prin_bal NUMERIC(15, 2),
    int_rate NUMERIC(8, 6),
    next_pymt_due DATE,
    last_pymt_received DATE,
    loan_type TEXT,
    legal_status TEXT,
    lien_pos TEXT,
    maturity_date DATE,
    created_at TIMESTAMPTZ DEFAULT now(),
    UNIQUE(loan_id, report_date)
);

-- Step 6: Create the 'current state' table for foreclosure events.
CREATE TABLE foreclosure_events (
    id SERIAL PRIMARY KEY,
    loan_id TEXT NOT NULL UNIQUE,
    fc_status TEXT,
    fc_jurisdiction TEXT,
    fc_start_date DATE,
    -- Actual Milestone Dates
    referral_date DATE,
    title_ordered_date DATE,
    title_received_date DATE,
    complaint_filed_date DATE,
    service_completed_date DATE,
    judgment_date DATE,
    sale_scheduled_date DATE,
    sale_held_date DATE,
    -- Expected Milestone Dates (Calculated on Ingest)
    referral_expected_completion_date DATE,
    title_ordered_expected_completion_date DATE,
    title_received_expected_completion_date DATE,
    complaint_filed_expected_completion_date DATE,
    service_completed_expected_completion_date DATE,
    judgment_expected_completion_date DATE,
    sale_scheduled_expected_completion_date DATE,
    sale_held_expected_completion_date DATE,
    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now()
);

-- Step 7: Create the history table for foreclosure events.
CREATE TABLE foreclosure_events_history (
    id SERIAL PRIMARY KEY,
    loan_id TEXT NOT NULL,
    report_date DATE NOT NULL,
    fc_status TEXT,
    fc_jurisdiction TEXT,
    fc_start_date DATE,
    referral_date DATE,
    title_ordered_date DATE,
    title_received_date DATE,
    complaint_filed_date DATE,
    service_completed_date DATE,
    judgment_date DATE,
    sale_scheduled_date DATE,
    sale_held_date DATE,
    referral_expected_completion_date DATE,
    title_ordered_expected_completion_date DATE,
    title_received_expected_completion_date DATE,
    complaint_filed_expected_completion_date DATE,
    service_completed_expected_completion_date DATE,
    judgment_expected_completion_date DATE,
    sale_scheduled_expected_completion_date DATE,
    sale_held_expected_completion_date DATE,
    created_at TIMESTAMPTZ DEFAULT now(),
    UNIQUE(loan_id, report_date)
);

-- Step 8: Create helper function and triggers for updated_at timestamps.
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$$ language 'plpgsql';

CREATE TRIGGER update_users_updated_at BEFORE UPDATE
    ON users FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_daily_metrics_current_updated_at BEFORE UPDATE
    ON daily_metrics_current FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_foreclosure_events_updated_at BEFORE UPDATE
    ON foreclosure_events FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- Step 9: Create property data tables.
CREATE TABLE property_data_current (
    loan_id TEXT PRIMARY KEY,
    source TEXT,
    property_data JSONB,
    last_updated TIMESTAMPTZ DEFAULT now(),
    CONSTRAINT fk_loan
        FOREIGN KEY(loan_id)
        REFERENCES daily_metrics_current(loan_id)
        ON DELETE CASCADE
);

CREATE TABLE property_data_history (
    id SERIAL PRIMARY KEY,
    loan_id TEXT NOT NULL,
    source TEXT,
    property_data JSONB,
    enrichment_date TIMESTAMPTZ DEFAULT now(),
    CONSTRAINT fk_loan
        FOREIGN KEY(loan_id)
        REFERENCES daily_metrics_current(loan_id)
        ON DELETE CASCADE
);

-- Step 10: Create indexes for performance.
CREATE INDEX idx_daily_metrics_current_loan_id ON daily_metrics_current(loan_id);
CREATE INDEX idx_daily_metrics_current_state ON daily_metrics_current(state);
CREATE INDEX idx_daily_metrics_current_loan_type ON daily_metrics_current(loan_type);
CREATE INDEX idx_daily_metrics_history_loan_id ON daily_metrics_history(loan_id);
CREATE INDEX idx_foreclosure_events_loan_id ON foreclosure_events(loan_id);
CREATE INDEX idx_foreclosure_events_history_loan_id ON foreclosure_events_history(loan_id);
CREATE INDEX idx_property_data_current_loan_id ON property_data_current(loan_id);
CREATE INDEX idx_property_data_current_source ON property_data_current(source);
CREATE INDEX idx_property_data_history_loan_id ON property_data_history(loan_id);
CREATE INDEX idx_property_data_history_enrichment_date ON property_data_history(enrichment_date);
CREATE INDEX idx_property_data_history_source ON property_data_history(source);

-- Step 11: Create collateral documents table.
CREATE TABLE collateral_documents (
    id SERIAL PRIMARY KEY,
    loan_id TEXT NOT NULL,
    user_id INTEGER,
    file_name TEXT NOT NULL,
    file_size INTEGER, -- Ensure this line is present
    storage_path TEXT NOT NULL, -- Path in cloud storage bucket
    document_type TEXT, -- Label predicted by Python model
    page_count INTEGER,
    is_validated BOOLEAN DEFAULT FALSE,
    uploaded_at TIMESTAMPTZ DEFAULT NOW(),
    CONSTRAINT fk_loan
        FOREIGN KEY(loan_id)
        REFERENCES daily_metrics_current(loan_id)
        ON DELETE CASCADE,
    CONSTRAINT fk_user
        FOREIGN KEY(user_id)
        REFERENCES users(id)
        ON DELETE SET NULL
);

-- Step 12: Create indexes for collateral documents.
CREATE INDEX idx_collateral_documents_loan_id ON collateral_documents(loan_id);
CREATE INDEX idx_collateral_documents_document_type ON collateral_documents(document_type);
CREATE INDEX idx_collateral_documents_uploaded_at ON collateral_documents(uploaded_at);

-- Step 13: Create document analysis tables for OCR-based processing
CREATE TABLE document_analysis (
    id SERIAL PRIMARY KEY,
    loan_id TEXT NOT NULL,
    file_name TEXT NOT NULL,
    document_type TEXT NOT NULL,
    confidence_score NUMERIC(5,4) NOT NULL,
    property_street TEXT,
    property_city TEXT,
    property_state TEXT,
    property_zip TEXT,
    borrower_name TEXT,
    co_borrower_name TEXT,
    loan_amount NUMERIC(15,2),
    origination_date DATE,
    lender_name TEXT,
    assignor TEXT,
    assignee TEXT,
    assignment_date DATE,
    recording_date DATE,
    instrument_number TEXT,
    ocr_text_blob TEXT,
    extraction_metadata JSONB,
    processing_time_ms INTEGER,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    CONSTRAINT fk_loan
        FOREIGN KEY(loan_id)
        REFERENCES daily_metrics_current(loan_id)
        ON DELETE CASCADE
);

CREATE TABLE document_analysis_qa_flags (
    id SERIAL PRIMARY KEY,
    document_analysis_id INTEGER NOT NULL,
    field_name TEXT NOT NULL,
    field_value TEXT,
    confidence_score NUMERIC(5,4) NOT NULL,
    flag_reason TEXT,
    reviewed BOOLEAN DEFAULT FALSE,
    reviewed_at TIMESTAMPTZ,
    reviewed_by TEXT,
    CONSTRAINT fk_document_analysis
        FOREIGN KEY(document_analysis_id)
        REFERENCES document_analysis(id)
        ON DELETE CASCADE
);

CREATE TABLE document_classification_feedback (
    id SERIAL PRIMARY KEY,
    document_analysis_id INTEGER NOT NULL,
    predicted_type TEXT NOT NULL,
    correct_type TEXT,
    feedback_date TIMESTAMPTZ DEFAULT NOW(),
    CONSTRAINT fk_document_analysis_feedback
        FOREIGN KEY(document_analysis_id)
        REFERENCES document_analysis(id)
        ON DELETE CASCADE
);

-- Step 14: Create indexes for document analysis
CREATE INDEX idx_document_analysis_loan_id ON document_analysis(loan_id);
CREATE INDEX idx_document_analysis_document_type ON document_analysis(document_type);
CREATE INDEX idx_document_analysis_created_at ON document_analysis(created_at);
CREATE INDEX idx_document_analysis_confidence ON document_analysis(confidence_score);

-- Comments for documentation
COMMENT ON TABLE property_data_current IS 'Current property enrichment data - one row per loan (most recent)';
COMMENT ON TABLE property_data_history IS 'Historical property enrichment data - all enrichment events';
COMMENT ON TABLE collateral_documents IS 'Legacy: Simple PDF upload tracking (replaced by document_analysis)';
COMMENT ON TABLE document_analysis IS 'OCR-based document analysis with ML classification and field extraction';
COMMENT ON TABLE document_analysis_qa_flags IS 'Low-confidence fields flagged for quality assurance review';
COMMENT ON TABLE document_classification_feedback IS 'User feedback for improving ML document classification';
COMMENT ON COLUMN property_data_current.source IS 'Source of the property data (e.g., PropertyData/HomeHarvest)';
COMMENT ON COLUMN property_data_current.property_data IS 'JSON data containing property details from enrichment source';
COMMENT ON COLUMN property_data_history.enrichment_date IS 'Timestamp when the enrichment was performed';
COMMENT ON COLUMN collateral_documents.document_type IS 'Document type classified by AI (Note, Mortgage, etc.)';
COMMENT ON COLUMN collateral_documents.storage_path IS 'File path in cloud storage or local filesystem';
COMMENT ON COLUMN document_analysis.ocr_text_blob IS 'Full extracted text from OCR for debugging and reprocessing';
COMMENT ON COLUMN document_analysis.extraction_metadata IS 'JSON metadata including field confidence scores and processing details';