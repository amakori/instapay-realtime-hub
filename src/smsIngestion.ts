import { inMemoryStore, supabase } from './supabaseClient';

export interface ParsedSmsResult {
  transactionId: string;
  amount: number;
  recipientOrAgent: string;
  fee: number;
  newBalance: number;
  type: 'SEND_MONEY' | 'GET_CASH' | 'UNKNOWN';
  rawText: string;
  matchedLoanId?: string;
  verified: boolean;
}

export function parseAirtelMoneySms(rawText: string): ParsedSmsResult {
  const clean = rawText.trim();
  let transactionId = 'UNKNOWN';
  let amount = 0;
  let recipientOrAgent = '';
  let fee = 0;
  let newBalance = inMemoryStore.gateway.balance;
  let type: 'SEND_MONEY' | 'GET_CASH' | 'UNKNOWN' = 'UNKNOWN';

  // 1. Transaction ID extraction
  // Matches: "Trans. ID: TXN...", "Txn Id: ...", "Trans ID: ..."
  const txnMatch = clean.match(/(?:Trans\.?\s*ID|Txn\s*ID|Transaction\s*ID)[:\s]+([A-Za-z0-9._-]+)/i);
  if (txnMatch && txnMatch[1]) {
    transactionId = txnMatch[1].replace(/\.$/, '');
  }

  // 2. Send Money Pattern:
  // "You have sent ZMW 150.00 to BRIAN BANDA 0978112233..."
  const sendMoneyMatch = clean.match(/sent\s+ZMW\s*([0-9.,]+)\s+to\s+([A-Za-z0-9\s]+?)(?:\s+on|\.\s*Fee|,\s*Fee|\.|\n|$)/i);
  if (sendMoneyMatch) {
    type = 'SEND_MONEY';
    amount = parseFloat(sendMoneyMatch[1].replace(/,/g, ''));
    recipientOrAgent = sendMoneyMatch[2].trim();
  }

  // 3. Get Cash / Withdraw Pattern:
  // "You have withdrawn ZMW 500.00 from 492109 BWALYA KABWE..."
  const withdrawMatch = clean.match(/withdrawn\s+ZMW\s*([0-9.,]+)\s+from\s+([A-Za-z0-9\s]+?)(?:\s+on|\.\s*Fee|,\s*Fee|\.|\n|$)/i);
  if (withdrawMatch) {
    type = 'GET_CASH';
    amount = parseFloat(withdrawMatch[1].replace(/,/g, ''));
    recipientOrAgent = withdrawMatch[2].trim();
  }

  // 4. Fee extraction:
  // "Fee: ZMW 3.50", "transaction fee ZMW 12.50"
  const feeMatch = clean.match(/(?:Fee|fee)[:\s]+ZMW\s*([0-9.,]+)/i);
  if (feeMatch) {
    fee = parseFloat(feeMatch[1].replace(/,/g, ''));
  }

  // 5. New Balance extraction:
  // "New balance: ZMW 8450.00", "Balance: ZMW 8450.00"
  const balanceMatch = clean.match(/(?:New\s+balance|Balance|Bal)[:\s]+ZMW\s*([0-9.,]+)/i);
  if (balanceMatch) {
    newBalance = parseFloat(balanceMatch[1].replace(/,/g, ''));
  }

  return {
    transactionId,
    amount,
    recipientOrAgent,
    fee,
    newBalance,
    type,
    rawText: clean,
    verified: transactionId !== 'UNKNOWN' && amount > 0
  };
}

export async function processIncomingCarrierSms(rawSms: string, gatewayId = 'gateway-airtel-01') {
  const parsed = parseAirtelMoneySms(rawSms);

  // Update Gateway balance if reported by telco SMS
  if (parsed.newBalance > 0) {
    inMemoryStore.gateway.balance = parsed.newBalance;
    inMemoryStore.gateway.last_heartbeat = new Date().toISOString();
    try {
      await supabase.from('gateway_devices').update({
        balance: parsed.newBalance,
        last_heartbeat: new Date().toISOString()
      }).eq('id', gatewayId);
    } catch (e) {}
  }

  // Try to match pending loan awaiting SMS
  let matchedLoan: any = null;
  for (const [loanId, loan] of inMemoryStore.loans.entries()) {
    if (loan.status === 'PIN_ENTERED' || loan.status === 'AWAITING_SMS' || loan.status === 'USSD_IN_PROGRESS') {
      if (Math.abs(loan.amount - parsed.amount) < 0.01) {
        matchedLoan = loan;
        parsed.matchedLoanId = loanId;
        break;
      }
    }
  }

  if (matchedLoan) {
    matchedLoan.status = 'COMPLETED';
    matchedLoan.carrier_sms_reference = parsed.transactionId;
    matchedLoan.carrier_sms_text = parsed.rawText;
    matchedLoan.fee_amount = parsed.fee;
    matchedLoan.updated_at = new Date().toISOString();

    // Update borrower records
    const borrower = inMemoryStore.borrowers.find(b => b.phone_number === matchedLoan.borrower_phone);
    if (borrower) {
      borrower.current_outstanding += matchedLoan.amount;
      borrower.daily_borrowed_today += matchedLoan.amount;
    }

    try {
      await supabase.from('instapay_loans').update({
        status: 'COMPLETED',
        carrier_sms_reference: parsed.transactionId,
        carrier_sms_text: parsed.rawText,
        fee_amount: parsed.fee,
        updated_at: new Date().toISOString()
      }).eq('id', matchedLoan.id);
    } catch (e) {}
  }

  // Record in SMS Log
  const logEntry = {
    id: `sms-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
    gateway_device_id: gatewayId,
    sender: 'AirtelMoney',
    raw_sms: parsed.rawText,
    parsed_transaction_id: parsed.transactionId,
    parsed_amount: parsed.amount,
    parsed_recipient_or_agent: parsed.recipientOrAgent,
    parsed_balance_after: parsed.newBalance,
    matched_loan_id: parsed.matchedLoanId || null,
    verified: parsed.verified,
    created_at: new Date().toISOString()
  };

  inMemoryStore.smsLogs.unshift(logEntry);

  try {
    await supabase.from('carrier_sms_logs').insert(logEntry);
  } catch (e) {}

  return { parsed, matchedLoan, logEntry };
}
