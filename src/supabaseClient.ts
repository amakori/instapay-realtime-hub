import { createClient, SupabaseClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';

dotenv.config();

export const SUPABASE_URL = process.env.SUPABASE_URL || 'https://wspdjsoukzbinyvptqkv.supabase.co';
export const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6IndzcGRqc291a3piaW55dnB0cWt2Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTM5NTEwMDAsImV4cCI6MjA2OTUyNzAwMH0.0WpPdoSDnL-DtEUWbpwj1pB8XBcSgSSL-XC4bno1qfY';

export let supabase: SupabaseClient;
export const supabaseAdmin = process.env.SUPABASE_SERVICE_ROLE_KEY
  ? createClient(SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false }
    })
  : null;

try {
  supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: { persistSession: false },
    realtime: { params: { eventsPerSecond: 10 } }
  });
  console.log('[Supabase] Initialized client for:', SUPABASE_URL);
} catch (err) {
  console.error('[Supabase] Failed to initialize client:', err);
}

// In-Memory Database store for ultra-reliable zero-latency sync & offline simulation
export const inMemoryStore = {
  settings: {
    id: 'default',
    mfi_name: 'Trustea Microfinance Partner',
    max_single_loan: 3500.00,
    min_single_loan: 10.00,
    daily_borrower_limit: 5000.00,
    daily_total_dispense_limit: 50000.00,
    government_max_loan_limit: 10000.00,
    government_interest_cap_pct: 15.00,
    gateway_min_reserve_buffer: 50.00,
    auto_approval_enabled: true,
    emergency_freeze_dispensing: false
  },
  gateway: {
    id: 'gateway-airtel-01',
    device_name: 'Instapay Airtel Gateway (Alpha)',
    phone_number: '+260977632373',
    carrier: 'Airtel Money',
    balance: 8450.00,
    status: 'idle', // 'idle' | 'busy' | 'offline'
    battery_level: 96,
    pin_configured: true,
    last_heartbeat: new Date().toISOString()
  },
  borrowers: [
    {
      id: 'a1111111-1111-1111-1111-111111111111',
      full_name: 'Mwamba Chileshe',
      phone_number: '0978587412',
      nrc_number: '348912/11/1',
      credit_limit: 2500.00,
      current_outstanding: 150.00,
      daily_borrowed_today: 150.00,
      status: 'active'
    },
    {
      id: 'a2222222-2222-2222-2222-222222222222',
      full_name: 'Natasha Tembo',
      phone_number: '0977123456',
      nrc_number: '512398/10/1',
      credit_limit: 4000.00,
      current_outstanding: 0.00,
      daily_borrowed_today: 0.00,
      status: 'active'
    },
    {
      id: 'a3333333-3333-3333-3333-333333333333',
      full_name: 'Kondwani Phiri',
      phone_number: '0971987654',
      nrc_number: '109823/52/1',
      credit_limit: 1000.00,
      current_outstanding: 950.00,
      daily_borrowed_today: 950.00,
      status: 'active'
    }
  ],
  loans: new Map<string, any>(),
  ussdSessions: new Map<string, any>(),
  smsLogs: [] as any[]
};
